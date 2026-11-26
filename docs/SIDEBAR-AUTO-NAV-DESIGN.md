# grape-dsh 侧栏实时观察窗设计（方案 D）

> 状态：设计已定，待实施
> 定位：自建 Grape 实时面板（侧栏 Tab）+ "在官网打开"逃生舱
> 替代：本文档早前"嵌 Grape 官网 iframe"的取向 1 方案（已废弃）
>
> 已定决策：
> 1. 数据通道：Phase 1 用"工具结果驱动"
> 2. 焦点范围：三种（流水线 / 事件 / 仓库概览）全做
> 3. 默认状态：AI 首次操作后才出现
> 4. 折叠时：自动展开
> 5. 写操作：先弹确认再执行

---

## 一、为什么是 D（差异性推导）

### 1.1 核心差异性

| | Grape 官网 | dsh + 插件 |
|---|---|---|
| 交互模型 | 点（找按钮、填表单） | 说（自然语言） |
| 天生擅长 | 看、扫、精细操作、探索 | 意图→行动、多步编排、跨实体推理 |
| 天生短板 | 多步流程要手动串 | 视觉贫乏、控制弱、信任缺口 |

**一句话**：官网 = 观察 + 精细操作；dsh = 意图 → 自动行动。

### 1.2 侧栏要补的洞

用 dsh 干活时用户失去三样东西，这正是侧栏存在的理由：

| dsh 的短板 | 侧栏怎么补 |
|-----------|-----------|
| 视觉贫乏（只有文本卡片） | 给富视觉实时面板 |
| 控制弱（AI 决定一切） | 给可操作的面板 + 逃生舱 |
| 信任缺口（"真跑起来了吗"） | 给真实状态 + 一键进官网核实 |

### 1.3 为什么不嵌官网

早前方案是"嵌 Grape 官网 iframe"。核实后发现三处硬伤：

1. **`#pipe/<n>` 是静态的**——`pipeline.js` 无 `setInterval`/SSE，加载一次不动。侧栏嵌进去就定格了，补不上"实时视觉"这个洞
2. **跨域登录**——存储分区导致 iframe 拿不到登录态，需同域部署
3. **仓库上下文不在 URL**——`currentRepo` 存 localStorage，iframe 里落到仓库列表页

D 方案（自建面板）**三处全消**，代价是"只能实现 Grape UI 的一个子集"——但这正是"聚焦观察窗"而非"第二个官网"的定位所需。

## 二、架构

```
┌──────────────── dsh web ──────────────────────────────────┐
│ 左栏 │          对话区            │ 右侧边栏（Grape Tab）    │
│      │                            │ ┌─────────────────────┐ │
│      │ 用户: 部署 snake-game-9     │ │ Grape 实时观察窗     │ │
│      │ 模型: [确认框] 创建 Issue？ │ │                     │ │
│      │      ✓ 确认                 │ │ Issue #10           │ │
│      │ 模型: 已创建 #10，触发流水线 │ │ 通用开发 · vod 阶段  │ │
│      │ [流水线卡片]                │ │ ┌──┐──→┌──┐──→┌──┐ │ │
│      │ ┌──┐──→┌──┐──→┌──┐          │ │ │✅│    │🔄│    │⬜│ │ │
│      │ │✅│    │🔄│    │⬜│          │ │ └──┘    └──┘    └──┘ │ │
│      │ └──┘    └──┘    └──┘          │ │ ✅1 完成 🔄1 进行   │ │
│      │                            │ │ 最新: seq115 sre     │ │
│      │                            │ │ [在官网打开][取消任务]│ │
│      │                            │ └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**三层分工**：
- **对话区** = 文本轻量层（pipelineCard，AI 输出，v0.3.x 已实现）
- **侧栏 Grape Tab** = 富视觉实时层（自建 React 面板）← 本次设计
- **官网** = 深入探索层（逃生舱一键跳转）

## 三、数据通道（Phase 1：工具结果驱动）

### 3.1 机制

```
我们的 client half 内部：
  ┌──────────────────┐  写    ┌─────────────────┐
  │ GrapeToolView    │ ─────→ │ 共享 store       │ ← 模块级单例
  │ tool.call.       │        │ (当前焦点 + 数据) │
  │ toolview         │        └────────┬────────┘
  └──────────────────┘                 │ 读 / 订阅
        ↑                              ↓
   host 工具结果到达              ┌─────────────────┐
   (phase='result')              │ GrapePanel      │
                                 │ sidebar.right.  │
                                 │ pane.tab        │
                                 └─────────────────┘
