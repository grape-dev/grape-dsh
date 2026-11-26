# dsh 插件官方架构要求

> 基于 dsh v0.2.0-rc.2 官方插件源码实测（dsh-tool-bash / dsh-tool-todo / dsh-tool-web / dsh-tools）。
> 所有结论有源码或类型定义背书。

---

## 一、必须有的（缺一不可）

### 1. 入口文件导出三件套：`name` + `inject` + `apply`

dsh 加载插件时做的就是 `import 插件包` → 调 `apply(ctx)`。这三个导出是硬性要求：

```typescript
// lib/index.js（编译后）或 src/index.ts（源码）

/** 插件唯一标识 */
export const name = 'grape-tools'

/** 依赖的 dsh 服务，几乎都是 ['tools'] */
export const inject = ['tools']

/** dsh 启动时调用，在这里注册工具 */
export function apply(ctx, config) {
  ctx.tools.register(toolDefinition1)
  ctx.tools.register(toolDefinition2)
  // ...
}
```

| 导出 | 作用 | 缺了会怎样 |
|------|------|-----------|
| `name` | 插件唯一标识，用于 cordis patch 的 `id` | 插件无法被引用 |
| `inject` | 声明依赖的 dsh 服务（如 `tools`） | dsh 不知道要等哪些服务就绪 |
| `apply` | 入口函数，dsh 启动时调用 | 插件加载后什么都不做 |

### 2. package.json 指向入口

```json
{
  "name": "@grape-dev/grape-dsh",
  "version": "0.2.0",
  "type": "module",
  "main": "lib/index.js"
}
```

`main` 字段告诉 dsh 从哪个文件加载插件。`type: "module"` 表示用 ESM 模块格式。

### 3. 每个工具定义必须有的字段

通过 `ctx.tools.register()` 注册的每个工具对象，必须包含以下字段：

```typescript
ctx.tools.register({
  // ── 必须 ──
  name: 'grape_list_managed_repos',           // 工具名（模型看到的名字）
  description: '...',                          // 给模型看的描述（模型据此决定是否调用）
  parameters: {                                // JSON Schema 参数定义
    type: 'object',
    properties: { ... },
    additionalProperties: false,
    // required: [...] （有必填参数时才写）
  },
  output: {
    schema: { type: 'object', additionalProperties: true },  // 输出 schema
    render: (args, value) => [{ type: 'text', text: '...' }] // 模型看到的文本（从 execute 返回值生成）
  },
  async execute(args, exec) {
    // args: 模型传的 JSON 参数（已验证类型/必填）
    // exec.signal: AbortSignal（用户取消时用来中止）
    // 返回值: JSON 对象，匹配 output.schema，模型基于此回答用户
    return result
  },
})
```

| 字段 | 作用 | 谁消费 |
|------|------|--------|
| `name` | 工具唯一名，模型用这个名字调用 | 模型 / dsh 工具注册表 |
| `description` | 告诉模型这个工具干什么、什么时候用 | 模型（决定是否调用） |
| `parameters` | 参数的 JSON Schema，dsh 验证后才调 execute | dsh（验证） / 模型（知道传什么参数） |
| `output.schema` | 返回值的 JSON Schema，dsh 验证返回值 | dsh（验证） |
| `output.render` | 把 execute 返回值转成模型看到的文本 | dsh（调 render 生成 content blocks） |
| `execute` | 实际干活的函数 | dsh（模型调用时执行） |

---

## 二、可选的（官方插件有没有）

### 可选字段一览

| 字段/方法 | 作用 | 官方插件 | 第三方插件 |
|-----------|------|---------|-----------|
| `presentCall(args)` | 工具开始执行前，给用户看的卡片 | ✅ bash/web/editor 用 | 可选 |
| `presentResult(args, result)` | 工具完成后，给用户看的结果卡片 | ✅ bash/web 用 | 可选 |
| `timeoutMs` | 工具调用超时（毫秒） | ✅ web 用 | 可选 |
| `isConcurrencySafe(args)` | 是否允许并行调用 | ✅ web 用 | 可选 |
| `projectContent(exec, result)` | post-execute 前的内容投影 | ❌ | 可选 |
| `finalizeContent(exec, result)` | 最终内容变换 | ❌ | 可选 |

