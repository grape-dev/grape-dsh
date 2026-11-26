# grape-dsh 插件配置 UI 设计（方案 A）

> 状态：设计待评审（未开始编码）
> 定位：用 dsh 内置的插件配置系统，在左侧边栏 Plugins 页的插件详情页里，用可视化表单配置 Grape 地址 + API Key
> 已定决策：方案 A（dsh 内置配置页，不走右侧边栏自定义 Tab）

---

## 一、目标

用户不再需要手动编辑 `/etc/grape-dsh/grape.env` 并重启 dsh。改成：

1. 在 dsh 左侧边栏 → **Plugins** 页看到 `@grape-dev/grape-dsh`
2. 点进插件详情页 → 看到配置表单
3. 填 Grape 地址 + API Key → 保存
4. 立即生效（无需重启）

API Key 字段显示"已配置/未配置"状态，可替换但读不回明文。

## 二、dsh 内置配置机制（已核实）

### 2.1 核心包

**`@deepseek-ai/dsh-settings`**（dsh 基础包，已在 dsh-base 的 patch 里挂载）：

> "Inspect and edit live plugin configuration through Config-derived forms. Edit fields that plugins declare with `.volatile()`... preserve secret values, and refuse stale writes. Changes persist through the active profile's Cordis patch."

### 2.2 三个关键能力

| 能力 | 声明方式 | 效果 |
|------|---------|------|
| 运行时可编辑 | `z.string().volatile()` | 改完立即生效（HMR），不用重启 |
| 密钥脱敏 | `z.string().role('secret')` | 客户端只收到 presence 标记，读不回明文 |
| 写入校验 | 由 dsh-settings 自动 | 按完整 Config schema 校验，拒绝过期写入 |

### 2.3 官方插件真实用例

`dsh-agent-default-model/lib/index.js`：

```javascript
static Config = z.object({
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    reasoningEffort: z.string().volatile()
});
constructor(ownerContext, config) {
    super(ownerContext, "agentDefaultModel");
    ownerContext.inject(["settings"], (child) => {
        child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber));
    });
}
```

### 2.4 UI 挂载点

`plugins.bundle.config` slot（keyed by 包名，来自 `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts`）：

> "A bundle's own configuration, keyed by the bundle's package name and rendered on the bundle's page between its description and its rows (`view: 'page'` only)."

官方真实注册写法（`dsh-experimental-client-ui-voice-input/lib/client.js`）：

```javascript
ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
    name: "plugins.bundle.config",
    key: "@deepseek-ai/dsh-experimental-voice-input-bundle",
    locale: NS,
    inject: () => actions
}, VoicePreparation));
```

组件收到 `PluginConfigViewProps`：

```typescript
interface PluginConfigViewProps {
    view: 'summary' | 'page';       // summary=一行摘要；page=完整表单
    form?: ConfigPageForm;           // host 提供的配置值与写入动作
}
interface ConfigPageForm {
    state: ConfigFormSnapshot<Record<string, unknown>>;  // 当前值
    mutate: ConfigForm<Record<string, unknown>>['mutate'];  // 提交写入
}
```

`ConfigFormSnapshot<T>`（来自 `dsh-client-ui-settings/lib/types/client/config-form-types.d.ts`）：

```typescript
interface ConfigFormSnapshot<T> {
    status: 'loading' | 'ready' | 'unavailable';
    value: T | undefined;      // schema 解析后的值
    base: unknown;             // 组成层（清空后回退到这里）
    user: unknown;             // 用户层原始存储（presence = 已覆盖）
    revision: number | undefined;  // 写入围栏
    writable: boolean;
    mode: 'host' | 'memory';   // host=写回 host 文档；memory=远端浏览器进程内
}
```

## 三、两套存储的差异（关键）

### 3.1 现状：环境变量文件

```
/etc/grape-dsh/grape.env          (权限 600, root)
  GRAPE_BASE_URL=http://127.0.0.1:8000
  GRAPE_API_TOKEN=grape_...
  DEEPSEEK_API_KEY=sk-...

加载链：
  systemd unit 的 EnvironmentFile=/etc/grape-dsh/grape.env
    → 注入 dsh 进程环境变量
      → 插件 resolveGrapeCliConfig() 读 process.env.GRAPE_BASE_URL
        → 拼成 grape CLI 的 --base-url / --token 参数
```

### 3.2 新方案：Config → profile 的 cordis.patch.yml

```
/root/.dsh/profiles/grape/cordis.patch.yml   (权限 600, root)
  - id: grape-tools
    disabled: false
    config:
      baseUrl: https://www.grapedev.cn
      token: <secret, 脱敏存储>
      timeout: 30

加载链：
  dsh Loader 读 profile cordis.patch.yml
    → 按插件 Config schema 校验
      → 注入 apply(ctx, config)
        → 插件读 config.baseUrl / config.token
```