```

**为什么这样**：
- **零新基建**——两个组件都在我们 client half，共用一个模块级 store
- **实时性够**——AI 跑流水线时持续调 `grape_wait_task` 短轮询，每次结果刷新面板
- **密钥不出 host**——数据来自 host 侧工具结果（host 用 API token 调 CLI），浏览器不碰 token
- **可升级**——将来要独立轮询，再加 host Remote，接口不变

### 3.2 焦点数据的来源

host 侧工具结果里携带"焦点"信息。约定 host 在工具结果里带一个内部字段：

```json
{
  "issue_id": "#10", "stage": "vod", "statuses": [2,1,0,0,0],
  "segments": [...],
  "_focus": {                          ← host 写，client 读
     "kind": "pipeline",               // pipeline | event | overview
     "owner": "wdmike", "repo": "snake-game-9", "number": "10",
     "url": "https://www.grapedev.cn/app/#pipe/10"
  }
}
```

client 的 toolview 组件从 `block.content` 里解析 `_focus`，写入 store；面板订阅 store 渲染。

### 3.3 Phase 2（预留，不在本次范围）

若需"AI 停止轮询后面板继续更新"，再引入 host Remote：

| | Phase 1（本次） | Phase 2（预留） |
|---|---|---|
| 数据来源 | 工具结果 | host Remote 轮询 |
| 实时性 | 跟 AI 轮询同步（AI 停则冻结） | 独立实时 |
| 基建 | 零 | typert + api-gateway 工具链 |
| 密钥 | host 侧 | host 侧 |

## 四、面板内容设计

面板是"AI 当前焦点的实时视图"，三种焦点态 + 一个空闲态。

### 4.1 空闲态（AI 首次操作前）

> 按决策 3：AI 首次操作后才出现。所以空闲态仅在用户手动打开 Tab 时看到。

```
┌─────────────────────────────┐
│  Grape 实时观察窗             │
│                             │
│   等待 AI 操作 Grape…         │
│   在对话里让 AI 操作 Grape    │
│   后，这里会实时显示状态       │
│                             │
│   [选择仓库 ▾]               │
└─────────────────────────────┘
```

### 4.2 焦点态 A：issue 流水线（主态）

```
┌─────────────────────────────────┐
│ Issue #10 · 重新部署 snake-game  │
│ 通用开发场景 · 当前阶段: vod      │
│ ─────────────────────────────── │
│  ┌────────┐   ┌────────┐        │
│  │ ✅ VOD │──→│ 🔄 SRE │──→ …   │
│  │ 76.5s  │   │ 运行中  │        │
│  │ seq 113│   │ seq 115│        │
│  └────────┘   └────────┘        │
│ ─────────────────────────────── │
│ ✅ 1 完成 · 🔄 1 进行中 · ⬜ 3 待 │
│ ─────────────────────────────── │
│ 最新事件: seq 115 (sre a2a_event)│
│ @wdmike · 12s 前                 │
│ ─────────────────────────────── │
│ [在官网打开] [在侧栏浏览器打开]    │
│ [取消任务]                       │
└─────────────────────────────────┘
```

**字段来源**：`grape issues pipeline --owner --repo --number --json-out` 的返回值。

| 元素 | 字段 |
|------|------|
| Issue 号 + 标题 | `issue.number` / `summary` |
| 场景名 + 当前阶段 | `scene_name` / `stage` |
| 节点链（图标/名称/耗时/seq） | `segments[]` + `statuses[]` |
| 统计 | 各 status 计数 |
| 最新事件 | `segments[].latest_event` |

**状态图标映射**（Grape 状态码）：

| 码 | 图标 | 含义 | 颜色 |
|----|------|------|------|
| 0 | ⬜ | pending | 灰 |
| 1 | 🔄 | running | 蓝（脉冲动画） |
| 2 | ✅ | completed | 绿 |
| 3 | ❌ | failed | 红 |
| 4 | 🚫 | cancelled | 灰 |
| 5 | ⏭️ | skipped | 浅灰 |

### 4.3 焦点态 B：事件详情

```
┌─────────────────────────────────┐
│ 事件 seq 115                     │
│ ✅ completed · agent=sre         │
│ 耗时 45.0s · @wdmike             │
│ ─────────────────────────────── │
│ 结论: A2A → sre                  │
│ 动作: [展开 3 项]                │
│ 产物: [展开 2 项]                │
│ 日志: [展开]                     │
│ ─────────────────────────────── │
│ [在官网打开]                     │
└─────────────────────────────────┘
```

**字段来源**：`grape events detail --seq <n> --json-out`。

### 4.4 焦点态 C：仓库概览

```
┌─────────────────────────────────┐
│ wdmike/snake-game-9              │
│ ─────────────────────────────── │
│ ┌────┐ ┌────┐ ┌────┐            │
│ │ 630│ │ 1  │ │ 44 │            │
│ │总数│ │进行│ │失败│            │
│ └────┘ └────┘ └────┘            │
│ ─────────────────────────────── │
│ 进行中的流水线 (1)                │
│ #10  通用开发  vod ▓▓░░░░ 运行中  │
│ ─────────────────────────────── │
│ [在官网打开]                     │
└─────────────────────────────────┘
```

**字段来源**：`grape dashboard repo --owner --repo --json-out` 或 `grape issues list`。

### 4.5 逃生舱（关键）

两个按钮，把"深入探索"交给官网：

| 按钮 | 实现 | 效果 |
|------|------|------|
| **在官网打开** | `<a href="{url}" target="_blank" rel="noopener">` | 新标签页进完整控制台 |
| **在侧栏浏览器打开** | `ctx.sidebarRight.openTab('browser', { params: { url } })` | 复用 dsh 内置 iframe 浏览器（若启用了 sidebar-browser） |

这样：**轻量实时观察在自建面板，深入探索跳官网**——D 的完整闭环。

## 五、触发机制

面板是**单 Tab 常驻**，焦点**切换**而不是新开 Tab。相比早前 A/B/C 方案，语义干净得多：没有多 Tab 泛滥，没有重复打开的烦恼。

### 5.1 哪些工具触发焦点切换

| 类别 | 工具 | 触发 | 目标焦点 |
|------|------|------|---------|
| 写操作 | `grape_create_issue` / `grape_cancel_issue` / `grape_trigger_pipeline` | ✅ | 流水线 |
| 等待类 | `grape_wait_task` | ✅ | 流水线 |
| 定向查询 | `grape_get_pipeline_info` | ✅ | 流水线 |
| 定向查询 | `grape_get_task_status` | ✅ | 事件 |
| 概览类 | `grape_get_repo_dashboard` | ⚠️ 用户明确要求时 | 仓库概览 |
| 概览类 | `grape_get_ops_overview` | ⚠️ 用户明确要求时 | 仓库概览 |
| 列表查询 | `grape_list_issues` / `list_managed_repos` / `list_scenes` / `list_skills` / `list_knowledge` / `list_templates` | ❌ | — |

**原则**：写操作 + 有明确目标的查询触发；泛泛列表不触发。

### 5.2 触发行为

| 场景 | 行为 |
|------|------|
| AI 调写操作 | 面板切焦点到对应 issue；**侧栏若折叠则自动展开**（决策 4） |
| AI 调 `wait_task` 轮询 | 面板**持续更新**当前焦点（同一 issue 不重复切） |
| AI 调只读列表 | 面板不动 |
| 用户手动切焦点 | 暂停自动跟随 30s（尊重手动） |
| 工具报错 | 面板不动 |
| 工具结果无 `_focus` | 面板不动 |

### 5.3 首次出现（决策 3）

```
初始：侧栏没有 Grape Tab
  ↓ AI 首次操作 Grape（有 _focus 的工具）
  ↓ client 检测到首个焦点