### presentCall / presentResult（UI 渲染）

```typescript
// 工具开始执行前——用户看到"正在做什么"
presentCall(args) {
  return {
    card: 'generic',       // 卡片类型
    title: '查询纳管仓库',  // 卡片标题
    kind: 'search',        // 图标分类：read/edit/delete/move/search/execute/fetch/other
  }
}

// 工具完成后——用户看到"结果是这样"
presentResult(args, result) {
  if (result.isError) return undefined  // 返回 undefined 则用 render 的文本兜底
  return {
    card: 'generic',
    title: '纳管仓库（2 个）',
    content: [{ type: 'text', text: 'Markdown 表格...' }]  // 结构化内容
  }
}
```

**6 种卡片类型：**

| card 值 | 适用场景 | 官方谁在用 |
|---------|---------|-----------|
| `generic` | 默认，标题 + 图标 + content | 全部工具的 fallback |
| `terminal` | 命令执行（命令 + 输出 + exit code） | bash |
| `diff` | 文件变更（old/new 对比） | str-replace-editor |
| `search` | 搜索结果（按文件分组） | grep/glob |
| `read` | 文件读取（带行号 + 语法高亮） | read |
| `web` | 网页搜索（URL + 标题 + 摘要） | web_search/web_fetch |

**关键约束：** presentCall 和 presentResult 必须是纯函数（只依赖 args/result，无副作用），因为 session 回放时也会调用它们。

### 工具执行流水线

```
模型决定调用工具
  → tools/pre-execute (waterfall，可拦截/拒绝/要求确认)
    → tools/execute (around-dispatch，可包装超时/重试)
      → execute()  ← 你的工具函数在这里跑
    → tools/post-execute (结果变换)
      → tools/result (最终观察，不可变)
```

`tools/pre-execute` 可以用来做确认——对写操作工具返回 `{ kind: 'ask', displayReason: { en: '...' } }`，dsh 会弹确认框让用户批准后才执行。

---

## 三、文件结构

### 官方插件的结构（极简）

官方插件基本是**单文件 + package.json**：

```
dsh-tool-bash/
├── package.json          ← name, main, peerDependencies
├── lib/
│   ├── index.js          ← name + inject + apply + 全部工具定义
│   └── types/index.d.ts  ← 类型声明
└── README.md
```

没有 cordis.patch.yml、没有 locale、没有 tsconfig.json——因为：
- 挂载配置写在 dsh-base 的 cordis.patch.yml 里（官方插件是 dsh 内置的）
- i18n 不做（工具描述直接写英文）
- TypeScript 编译在 dsh monorepo 里统一做

### 第三方插件的结构（你的 grape-dsh）

```
grape-dsh/
├── package.json              ← name, main, dsh.bundle, peerDependencies, prepare
├── cordis.patch.yml          ← 声明插件怎么挂到 profile（第三方必须）
├── tsconfig.json             ← TypeScript 编译配置（用 TS 才需要）
├── locale/
│   ├── en.json               ← 插件显示名的英文
│   └── zh.json               ← 插件显示名的中文
├── src/                      ← TypeScript 源码（提交到 git）
│   ├── index.ts              ← name + inject + apply
│   ├── cli-client.ts         ← spawn grape CLI
│   ├── types.ts              ← 类型定义
│   ├── render/               ← 渲染函数（非官方要求，自己分的）
│   └── tools/                ← 工具定义（非官方要求，自己分的）
├── lib/                      ← 编译产物（不提交，prepare 脚本自动生成）
└── README.md
```

### 最小可用插件

如果只要能跑，三个文件就够：

```
my-plugin/
├── package.json       ← { "name": "...", "main": "index.js", "type": "module" }
├── cordis.patch.yml   ← - insert: [{ id: my-plugin, name: '...' }]
└── index.js           ← export const name = '...'; export const inject = ['tools']; export function apply(ctx) { ctx.tools.register(...) }
```

---

## 四、挂载方式

### 官方插件（内置）

挂载配置写在 dsh-base 的 cordis.patch.yml 里：

```yaml
# dsh-base/cordis.patch.yml
- insert:
    - id: tool-bash
      name: '@deepseek-ai/dsh-tool-bash'
    - id: tool-todo
      name: '@deepseek-ai/dsh-tool-todo'
    - id: tool-web
      name: '@deepseek-ai/dsh-tool-web'
```

