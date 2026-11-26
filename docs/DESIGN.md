# Grape × DeepSeek Harness 集成方案

## 1. 背景与目标

将 Grape 的 Agentic DevOps 流水线能力（场景路由、A2A 链路、技能体系、任务交接）以插件形式接入 DeepSeek Harness（dsh），使 dsh agent（DeepSeek 模型驱动）能在对话中调用 Grape 流水线完成开发运维任务。

### 集成方向

```
dsh agent (DeepSeek 模型)
  → 模型决定调用 grape 工具
  → dsh tool execute: spawn grape CLI 子进程
  → grape CLI 内部调 Grape HTTP API
  → 返回 JSON 给 dsh
  → 模型看到结果，决定下一步
```

**harness 调 grape，不是 grape 调 harness。** dsh 是宿主，Grape 是被动方。

### 设计原则

- 不改 dsh 源码——插件树外挂载
- 不改 Grape 服务端——复用已有 API + CLI
- CLI 优先——dsh 的 agent 后端体系天然是 CLI 子进程模型（opencode/hermes/codex 均如此）
- 契约驱动——工具 schema 从 Grape OpenAPI 契约生成，服务端新增 API → 插件自动获得新工具

## 2. 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| dsh 插件 | TypeScript / npm 包 | `@grape-dev/grape-dsh`，通过 cordis.patch.yml 挂载 |
| Grape CLI | Python / click | 已有仓库 `gitcode.com/grape-dev/grape-cli.git`，契约驱动命令 |
| Grape 服务端 | Python / FastAPI | 已有，不做改动 |
| dsh 运行时 | Node.js / Cordis | 开源仓库 `github.com/deepseek-ai/deepseek-harness` |

## 3. DeepSeek Harness 插件架构摘要

dsh 核心理念：**Everything is a Plugin**。没有特权内核，所有组件（模型适配器、工具注册表、会话日志、agent loop 本身）都是可替换插件。

### 插件接口（三种形态）

```typescript
// 1. 函数形式（最简单）
export const name = 'my-plugin'
export const inject = ['tools']
export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)
}

// 2. 对象形式
export default { name: 'my-plugin', inject: ['tools'], apply(ctx) { ... } }

// 3. 类形式（供其他插件消费的服务）
export default class MyService extends Service {
  static inject = ['tools']
  constructor(ctx: Context) { super(ctx, 'myService') }
}
```

### 关键扩展点

| dsh seam | 作用 | 本方案是否使用 |
|----------|------|---------------|
| `ctx.tools` | 注册模型可调用的工具 | ✅ 主路径 |
| `ctx.subagent` | 注册子代理后端 | ⬜ Phase 4 可选 |
| `ctx.webhookRuntime` | 外部事件触发 session | ⬜ 补充形态 |
| `ctx.remote` | 远程 API 服务声明 | ❌ 不需要 |
| `ctx.llm` | LLM 适配器注册 | ❌ 用 dsh 自带 DeepSeek 适配器 |

### 工具定义示例（dsh 原生 DSL）

```typescript
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'grape_tasks_current',
  description: 'Get the current task for this session.',
  parameters: {},
  output: {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    // spawn grape CLI 子进程
    const { stdout } = await exec('grape', ['tasks', 'current', '--json-out'])
    return JSON.parse(stdout)
  },
}))
```

### 插件挂载方式

独立 npm 包，通过 `cordis.patch.yml` 挂载，不需要 fork dsh 仓库：

```yaml
# ~/.dsh/profiles/my-profile/cordis.patch.yml
- id: grape-tools
  name: '@grape-dev/grape-dsh'
  config:
    grapeCliPath: grape  # 或绝对路径
    grapeBaseUrl: ${GRAPE_BASE_URL}
    grapeToken: ${GRAPE_SESSION_TOKEN}
```

## 4. Grape CLI 现状

### 已有能力

| 能力 | 命令 | 说明 |
|------|------|------|
| 契约驱动命令 | `grape refresh` | 读服务端 OpenAPI → 自动生成命令树，新增 API 零代码改动 |
| 任务管理 | `grape tasks current/complete/wait` | 查当前任务、完成交接、轮询等终态 |
| A2A 交接 | `grape a2a handoff --json '{...}'` | 触发流水线下一节点 |
| Issue 上下文 | `grape issues list/detail/events/pipeline` | 查 issue 状态、事件历史、流水线信息 |
| 仓库操作 | `grape git-repo repo/contents/tree/issues/comments` | 读仓库文件、issue、评论；创建评论 |
| Git passthrough | `grape git <any>` | 原生 git，凭据进程内注入不落盘 |
| 知识库 | `grape knowledge list/detail/stats` | 查项目知识 |
| 机器可读输出 | `--json-out` | 单行 JSON，供脚本/agent 解析 |
| Token 作用域 | session/user/dual | `tk_` 会话级 / `grape_` 用户级，自动 403 降级提示 |