侧栏出现 Grape Tab，自动展开，切到该焦点
  ↓ 之后保持常驻（焦点随 AI 操作切换）
```

### 5.4 冲突与降级

| 场景 | 处理 |
|------|------|
| 用户在看 documentpreview | Grape Tab 是不同 kind，共存不覆盖 |
| 用户手动改了焦点 | 暂停自动跟随 30s |
| 侧栏折叠 | 自动展开（决策 4，接受可能打断） |
| 未启用 client half / 老版本 | 静默降级——AI 操作照常，对话侧 pipelineCard 照常 |
| 工具报错 / 断网 | 面板不动，不影响对话 |

## 六、写操作确认（决策 5）

### 6.1 机制（已核实）

dsh 提供 `tools/pre-execute` waterfall 事件 + approval seam：

```typescript
// dsh-tools/lib/types/index.d.ts:47
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution,
                    next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;

// PreToolDecision（index.d.ts:445）
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string;
      displayReason?: { en: string; [locale: string]: string } };
```

`ask` 走 approval seam（`@deepseek-ai/dsh-user-approval`）：

> "require a one-shot decision before a sensitive tool action proceeds... an approval applies only to that request. Every request and outcome is recorded in the requesting session's audit log."
> "Missing or failed answerers return `unavailable`, so the action **fails closed**."

### 6.2 实现

```typescript
// host 侧
const WRITE_TOOLS = new Set([
  'grape_create_issue',
  'grape_cancel_issue',
  'grape_trigger_pipeline',
])