dsh 启动时读 dsh-base 的 patch，自动加载这些插件。官方插件不需要自己的 cordis.patch.yml。

### 第三方插件（dsh plugin add 安装）

需要两个东西配合：

**1. package.json 声明 dsh.bundle.patch：**

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

**2. cordis.patch.yml 声明挂载：**

```yaml
- insert:
    - id: grape-tools
      name: '@grape-dev/grape-dsh'
```

`dsh plugin add` 安装时，dsh 读 package.json 的 `dsh.bundle.patch`，找到 cordis.patch.yml，自动把 `grape-tools` 加到 profile 的配置树里。

如果没有 `dsh.bundle.patch`，`dsh plugin add` 装了包但不会自动挂载——需要手动在 profile 的 cordis.patch.yml 里写 insert。

---

## 五、package.json 必要字段

| 字段 | 必须？ | 作用 | 示例 |
|------|--------|------|------|
| `name` | ✅ | 包名 | `"@grape-dev/grape-dsh"` |
| `version` | ✅ | 版本号 | `"0.2.0"` |
| `main` | ✅ | 入口文件 | `"lib/index.js"` |
| `type` | ✅ | 模块格式 | `"module"` (ESM) |
| `peerDependencies` | 推荐 | 声明依赖的 dsh 包 | `"@deepseek-ai/dsh-tools": ">=0.0.1-0"` |
| `files` | 推荐 | 发布时包含哪些文件 | `["lib/**/*.js", "cordis.patch.yml", ...]` |
| `dsh.bundle.patch` | 第三方必须 | 指向 cordis.patch.yml | `"./cordis.patch.yml"` |
| `scripts.prepare` | 用 TS 时必须 | 安装时自动编译 | `"tsc"` |

---

## 六、官方插件 vs 第三方插件对比

| 维度 | 官方插件 (bash/todo/web) | 第三方插件 (grape-dsh) |
|------|------------------------|----------------------|
| 挂载方式 | dsh-base patch 里硬编码 | 自己的 cordis.patch.yml + dsh.bundle.patch |
| 语言 | TypeScript（编译在 dsh monorepo） | TypeScript（自己编译，prepare 脚本） |
| 文件结构 | 单文件 | 多文件（按功能分组） |
| i18n | 不做 | 可选（locale/en.json + locale/zh.json） |
| 安装方式 | dsh 自带 | `dsh plugin add` / `pnpm add` / git 依赖 |
| peerDependencies | 声明 | 声明 |
| presentCall/presentResult | 部分用 | 可选 |

---

## 七、验证依据

| 结论 | 依据 |
|------|------|
| name/inject/apply 是必须的 | dsh-tools/lib/types/index.d.ts: ToolRuntime.register(definition: ToolDefinition) |
| 官方插件单文件 | dsh-tool-bash/lib/index.js: 全部代码在一个文件，222 行开始 name/inject, 341 行 apply |
| 官方插件没有 cordis.patch.yml | `ls dsh-tool-bash/cordis.patch.yml` → NOT FOUND |
| 官方插件没有 locale 目录 | `ls dsh-tool-bash/locale/` → 空目录 |
| 官方插件在 dsh-base patch 里挂载 | dsh-base/cordis.patch.yml: `- id: tool-bash, name: '@deepseek-ai/dsh-tool-bash'` |
| dsh.bundle.patch 是第三方自动挂载机制 | dsh plugin add 读 package.json 的 dsh.bundle.patch → 找 cordis.patch.yml → 自动 insert |
| presentCall/presentResult 是纯函数 | presentation.d.ts: "Pure and side-effect-free: a UI may call it during live streaming AND a session-log replay" |
| 6 种卡片类型 | presentation.d.ts: ToolCallView = GenericCallView \| TerminalCallView \| DiffCallView; ToolResultView = GenericResultView \| TerminalResultView \| DiffResultView \| SearchResultView \| ReadResultView \| WebResultView |
| tools/pre-execute 可做确认 | dsh-tools/lib/types/index.d.ts: PreToolDecision = allow \| deny \| cancel \| ask |