### 架构

```
grape CLI (Python/click)
  ├── contracts.py    — OpenAPI 契约加载（远端 > 缓存 > 内置快照）
  ├── registry.py     — operationId → click 命令树自动生成
  ├── client.py       — httpx HTTP 客户端 + 三通道认证
  ├── cli.py          — 入口：ContractGroup + 内置命令（refresh/commands/wait/git）
  └── commands/git.py — git passthrough + 凭据注入
```

CLI 是 API 薄包装——所有命令内部走 httpx 调 Grape HTTP API。不是原生 CLI（不直接调内部函数）。但这不影响集成：dsh agent 后端模型就是 spawn CLI → 读 stdout。

### 安装

```bash
pip install git+https://gitcode.com/grape-dev/grape-cli.git
grape --version
```

### 配置

```bash
export GRAPE_BASE_URL=https://grape.example.com
export GRAPE_SESSION_TOKEN=tk_xxx   # 会话级（默认）
# export GRAPE_API_TOKEN=grape_xxx  # 用户级（管理命令需要）
```

优先级：`--token/--base-url` 参数 > 环境变量 > `~/.grape/config.json`。

## 5. 方案设计

### 5.1 总体架构

```
┌─────────────────────────────────────────────────┐
│  dsh agent (DeepSeek V4.1 模型)                  │
│                                                   │
│  对话 → 模型决定调用 grape 工具 → 工具 execute    │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │  @grape-dev/grape-dsh 插件                  │ │
│  │                                             │ │
│  │  ctx.tools.register(defineTool(...))        │ │
│  │                                             │ │
│  │  工具集：                                    │ │
│  │   - grape_tasks_current                     │ │
│  │   - grape_tasks_complete                    │ │
│  │   - grape_a2a_handoff                       │ │
│  │   - grape_issues_list / detail / events     │ │
│  │   - grape_git_repo_contents / tree / ...    │ │
│  │   - grape_knowledge_list / detail           │ │
│  │                                             │ │
│  │  execute 实现：                              │ │
│  │   spawnSync('grape', [...args, '--json-out'])│ │
│  │   → 解析 stdout JSON → 返回给模型            │ │
│  └──────────────────────┬──────────────────────┘ │
│                         │                         │
└─────────────────────────┼─────────────────────────┘
                          │ 子进程 spawn
                          ▼
┌─────────────────────────────────────────────────┐
│  grape CLI (Python)                              │
│                                                   │
│  grape tasks current --json-out                  │
│  grape a2a handoff --json '{...}'                │
│  grape issues list --owner o --repo r --json-out │
│                                                   │
│  内部：httpx → Grape HTTP API                    │
└──────────────────────────┬──────────────────────┘
                           │ HTTP
                           ▼
┌─────────────────────────────────────────────────┐
│  Grape 服务端 (FastAPI)                          │
│                                                   │
│  /api/tasks/*      — 任务管理                     │
│  /api/a2a          — A2A 交接                     │
│  /api/issues/*     — Issue 上下文                  │
│  /api/git-repo/*   — 仓库操作                     │
│  /api/knowledge/*  — 知识库                       │
│  /openapi.json     — 契约（CLI 读取）             │
└─────────────────────────────────────────────────┘
```

### 5.2 工具集设计

按 grape CLI 的 5 类命令分组映射为 dsh 工具：

#### Core workflows（任务与交接）

| dsh 工具名 | grape CLI 命令 | 参数 | 说明 |
|------------|----------------|------|------|
| `grape_tasks_current` | `tasks current` | 无 | 查当前会话任务 |
| `grape_tasks_complete` | `tasks complete` | `task_id`, `result_text`, `next_step` | 完成任务+触发下一步 |
| `grape_tasks_wait` | `tasks wait` | `task_id`, `timeout` | 轮询等终态 |
| `grape_a2a_handoff` | `a2a handoff` | `agent`, `payload{repository,account,issue_number,context}` | A2A 交接到下一节点 |

#### Agent Context（Issue/事件/知识）