ctx.on('tools/pre-execute', async (exec, next) => {
  if (WRITE_TOOLS.has(exec.name)) {
    return {
      kind: 'ask',
      reason: 'Grape write operation',
      displayReason: {
        en: `Run ${exec.name}? This creates a real issue and triggers the pipeline.`,
        zh: `执行 ${exec.name}？这会创建真实 Issue 并触发流水线。`,
      },
    }
  }
  return next()
})
```

**注意**：approval seam 缺失时 `ask` 会 **fail closed**（拒绝执行）。dsh 的 base/web-app patch 已挂载 `approval` + `ui-approval`，所以正常部署有 answerer。

### 6.3 确认范围

| 工具 | 需确认 | 理由 |
|------|--------|------|
| `grape_create_issue` | ✅ | 创建真实 Issue + 触发流水线（有副作用） |
| `grape_cancel_issue` | ✅ | 取消运行中的任务 |
| `grape_trigger_pipeline` | ✅ | 触发流水线 |
| 只读工具 | ❌ | 无副作用 |

## 七、与配置 UI 的共享基建

配置 UI（`PLUGIN-CONFIG-UI-DESIGN.md`）和本方案**都需要 client half**：

```
配置 UI         → client half（plugins.bundle.config slot）
侧栏观察窗      → client half（sidebar.right.pane.tab + tool.call.toolview）
                  ▲
                  └── 同一套客户端构建链（tsdown + React + exports["./client"]）