### 3.3 逐维度对比

| 维度 | env 文件（现状） | Config（新方案） |
|------|-----------------|-----------------|
| **形态** | 环境变量 `KEY=VALUE` | YAML 配置树（结构化、带 schema） |
| **加载** | systemd EnvironmentFile → 进程 env | dsh Loader 读 patch → 注入 apply |
| **读取代码** | `process.env.GRAPE_BASE_URL` | `config.baseUrl`（已校验对象） |
| **文件权限** | `600 root` | `600 root`（同级） |
| **修改方式** | 手动编辑文件 + `vi` | UI 表单，或手动编辑 YAML |
| **生效方式** | **必须 `systemctl restart dsh-web`** | **volatile 字段 HMR 立即生效** |
| **UI 可见** | ❌ 完全黑盒，界面上看不到 | ✅ 插件配置页可视化 |
| **密钥脱敏** | ❌ 明文（只是文件不可读） | ✅ `role('secret')`，客户端读不回 |
| **值校验** | ❌ 无，写错到运行时才报 | ✅ schema 校验，非法值拒绝保存 |
| **并发安全** | ❌ 无 revision 概念 | ✅ revisioned，拒绝过期写入 |
| **作用域** | 整个 dsh 进程（全局） | 每个 profile 独立 |
| **优先级** | 低（被 config 覆盖） | 高（覆盖 env） |
| **适用场景** | 部署时注入、CI/容器、systemd | 用户运行时自助配置 |

### 3.4 五个关键差异（归纳）

1. **生效方式**——env 改完必须重启 dsh；Config 的 volatile 字段热更新，保存即生效
2. **可见性**——env 在界面上完全看不到，出了故障也无从查；Config 在插件页可见可改
3. **安全性**——env 是明文（靠文件权限保护）；Config 的 secret 字段结构性脱敏（客户端读不回明文）+ schema 校验
4. **优先级**——Config 覆盖 env（现有 `resolveGrapeCliConfig` 就是这个顺序：`config.X || process.env.X || default`）
5. **作用域**——env 是进程级全局；Config 是 profile 级（多 profile 部署时各自独立）

### 3.5 两套共存时的行为

```
resolveGrapeCliConfig 现有逻辑：
  baseUrl = config?.baseUrl || process.env.GRAPE_BASE_URL || 'http://localhost:8000'
  token   = config?.token   || process.env.GRAPE_API_TOKEN  || (报错)

即：Config 优先，env 作回退
```

**迁移策略（已决策）**：

1. **保留 env 作为回退**——兼容现有部署，不改动 `/etc/grape-dsh/grape.env` 的角色
2. **Config 优先**——`resolveGrapeCliConfig` 维持 `config.X || process.env.X || default` 顺序，UI 配置后自然覆盖 env
3. **不强制迁移**——用户可以用 UI 配，也可以继续用 env；两者共存不冲突
4. **逐步弃用**——新部署引导用 UI 配置；旧部署不动，env 继续生效

## 四、实现设计

### 4.1 host 侧改动（`src/index.ts`）

**现状**——已有 Config schema，但字段没标记 volatile / secret：

```typescript
export const Config: z<Config> = z.object({
  bin: z.string().default(''),
  baseUrl: z.string().default(''),
  token: z.string().default(''),
  timeout: z.number().default(30),
})
```

**改为**：

```typescript
export const Config: z<Config> = z.object({
  bin: z.string().default('').volatile(),
  baseUrl: z.string().default('').volatile(),
  token: z.string().default('').role('secret').volatile(),
  timeout: z.number().default(30).volatile(),
})
```

**加 settings 策略声明**（声明"我们自己提供配置页"，不依赖 auto-generate）：

```typescript
export function apply(ctx, config) {
  // 声明本插件自带配置页（auto: false）
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const resolved = resolveGrapeCliConfig({ ... })
  // ... 注册 33 个工具
}
```

**注意**：当前 `apply` 的 ctx 类型是 `{ tools: { register } }`，需要放宽以支持 `ctx.inject` / `ctx.fiber`。

### 4.2 client 侧新增

| 文件 | 内容 |
|------|------|
| `src/client/index.ts` | `apply(ctx)` 注册 `plugins.bundle.config` |
| `src/client/GrapeConfigPanel.tsx` | 配置表单组件 |
| `src/client/locale.ts` | 中英文文案 |
| `tsdown.config.ts` | 客户端构建配置 |

注册代码（参照 voice-input）：

```typescript
ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
    name: "plugins.bundle.config",
    key: "@grape-dev/grape-dsh",     // ← 按包名 keyed
    locale: NS,
}, GrapeConfigPanel));
```

### 4.3 表单组件设计