| dsh 工具名 | grape CLI 命令 | 参数 | 说明 |
|------------|----------------|------|------|
| `grape_issues_list` | `issues list` | `owner`, `repo` | 列出仓库 issue |
| `grape_issues_detail` | `issues detail` | `owner`, `repo`, `number` | issue 详情 |
| `grape_issues_events` | `issues events` | `owner`, `repo`, `number` | issue 事件历史 |
| `grape_issues_pipeline` | `issues pipeline` | `owner`, `repo`, `number` | issue 流水线信息 |
| `grape_events_detail` | `events detail` | `event_id` | 单个事件详情 |
| `grape_knowledge_list` | `knowledge list` | 无 | 知识列表 |
| `grape_knowledge_detail` | `knowledge detail` | `knowledge_id` | 知识全文 |

#### Code & repositories（仓库操作）

| dsh 工具名 | grape CLI 命令 | 参数 | 说明 |
|------------|----------------|------|------|
| `grape_git_repo_info` | `git-repo repo` | `owner`, `repo` | 仓库信息 |
| `grape_git_repo_contents` | `git-repo contents` | `owner`, `repo`, `path?` | 文件/目录列表 |
| `grape_git_repo_tree` | `git-repo tree` | `owner`, `repo`, `ref?` | 目录树 |
| `grape_git_repo_issues_get` | `git-repo issues get` | `owner`, `repo`, `number` | 平台 issue 详情 |
| `grape_git_repo_comments_create` | `git-repo issues comments create` | `owner`, `repo`, `number`, `body` | 写评论 |

#### CLI utilities

| dsh 工具名 | grape CLI 命令 | 参数 | 说明 |
|------------|----------------|------|------|
| `grape_commands_list` | `commands` | `pattern?` | 列出可用命令（发现新能力） |
| `grape_refresh_contract` | `refresh` | 无 | 重拉最新契约 |

### 5.3 工具 execute 实现

每个工具的 execute 函数核心逻辑相同——spawn grape CLI 子进程，解析 JSON 输出：

```typescript
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

interface GrapeCliResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function execGrape(
  args: string[],
  env: Record<string, string>,
  signal: AbortSignal
): Promise<GrapeCliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('grape', [...args, '--json-out'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => (stdout += d))
    proc.stderr.on('data', (d) => (stderr += d))
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }))

    // 支持取消
    signal.addEventListener('abort', () => proc.kill('SIGTERM'))
  })
}
```

工具定义示例：

```typescript
defineTool({
  name: 'grape_a2a_handoff',
  description: 'Hand off to the next pipeline node via Grape A2A protocol.',
  parameters: {
    agent: { type: 'string', required: true, description: 'Target agent name (issue/coding/qa/sre/vod)' },
    repository: { type: 'string', required: true, description: 'owner/repo' },
    account: { type: 'string', required: true, description: 'owner/repo (account identity)' },
    issue_number: { type: 'string', required: true, description: 'Issue number' },
    context: { type: 'string', required: true, description: 'Handoff context message' },
  },
  output: {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  async execute(args, exec) {
    const payload = JSON.stringify({
      agent: args.agent,
      payload: {
        repository: args.repository,
        account: args.account,
        issue_number: args.issue_number,
        context: args.context,
      },
    })
    const result = await execGrape(
      ['a2a', 'handoff', '--json', payload],
      grapeEnv,
      exec.signal
    )
    if (result.exitCode !== 0) {
      throw new Error(`grape CLI failed: ${result.stderr}`)
    }
    return JSON.parse(result.stdout)
  },
})
```

### 5.4 契约驱动工具生成（Phase 4 增强）

Phase 1 手工定义工具列表。Phase 4 升级为自动生成——读 Grape OpenAPI 契约，自动构建 dsh 工具 schema，和 grape CLI 的 registry.py 同一思路：

```
Grape /openapi.json
  → 插件启动时 fetch
  → 解析 operationId → 工具名
  → 解析 parameters → 工具参数 schema
  → 解析 requestBody → 工具 --json 参数
  → ctx.tools.register(defineTool({...}))
  → 服务端新增 API → grape refresh → 插件重新 fetch → 自动获得新工具
```

好处：零维护——Grape 服务端加了新接口，dsh 插件自动获得对应工具。

### 5.5 环境与凭据

dsh 的 credentials 系统注入 grape CLI 所需环境变量：

```
GRAPE_BASE_URL    → Grape 服务端地址
GRAPE_SESSION_TOKEN → 会话级 token (tk_)
GRAPE_API_TOKEN   → 用户级 token (grape_)，可选
```

dsh credentials → 环境变量 → grape CLI config.resolve() → httpx 请求头。

### 5.6 错误处理