```

**排期建议**：先搭 client half 基建（P1-P2），两个功能共用；再分别实现。

## 八、涉及的文件

### host 侧

| 文件 | 改动 |
|------|------|
| `src/index.ts` | 注册 `tools/pre-execute` 写操作确认 |
| `src/render/*.ts` | 工具结果里嵌入 `_focus` 字段 |
| `src/tools/{issues,pipeline,events,dashboard}.ts` | render 输出带焦点 URL |

### client 侧（新增）

| 文件 | 内容 |
|------|------|
| `src/client/index.ts` | 注册 toolview + sidebar tab |
| `src/client/store.ts` | 共享焦点 store（模块级单例 + 订阅） |
| `src/client/GrapeFocusPanel.tsx` | 侧栏面板组件（三种焦点态） |
| `src/client/GrapeToolView.tsx` | 工具卡片组件（解析 `_focus` 写入 store） |
| `src/client/PipelineNodes.tsx` | 节点链可视化 |
| `src/client/escape.ts` | 逃生舱（官网链接 + 侧栏浏览器打开） |
| `src/client/locale.ts` | 中英文文案 |
| `tsdown.config.ts` | 客户端构建 |

### 配置

| 文件 | 改动 |
|------|------|
| `package.json` | `exports["./client"]`、`dsh.client`、tsdown |
| dsh profile `cordis.patch.yml` | 可选启用 `ui-sidebar-browser`（让"在侧栏浏览器打开"可用） |

## 九、分阶段实施

| 阶段 | 内容 | 验证点 |
|------|------|--------|
| P1 | client half 基建（包契约 + tsdown + 空组件能加载） | `lib/client.js` 产出，dsh 加载无报错 |
| P2 | host 侧工具结果嵌入 `_focus` | 结果 JSON 里能看到 `_focus` |
| P3 | toolview 组件解析 `_focus` 写 store | store 内容正确 |
| P4 | 侧栏 Tab 注册 + 面板渲染（流水线焦点） | 侧栏出现 Tab，显示节点链 |
| P5 | 首次出现 + 自动展开（决策 3、4） | AI 首次操作后 Tab 出现并展开 |
| P6 | 事件焦点 + 仓库概览焦点（决策 2） | 三种焦点都能渲染 |
| P7 | 逃生舱（官网链接 + 侧栏浏览器） | 两个按钮都通 |
| P8 | 写操作确认（决策 5） | create_issue 前弹确认框 |
| P9 | 焦点切换 + 手动暂停 + 降级 | 边界场景正确 |

## 十、未决问题（实施时验证）

### ✅ 已解决（P1 实测）

**客户端 bundle 的构建与加载机制**（原本是最大的未知数）：

1. **bundle 格式**——"CJS-in-envelope"：
   ```javascript
   window.__ModuleLoader__.load({
     id: "<包名>",
     factory: (require) => {
       var module = { exports: {} }; var exports = module.exports;
       <CJS 代码>
       exports.apply = apply; exports.inject = inject;
       return module.exports;      // ← 必须返回
     }
   });
   ```
   加载器调用 `factory(makeRequire(...))`，用**返回值**当模块导出。

2. **构建方式**——esbuild 足够（`format:'cjs'` + 外部依赖保留 `require` + 文本包裹）。无需 tsdown。
   实现见 `scripts/build-client.mjs`。

3. **包契约**——`exports["./client"]` + `dsh.client.platform: "web"`；host 半扫描 Loader 条目，
   把声明了 `dsh.client` 的包编入 `window.__DSH_BOOT__` 图，在 `/plugins` 下服务。

4. **bundle URL**——combo 形式：`/plugins/??<id>/client.js&rev=<rev>`
   （document-relative 写作 `plugins/??<id>/client.js&rev=<rev>`）。

5. **验证手段**——首页 HTML 里的 `globalThis["__DSH_BOOT__"]` JSON 列出全部客户端条目；
   有 `<包名>` 条目 = 被发现；拉取该 URL 返回 bundle 内容 = 被服务。

### 仍待验证

1. ~~**`tool.call.toolview` 替换 generic row 的代价**~~ ✅ 已实测：**确实接管整行**，
   必须自己渲染卡片。副作用：presentCall/presentResult 的默认呈现被绕过。
2. ~~**`block.content` 是 render() 原文还是转换后**~~ ✅ 已实测：client 通过
   `block.content`（ContentBlock[]）拿到 render 输出的**文本**，`_focus` 标记可稳定解析。
   ⚠️ 但**拿不到原始 JSON**——所以焦点标记里必须自带画图所需的紧凑摘要。
3. ~~**侧栏 Tab 注册路径**~~ ✅ 已实测：`ctx.sidebarRightTabs.register({id,kind,...})` +
   `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({name,key}, Body))` 可用。
4. ~~**自动展开行为**~~ ✅ 已实测：折叠状态下 `openTab` 会展开（P5 验证通过）。
5. **模块级 store 在 React 严格模式下的行为**——实测用 `useSyncExternalStore` 无问题；
   并发/严格模式下如需更强语义可换 cordis service。
6. ~~**`tools/pre-execute` 在第三方 host 插件可用性**~~ ✅ 已实测：可用，
   `ctx.on('tools/pre-execute', (exec, next) => ...)`，返回 `{kind:'ask'}` 即弹确认。
7. ~~**approval seam 的 answerer 存在性**~~ ✅ 已实测：`dsh-base` 挂 `dsh-user-approval`
   （policy=ask，除非 DSH_PERMISSION_MODE=danger-full-access），`dsh-web-app` 挂
   `ui-approval`（弹窗 UI）。实测弹出 "Reject / Allow once" 并等待用户决定。
8. **`TabRecord` 的确切字段**——实测形状为 `{ contentId, id, kind, title }`；
   `ctx.sidebarRight.active()` 返回它。P9 的 `activeIsOurs` 按 `kind`/`id` 比对。

## 十一、踩坑记录（实施中发现，务必遵守）

### 🔴 1. 显式 `undefined` 会让**整个工具调用失败**（最严重）

dsh 对工具返回值做 `isJsonValue` 校验（`dsh-util-values`）。实测：

| 值 | 通过 |
|----|------|
| `{a:1}` | ✅ |
| `{a:undefined}` | ❌ |
| `{a:1,b:undefined}` | ❌ |
| `{a:NaN}` / `{a:Infinity}` | ❌ |

不通过的后果是**工具直接不可用**，模型看到的是 `value is not lossless JSON`。

**我们踩过**：`_focus.stats` 写成 `{total: x ?? undefined}` →
`grape_get_repo_dashboard` 整体失效（模型连续两次报错）。

**对策**：
- 构造 focus 时**只写有值的字段**（`if (v !== undefined) obj.k = v`），绝不写 `k: x || undefined`
- `focus.ts` 提供 `sanitizeFocus()` 安全网，`helper.ts` 附焦点前统一过一遍
- `test-lossless-json.mjs` 用 dsh 真实校验器对全部只读工具做回归

### 🔴 2. 注册 toolview 会接管整行，必须自己渲染

`tool.call.toolview` 是 keyed slot，注册即替换该工具行的渲染
（dsh 文档："occupied key replaces its view"）。所以 GrapeToolView 必须自己画卡片，
presentCall/presentResult 的默认呈现不再生效。

### 🔴 3. `MarkdownText` 需要整套 props，缺一个就崩

想用 dsh 的 markdown 渲染器渲染卡片时，只传 `text` 会抛
`Cannot read properties of undefined (reading 'code')`——它还需要
`labels`（含 `code` 等）、`fileMentions`、`pathImages`。

**对策**：P3 先用无依赖的等宽 `<pre>`（框线卡片在等宽下可读）。
后续要接 MarkdownText 时必须补齐 props 契约。

### 🔴 4. 本地联调必须把插件放进 profile 的 bundles

profile `package.json` 的 `dsh.profile.bundles` 必须含 `@grape-dev/grape-dsh`，
否则 Loader 不挂载（症状：日志没有 `Registered N tools`）。

### 5. 客户端 bundle 的 URL 是 combo 形式

`/plugins/??<id>/client.js&rev=<rev>`（不是 `/plugins/<id>/client.js`，后者 404）。
验证加载：首页 HTML 里 `globalThis["__DSH_BOOT__"]` 的 entries 是否含本包。

## 十二、开发环境要点（P1 实操记录）

| 事项 | 做法 |
|------|------|
| 本地联调 | profile 装 `link:/root/grape-dsh`（非 npm 包），改代码后重启 dsh 即生效 |
| client 重建 | `npm run bundle`（esbuild + 包裹脚本） |
| host 重建 | `npm run build`（tsc + bundle）；tsconfig 用 `exclude: ["src/client"]` 隔离 |
| client 类型检查 | `tsc --noEmit -p tsconfig.client.json`（DOM lib + react-jsx） |
| 必须进 bundles | profile 的 `dsh.profile.bundles` 要含 `@grape-dev/grape-dsh`，否则 Loader 不挂载 |
| 验证加载 | 看 dsh 日志 `Registered 33 tools`；看首页 `__DSH_BOOT__` 是否含本包 |
| 验证 bundle | 拉 `plugins/??@grape-dev/grape-dsh/client.js&rev=<rev>` 应返回 bundle 内容 |

## 十二、验证清单

1. AI 首次调 `grape_create_issue` → 弹确认框 → 确认后执行
2. 执行后侧栏出现 Grape Tab，自动展开，显示该 issue 流水线
3. AI 持续轮询 `grape_wait_task` → 面板节点状态实时更新
4. AI 调只读列表工具 → 面板不动
5. 用户手动切焦点 → 30s 内不被 AI 抢回
6. 点"在官网打开" → 新标签页进对应 Grape 页面
7. 点"在侧栏浏览器打开" → 侧栏浏览器 Tab 加载该页面
8. 拒绝确认 → 不创建 issue，不触发流水线，面板不动
9. 卸载 client half / 老版本 → 对话侧功能照常，无报错
10. 工具报错 / 断网 → 面板不动，对话不受影响