```tsx
function GrapeConfigPanel({ view, form }: PluginConfigViewProps) {
  if (view === 'summary') {
    return <span>{t('grape.config.summary')}</span>   // 一行摘要
  }
  // view === 'page'
  const snap = form?.state
  if (!snap || snap.status === 'loading') return <Spinner/>
  const values = (snap.value ?? {}) as { baseUrl?: string; token?: string; timeout?: number }

  return (
    <Form>
      <Field label={t('grape.config.base_url')}>
        <Input value={values.baseUrl ?? ''} placeholder="https://www.grapedev.cn" />
      </Field>

      <Field label={t('grape.config.api_token')} hint={t('grape.config.token_hint')}>
        {/* 脱敏：已配置显示标记，可替换不可读回 */}
        <SecretInput
          configured={hasToken(snap)}                      // 从 user 层 presence 判断
          placeholder={t('grape.config.token_placeholder')}
        />
      </Field>

      <Field label={t('grape.config.timeout')}>
        <NumberInput value={values.timeout ?? 30} min={5} max={300} />
      </Field>

      <SaveButton onClick={() => form.mutate([
        { path: ['baseUrl'], set: newBaseUrl },
        { path: ['token'],   set: newToken },      // 未改动则不提交
        { path: ['timeout'], set: newTimeout },
      ], snap.revision)} />
    </Form>
  )
}
```

**Secret 字段判定**：`snap.user` 里该字段的 presence 表示"用户已覆盖"。客户端不拿到明文，只拿到 presence 标记。未改动时不提交该字段（避免把脱敏占位符当新值写回）。

### 4.4 package.json 改动

```json
{
  "exports": {
    ".":        { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-ui-plugin-manager",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-slots"
      ],
      "platform": "web"
    }
  },
  "scripts": {
    "bundle": "tsdown"
  },
  "devDependencies": {
    "tsdown": "...",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "@deepseek-ai/cordis": "~4.0.4",
    "@deepseek-ai/dsh-client-ui-plugin-manager": "0.2.0-rc.2",
    "@deepseek-ai/dsh-client-ui-settings": "0.2.0-rc.2",
    "@deepseek-ai/dsh-client-ui-slots": "0.2.0-rc.2"
  }
}
```

## 五、安全考虑

| 问题 | 处理 |
|------|------|
| API Key 明文落盘 | `role('secret')` 字段在 cordis.patch.yml 里仍是明文存储，但**客户端读不回**；文件权限 600 |
| 客户端泄露 | 客户端只收到 presence 标记，拿不到明文 |
| 写错值 | schema 校验拦截；revision fence 拒绝过期写入 |
| 多 profile | 每个 profile 的 patch 独立，互不影响 |
| env 回退 | 保留 env 作回退，兼容现有部署 |

**注意**：secret 字段在磁盘上仍是明文（和现在的 env 文件一样是 600 权限）。脱敏只保证"客户端读不回"，不保证"磁盘加密"。这是 dsh-settings 的既定行为。

## 六、分阶段实施

| 阶段 | 内容 | 验证点 |
|------|------|--------|
| P1 | host 侧加 `.volatile()` + `role('secret')` + settings 策略声明 | dsh 启动无报错，Config 生效 |
| P2 | client half 骨架：package.json 契约 + tsdown 构建 + 空组件 | `lib/client.js` 产出，dsh 加载无报错 |
| P3 | `plugins.bundle.config` 注册 → 插件页出现配置入口 | Plugins 页能看到配置表单 |
| P4 | 表单字段实现（baseUrl / token / timeout）+ 保存 | 保存后 config 落地 cordis.patch.yml |
| P5 | 保存后热更新验证（改地址 → 工具立即用新地址） | 不用重启 dsh |
| P6 | env 回退 + 迁移文档 | 现有部署平滑升级 |

## 七、未决问题（实施时验证）

1. **`ctx.inject` / `ctx.fiber` 在第三方插件里可用性** —— 官方插件用 `ownerContext.inject(["settings"], ...)`，第三方插件是否同样可用需实测。若不可用，可能不需要 configure（auto 默认 true 时无 client 自动生成，等于无操作）。

2. **`plugins.bundle.config` 的 form 是否自动提供** —— `PluginConfigViewProps.form` 由 plugin-manager 页面提供，需确认第三方插件注册后 form 是否自动注入（还是需要自己通过 `ctx.configForms.get(entryId)` 取）。

3. **entryId 是什么** —— `configForms.get<T>(entryId)` 的 entryId 是 profile entry id（如 `grape-tools`），而 slot key 是包名（`@grape-dev/grape-dsh`）。两者关系需确认。

4. **secret 字段的写入语义** —— 未改动时如何避免把脱敏占位符写回。需确认 `mutate` 的 ops 里"不提交某字段"的行为。