| 场景 | grape CLI 行为 | dsh 工具处理 |
|------|----------------|-------------|
| Grape 服务不可达 | `CliError: base_url unreachable` | 抛出，模型可见错误信息 |
| Token 过期/无效 | `CliError: HTTP 401 ... re-inject` | 抛出，提示模型需要新 token |
| 权限不足 (403) | `CliError: HTTP 403 ... session/user scope` | 抛出，提示需要切换 token 类型 |
| 流水线未完成 | `tasks wait` 超时 | 抛出 timeout，模型可重试或查状态 |
| CLI 未安装 | `spawn error: grape not found` | 抛出，提示安装 grape CLI |

## 6. 实施计划

### Phase 1：dsh 插件包（最小可用）

1. 初始化 npm 包 `@grape-dev/grape-dsh`
2. 实现 `execGrape()` 子进程调用工具函数
3. 手工定义核心工具集（tasks/a2a/issues/git-repo，约 15 个工具）
4. 插件入口 `src/index.ts`：`apply(ctx)` 注册所有工具
5. `package.json` 声明 `dsh.bundle` + 依赖
6. 本地 `npm link` + dsh `cordis.patch.yml` 挂载

### Phase 2：环境配置

7. dsh credentials 配置 `GRAPE_BASE_URL` + `GRAPE_SESSION_TOKEN`
8. 目标机器安装 grape CLI：`pip install git+https://gitcode.com/grape-dev/grape-cli.git`
9. 验证 `which grape` + `grape --version`

### Phase 3：验证

10. `dsh --profile web` 启动，确认插件加载
11. 单工具测试：模型调用 `grape_tasks_current` → 返回 JSON
12. 端到端测试：模型调用 `grape_a2a_handoff` → Grape 流水线启动 → `grape_tasks_wait` 轮询 → 结果回传
13. 错误场景：Grape 不可用 / token 过期 / 权限不足

### Phase 4：增强

14. 契约驱动工具生成——读 OpenAPI 自动生成工具 schema，替代手工定义
15. Subagent provider——实现 `SubagentBackend` 接口，Grape 作为 dsh 子代理后端
16. Webhook 桥接——外部事件（GitCode push/issue）→ dsh webhook → 自动触发 Grape 流水线
17. 工具粒度细化——按场景拆分更细粒度工具（deploy/code_review/create_issue 等）

## 7. 备选方案对比

| 方案 | dsh 侧改动 | Grape 侧改动 | 语言 | 优点 | 缺点 |
|------|-----------|-------------|------|------|------|
| **A. MCP Server** | 零（YAML 配置） | 新增 MCP endpoint | Python | 最小改动 | 工具粒度受限，看不到流水线进度 |
| **B. Tool 插件（本方案）** | 独立 npm 包 | 零 | TypeScript + Python | 完全融入 dsh 生态 | 需维护 TS 包 |
| **C. Subagent Provider** | 独立 npm 包 | 可能需同步等待端点 | TypeScript | dsh agent tree 可见子代理状态 | 最重，需实现完整 activation 生命周期 |
| **D. Webhook 桥接** | 注册 webhook 规则 | 零 | TypeScript | 自动触发 | 补充形态，非主路径 |

本方案选 B：改动量适中，Grape 侧零改动，且 CLI 子进程模型与 dsh agent 后端体系天然契合。

## 8. 关键文件

```
grape-dsh/                      # 待创建的 dsh 插件包
├── package.json                # @grape-dev/grape-dsh, dsh.bundle 声明
├── tsconfig.json
├── src/
│   ├── index.ts                # 插件入口：apply(ctx) 注册工具
│   ├── exec.ts                 # execGrape() 子进程调用
│   ├── tools/                  # 工具定义
│   │   ├── tasks.ts            # tasks_current/complete/wait
│   │   ├── a2a.ts              # a2a_handoff
│   │   ├── issues.ts           # issues_list/detail/events/pipeline
│   │   ├── git-repo.ts         # git-repo_*/comments
│   │   ├── knowledge.ts        # knowledge_list/detail
│   │   └── cli.ts              # commands_list/refresh
│   └── env.ts                  # 环境变量/凭据解析
├── locale/
│   ├── en.json
│   └── zh.json
└── README.md
```

## 9. 参考

- dsh 仓库：https://github.com/deepseek-ai/deepseek-harness
- dsh 架构文档：docs/architecture.zh.md
- dsh 工具开发指南：docs/cookbook/adding-a-tool.md
- dsh 插件包指南：docs/cookbook/adding-a-package.md
- dsh 扩展 cookbook：docs/cookbook/extension-cookbook.md
- grape CLI 仓库：https://gitcode.com/grape-dev/grape-cli.git
- grape CLI 技能：skills/grape-cli-guidance/SKILL.md
- grape 服务端：https://gitcode.com/grape-dev/grape.git