5. **auto: false 是否必需** —— 若 auto 默认 true 且无 client 自动生成，可能不声明 configure 也能用。

6. **profile 的 config 落点** —— 确认写入 `- id: grape-tools` 行的 `config:` 子树（而不是新建行）。

## 八、验证清单

1. Plugins 页能看到 `@grape-dev/grape-dsh` 的配置入口
2. 填地址 + Key 保存 → `cordis.patch.yml` 出现 `config:` 子树
3. 保存后不重启 dsh，工具立即用新地址（改地址 → `grape_list_managed_repos` 返回新环境数据）
4. Key 字段显示"已配置"，刷新后仍显示已配置，但读不回明文
5. 填非法地址（如缺 scheme）→ schema 拒绝保存
6. 删掉 env 文件 → 仅靠 Config 仍能工作
7. env 保持原值时，Config 覆盖 env（改 Config 后行为变化）

---

## 九、实施结论（P10 已完成，实测确认）

> ⚠️ 文档契约与实际实现有出入，以下全部为**浏览器 + 落盘实测**结论。

### 9.1 已确认的机制

| 环节 | 结论 |
|------|------|
| slot | `plugins.bundle.config`，**keyed by 包名**（`@grape-dev/grape-dsh`），root scope，仅 `view:'page'` |
| 注册 | `ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({name, key: 包名}, Panel))` —— **可用**，注册后该插件详情页才出现配置区（管理器按 `ledger.bundles.has(pkg.name)` 决定是否渲染该区） |
| 组件 props | 实际只收到 `{view, usePanelInfo, useSessions, useSessionStatus, useWorkspaces, useResource, useSessionRetainInfo, renderFactorySlot}` |
| ❌ 文档的 `form` | **当前版本没有传**（`props.form === undefined`）。文档写的 `PluginConfigViewProps.form?: ConfigPageForm` 不可用 |
| ✅ 取值路径 | `ctx.configForms.get(entryId)` → `{getSnapshot, subscribe, set, unset, mutate}` |
| **entryId** | **是 cordis entry id（`grape-tools`），不是包名**。用包名得到 `status:'unavailable'`，用 entry id 得到 `status:'ready'` + 真实值 |
| 服务访问 | `configForms` **必须加进 client `inject`**（`export const inject = [..., 'configForms']`），否则 cordis 抛 `cannot get property "configForms" without inject` |
| ⚠️ ctx 来源 | 必须用 **apply 注入的 fiber ctx**，不能用根 ctx。用根 ctx 时方法内 `this` 丢失（`Cannot read properties of undefined (reading 'mirror')`） |
| snapshot | `{status, value, base, user, revision, writable, mode}`；`value` 就是配置对象 |
| 脱敏 | `.role('secret')` 字段（token）**完全不出现在 value 里**——只写不读，符合预期 |
| 持久化 | 写入 profile `cordis.patch.yml` 的 `- id: grape-tools` 行的 `config:` 子树 |
| 热生效 | `.volatile()` 字段改动**不重挂插件**（无新的 `Registered N tools` 日志） |

### 9.2 关键坑：`volatile` 字段是 live getter

加 `.volatile()` 后**字段不再是裸值**，而是 live getter——直接读会得到 `[object Object]`。
必须 `.get()`（`config.baseUrl.get()`）。我们的做法是容错读取：

```typescript
function readConfigField<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback
  if (typeof v === 'object' && typeof (v as any).get === 'function') return (v as any).get() ?? fallback
  return v as T
}
```

并且 `resolveGrapeCliConfig` 改为返回**带 getter 的配置对象**，每次读取重新解析 →
`.volatile()` 热改在工具调用时立即生效（否则改动要等插件重挂才生效，与"HMR"承诺相悖）。

### 9.3 最终实现

| 文件 | 作用 |
|------|------|
| `src/index.ts` | Config 加 `.volatile()` / `.role('secret')`；`readConfigField`；live 配置源；pre-execute 热读 `confirmWrites` |
| `src/cli-client.ts` | `resolveGrapeCliConfig(overrides, live)` 返回带 getter 的配置 |
| `src/client/GrapeConfigPanel.tsx` | 配置页组件（baseUrl / token 只写 / confirmWrites / bin / timeout + 保存） |
| `src/client/index.tsx` | 注册 `plugins.bundle.config`；`inject` 加 `configForms` |

### 9.4 实测记录

- 面板渲染：5 个输入框，真实值 `timeout=30`、`confirmWrites` 勾选 ✅
- 脱敏：password 框为空，token 不回传 ✅
- 写入：勾掉 confirmWrites → 保存 → `已保存 ✓`、`rev 0→1`，落盘 `config.confirmWrites: false` ✅
- 热生效：写入后**无重挂日志** ✅
- 往返：改回 true → `rev 2` → 落盘 `confirmWrites: true` ✅