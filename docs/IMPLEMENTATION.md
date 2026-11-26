# 实现计划与验证方案

## 0. 前置环境确认

| 依赖 | 当前状态 | 需要 |
|------|---------|------|
| Node.js | ✅ v22.23.2 已安装 | ≥ 18 |
| npm | ✅ 10.9.8 已安装 | — |
| TypeScript (tsc) | ❌ 未安装 | `npm install -g typescript` |
| dsh | ❌ 未安装 | `npm install -g @deepseek-ai/dsh` 或 `npx @deepseek-ai/dsh` |
| grape CLI | ✅ 源码在 /root/grape-cli | `pip install -e /root/grape-cli` |
| Grape 服务端 | ❌ 未运行 | 需启动（端口 3000 或 8000） |
| GRAPE_API_TOKEN | ❌ 未配置 | 用户在 Grape Web 创建 API Key |

## 1. API 端点确认（已验证全部存在）

| # | 工具 | Grape API | 方法 | token scope |
|---|------|-----------|------|-------------|
| 1 | list_scenes | `/api/scenes` | GET | user_only |
| 2 | get_repo_scene | `/api/scenes/with-pipeline` | GET | user_only |
| 3 | apply_scene | `/api/scenes/apply/{owner}/{repo}` | POST | user_only |
| 4 | list_managed_repos | `/api/repos/managed` | GET | user_only |
| 5 | trigger_pipeline | `/api/a2a` | POST | dual |
| 6 | get_task_status | `/api/events/detail/{seq}` | GET | dual |
| 7 | wait_task | `/api/events/detail/{seq}` 轮询 | GET | dual |
| 8 | get_pipeline_info | `/api/issues/{owner}/{repo}/{number}/pipeline` | GET | dual |
| 9 | list_issues | `/api/issues/{owner}/{repo}` | GET | dual |
| 10 | get_issue_events | `/api/issues/{owner}/{repo}/{number}/events` | GET | dual |

注意：工具 1-4 是 user_only（需要 grape_ token），工具 5-10 是 dual（grape_ 或 tk_ 都行）。统一用 grape_ token。

## 2. 插件文件结构

```
/root/grape-dsh/
├── package.json              — npm 包声明
├── tsconfig.json             — TypeScript 编译配置
├── src/
│   ├── index.ts              — 插件入口：name + inject + apply
│   ├── client.ts             — Grape HTTP 客户端（fetch + token 注入）
│   ├── types.ts              — TypeScript 类型定义
│   └── tools/
│       ├── scenes.ts         — list_scenes / get_repo_scene / apply_scene
│       ├── repos.ts          — list_managed_repos
│       ├── pipeline.ts       — trigger_pipeline / get_task_status / wait_task
│       └── issues.ts         — get_pipeline_info / list_issues / get_issue_events
├── locale/
│   ├── en.json
│   └── zh.json
└── README.md
```

## 3. 逐步实现

### Step 1：初始化项目

```bash
mkdir -p /root/grape-dsh/src/tools /root/grape-dsh/locale
cd /root/grape-dsh
npm init -y
npm install typescript --save-dev
npx tsc --init
```

### Step 2：package.json

```json
{
  "name": "@grape-dev/grape-dsh",
  "version": "0.1.0",
  "description": "Grape DevOps pipeline tools for DeepSeek Harness",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    }
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts"],
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=1.0.0",
    "@deepseek-ai/dsh-tools": ">=1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@deepseek-ai/cordis": ">=1.0.0",
    "@deepseek-ai/dsh-tools": ">=1.0.0"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  }
}
```

### Step 3：tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "./lib",
    "rootDir": "./src",
    "declaration": true,
    "declarationDir": "./lib/types",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

### Step 4：src/types.ts — 类型定义

```typescript
/** Grape API 客户端配置 */
export interface GrapeConfig {
  baseUrl: string       // Grape 服务端地址，如 https://grape.example.com
  token: string         // grape_ 用户级 API Key
  timeout: number       // 请求超时（毫秒）
}

/** Grape API 返回的场景 */
export interface GrapeScene {
  scene_id: string
  name: string
  description: string
  nodes: GrapePipelineNode[]
}

/** 流水线节点 */
export interface GrapePipelineNode {
  tag: string
  status: string      // pending / running / completed / failed
  summary?: string
}

/** Issue 摘要 */
export interface GrapeIssue {
  number: number
  title: string
  state: string
  pipeline_status?: string
}

/** 托管仓库 */
export interface GrapeManagedRepo {
  repo_key: string
  scene: string
  scene_name: string
}

/** 事件详情 */
export interface GrapeEvent {
  seq: number
  status: string
  agent_type: string
  summary: string
  result?: string
}

/** A2A 触发返回 */
export interface GrapeA2aResult {
  status: string
  seq: number
  agent: string
}
```

### Step 5：src/client.ts — Grape HTTP 客户端

```typescript
import type { GrapeConfig, GrapeEvent } from './types.js'

/**
 * Grape HTTP API 客户端。
 * 所有工具的 execute 最终都通过这个客户端调 Grape API。
 */
export class GrapeClient {
  private baseUrl: string
  private token: string
  private timeout: number

  constructor(config: GrapeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.token = config.token
    this.timeout = config.timeout
  }

  /** 发起 Grape API 请求 */
  async request<T = any>(
    method: string,
    path: string,
    options: {
      params?: Record<string, string>
      body?: Record<string, unknown>
      signal?: AbortSignal
    } = {}
  ): Promise<T> {
    // 构建完整 URL（含 query 参数）
    const url = new URL(this.baseUrl + path)
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        if (v) url.searchParams.set(k, v)
      }
    }

    // 构建 fetch 选项
    const init: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      signal: options.signal,
    }
    // 超时控制：用 AbortController 组合 signal
    if (this.timeout > 0) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeout)
      // 如果调用方也传了 signal，监听它的 abort
      if (options.signal) {
        options.signal.addEventListener('abort', () => controller.abort())
      }
      init.signal = controller.signal
      // 请求完成后清除 timer
      options.signal?.addEventListener('abort', () => clearTimeout(timer))
    }
    if (options.body) {
      init.body = JSON.stringify(options.body)
    }

    const resp = await fetch(url.toString(), init)
    const data = await resp.json().catch(() => resp.text())

    if (!resp.ok) {
      const msg = typeof data === 'object' && data !== null
        ? (data as any).detail?.message || (data as any).message || JSON.stringify(data)
        : String(data)
      throw new Error(`Grape API ${resp.status}: ${msg} (${method} ${path})`)
    }

    return data as T
  }

  /** 轮询事件直到终态或超时 */
  async pollUntilTerminal(
    seq: number,
    timeout: number,
    interval: number,
    signal?: AbortSignal
  ): Promise<GrapeEvent> {
    const terminal = new Set(['completed', 'failed', 'cancelled'])
    const deadline = Date.now() + timeout * 1000

    while (true) {
      if (signal?.aborted) throw new Error('Aborted')

      const event = await this.request<GrapeEvent>('GET', `/api/events/detail/${seq}`)

      if (terminal.has(event.status) || Date.now() >= deadline) {
        return event
      }

      await new Promise(resolve => setTimeout(resolve, interval * 1000))
    }
  }
}

/** 从环境变量读取配置 */
export function resolveGrapeConfig(): GrapeConfig {
  const baseUrl = process.env.GRAPE_BASE_URL || process.env.GRAPE_SERVER_URL || 'http://localhost:8000'
  const token = process.env.GRAPE_API_TOKEN || ''
  const timeout = parseInt(process.env.GRAPE_TIMEOUT || '30000', 10)

  if (!token) {
    throw new Error(
      'GRAPE_API_TOKEN is not set. Create an API Key in Grape Web Settings, ' +
      'then set GRAPE_API_TOKEN environment variable.'
    )
  }

  return { baseUrl, token, timeout }
}
```

### Step 6：src/tools/scenes.ts — 场景工具

```typescript
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { GrapeClient } from '../client.js'

/** 注册场景相关工具：list_scenes / get_repo_scene / apply_scene */
export function registerSceneTools(ctx: Context, client: GrapeClient) {

  ctx.tools.register(defineTool({
    name: 'grape_list_scenes',
    description: '[Grape-unique] List all available pipeline scenes (workflow types) in Grape. ' +
      'Each scene defines a multi-agent pipeline (e.g., default=VOD→Issue→Coding→QA→SRE, ' +
      'blog-publish=VOD→Issue→Coding→SRE). Use this to discover which pipeline types are available.',
    parameters: {},
    output: {
      schema: { type: 'array' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      return await client.request('GET', '/api/scenes', { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grape_get_repo_scene',
    description: '[Grape-unique] Get the current pipeline scene bound to a managed repository. ' +
      'Returns the scene name and pipeline node configuration.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      // 先查托管仓库列表找到 repo_key，再查场景
      // 或者直接用 /api/scenes/with-pipeline 查带流水线的场景列表
      return await client.request('GET', '/api/scenes/with-pipeline', {
        params: { repo: `${args.owner}/${args.repo}` },
        signal: exec.signal,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grape_apply_scene',
    description: '[Grape-unique] Apply (switch) a pipeline scene to a managed repository. ' +
      'This changes which multi-agent pipeline the repo uses for future triggers. ' +
      'Use grape_list_scenes first to find available scene names.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      scene: { type: 'string', required: true, description: 'Scene ID to apply (e.g., "default", "blog-publish")' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return await client.request('POST', `/api/scenes/apply/${args.owner}/${args.repo}`, {
        params: { scene: args.scene },
        signal: exec.signal,
      })
    },
  }))
}
```

### Step 7：src/tools/repos.ts — 仓库工具

```typescript
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { GrapeClient } from '../client.js'

export function registerRepoTools(ctx: Context, client: GrapeClient) {

  ctx.tools.register(defineTool({
    name: 'grape_list_managed_repos',
    description: '[Grape-unique] List all repositories managed by Grape, including their ' +
      'current pipeline scene. Use this to discover which repos are available for pipeline triggers.',
    parameters: {},
    output: {
      schema: { type: 'array' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      return await client.request('GET', '/api/repos/managed', { signal: exec.signal })
    },
  }))
}
```

### Step 8：src/tools/pipeline.ts — 流水线工具

```typescript
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { GrapeClient } from '../client.js'

export function registerPipelineTools(ctx: Context, client: GrapeClient) {

  ctx.tools.register(defineTool({
    name: 'grape_trigger_pipeline',
    description: '[Grape-unique] Trigger a Grape DevOps pipeline by creating an A2A handoff ' +
      'to the first pipeline node (usually VOD). This starts the full multi-agent pipeline ' +
      '(VOD→Issue→Coding→QA→SRE or whichever scene the repo uses). ' +
      'Pipeline node-to-node handoff is managed internally by Grape, not controllable from outside. ' +
      'Returns an event_seq that can be used with grape_get_task_status or grape_wait_task.',
    parameters: {
      repository: { type: 'string', required: true, description: 'Repository in owner/repo format' },
      issue_number: { type: 'string', required: true, description: 'GitCode issue number' },
      account: { type: 'string', required: true, description: 'Account identity (usually same as owner/repo)' },
      context: { type: 'string', required: true, description: 'Task description or context for the VOD agent' },
      agent: { type: 'string', description: 'Target agent name (default: vod). Usually leave default.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const body = {
        agent: args.agent || 'vod',
        payload: {
          repository: args.repository,
          account: args.account,
          issue_number: args.issue_number,
          context: args.context,
        },
      }
      return await client.request('POST', '/api/a2a', { body, signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grape_get_task_status',
    description: '[Grape-unique] Get the current status of a pipeline task by event sequence number. ' +
      'Returns status (running/completed/failed/cancelled), agent name, and summary. ' +
      'Use grape_trigger_pipeline first to get the event_seq.',
    parameters: {
      event_seq: { type: 'number', required: true, description: 'Event sequence number (from trigger_pipeline)' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return await client.request('GET', `/api/events/detail/${args.event_seq}`, { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grape_wait_task',
    description: '[Grape-unique] Poll a pipeline task until it reaches a terminal state ' +
      '(completed/failed/cancelled) or timeout. Blocks until the task is done or timeout is reached. ' +
      'Use this after grape_trigger_pipeline to wait for the full pipeline to complete.',
    parameters: {
      event_seq: { type: 'number', required: true, description: 'Event sequence number' },
      timeout: { type: 'number', description: 'Max wait seconds (default 120)' },
      interval: { type: 'number', description: 'Poll interval seconds (default 3)' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const timeout = args.timeout ?? 120
      const interval = args.interval ?? 3
      const event = await client.pollUntilTerminal(
        args.event_seq, timeout, interval, exec.signal
      )
      if (!['completed', 'failed', 'cancelled'].includes(event.status)) {
        throw new Error(`wait_task timeout (>${timeout}s), current status: ${event.status}`)
      }
      return event
    },
  }))
}
```

### Step 9：src/tools/issues.ts — Issue 工具

```typescript
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { GrapeClient } from '../client.js'

export function registerIssueTools(ctx: Context, client: GrapeClient) {

  ctx.tools.register(defineTool({
    name: 'grape_get_pipeline_info',
    description: '[Grape-unique] Get the pipeline configuration and current node status for an issue. ' +
      'Returns the scene name and each pipeline node\'s status (pending/running/completed/failed) with summary. ' +
      'Use this to check progress of a running pipeline.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      number: { type: 'string', required: true, description: 'Issue number' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return await client.request('GET',
        `/api/issues/${args.owner}/${args.repo}/${args.number}/pipeline`,
        { signal: exec.signal }
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grape_list_issues',
    description: '[Grape-unique] List issues for a repository with Grape pipeline status. ' +
      'Each issue includes pipeline_status (running/completed/failed/none). ' +
      'Use this to find which issues have active pipelines.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      state: { type: 'string', description: 'Filter: open/closed/all (default: open)' },
    },
    output: {
      schema: { type: 'array' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return await client.request('GET', `/api/issues/${args.owner}/${args.repo}`, {
        params: args.state ? { state: args.state } : undefined,
        signal: exec.signal,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grape_get_issue_events',
    description: '[Grape-unique] Get the event history for an issue — agent executions, ' +
      'A2A handoffs, status changes. This is Grape\'s internal execution log, not available from GitCode. ' +
      'Use this for debugging failed pipelines or reviewing what each agent did.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner' },
      repo: { type: 'string', required: true, description: 'Repository name' },
      number: { type: 'string', required: true, description: 'Issue number' },
    },
    output: {
      schema: { type: 'array' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return await client.request('GET',
        `/api/issues/${args.owner}/${args.repo}/${args.number}/events`,
        { signal: exec.signal }
      )
    },
  }))
}
```

### Step 10：src/index.ts — 插件入口

```typescript
/**
 * @grape-dev/grape-dsh — Grape DevOps pipeline tools for DeepSeek Harness.
 *
 * Registers 10 model-facing tools that let the dsh agent trigger and monitor
 * Grape multi-agent DevOps pipelines. All tools are [Grape-unique] — they
 * query data only available inside the Grape platform.
 *
 * Design principle: only trigger, only observe, never interfere with
 * pipeline node-to-node handoff.
 *
 * @module @grape-dev/grape-dsh
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GrapeClient, resolveGrapeConfig } from './client.js'
import { registerSceneTools } from './tools/scenes.js'
import { registerRepoTools } from './tools/repos.js'
import { registerPipelineTools } from './tools/pipeline.js'
import { registerIssueTools } from './tools/issues.js'

/** Cordis plugin name */
export const name = 'grape-tools'

/** Services required: only the tool registry */
export const inject = ['tools']

/** Plugin config (all optional — read from env vars by default) */
export interface Config {
  /** Override Grape server URL (default: $GRAPE_BASE_URL) */
  baseUrl?: string
  /** Override Grape API token (default: $GRAPE_API_TOKEN) */
  token?: string
  /** Request timeout in ms (default: 30000) */
  timeout?: number
}

export const Config = z.object({
  baseUrl: z.string().default(''),
  token: z.string().default(''),
  timeout: z.number().default(30000),
})

/** Plugin entry point — registers all Grape tools on ctx.tools */
export function apply(ctx: Context, config: Config = {} as Config): void {
  // Resolve config: explicit > env > error
  const baseUrl = config.baseUrl || process.env.GRAPE_BASE_URL || process.env.GRAPE_SERVER_URL || 'http://localhost:8000'
  const token = config.token || process.env.GRAPE_API_TOKEN || ''
  const timeout = config.timeout || 30000

  if (!token) {
    throw new Error(
      '[grape-dsh] GRAPE_API_TOKEN is not set. Create an API Key in Grape Web Settings, ' +
      'then set GRAPE_API_TOKEN environment variable or pass token in plugin config.'
    )
  }

  const client = new GrapeClient({ baseUrl, token, timeout })

  // Register all tool groups
  registerSceneTools(ctx, client)
  registerRepoTools(ctx, client)
  registerPipelineTools(ctx, client)
  registerIssueTools(ctx, client)

  // Log
  console.log(`[grape-dsh] Registered 10 tools, baseUrl=${baseUrl}`)
}
```

### Step 11：编译

```bash
cd /root/grape-dsh
npm install           # 安装依赖（typescript + dsh peer deps）
npx tsc               # 编译 → lib/index.js + lib/types/
```

### Step 12：dsh 挂载配置

创建或编辑 dsh profile 的 `cordis.patch.yml`：

```yaml
# ~/.dsh/profiles/grape/cordis.patch.yml
- id: grape-tools
  name: '@grape-dev/grape-dsh'
  config:
    baseUrl: ''           # 留空则读 GRAPE_BASE_URL 环境变量
    token: ''             # 留空则读 GRAPE_API_TOKEN 环境变量
    timeout: 30000
```

环境变量：
```bash
export GRAPE_BASE_URL=http://localhost:8000     # Grape 服务端地址
export GRAPE_API_TOKEN=grape_xxxxx              # 用户在 Grape Web 创建的 API Key
```

## 4. 验证方案

### 验证 1：编译通过

```bash
cd /root/grape-dsh
npx tsc --noEmit    # 只检查类型，不输出文件
# 期望：无错误输出，exit code 0
```

### 验证 2：Grape API 连通性（不通过 dsh，直接测 client）

写一个测试脚本 `test-connection.mjs`：

```javascript
// 直接测试 Grape API 是否可达 + token 是否有效
const baseUrl = process.env.GRAPE_BASE_URL || 'http://localhost:8000'
const token = process.env.GRAPE_API_TOKEN

if (!token) {
  console.error('GRAPE_API_TOKEN not set')
  process.exit(1)
}

// 测试 1：list_managed_repos（验证 token + 连通）
const resp1 = await fetch(`${baseUrl}/api/repos/managed`, {
  headers: { 'Authorization': `Bearer ${token}` }
})
console.log('list_managed_repos:', resp1.status, await resp1.text().then(t => t.slice(0, 200)))

// 测试 2：list_scenes（验证场景查询）
const resp2 = await fetch(`${baseUrl}/api/scenes`, {
  headers: { 'Authorization': `Bearer ${token}` }
})
console.log('list_scenes:', resp2.status, await resp2.text().then(t => t.slice(0, 200)))

// 测试 3：list_issues（验证 dual 端点）
const resp3 = await fetch(`${baseUrl}/api/issues/test-owner/test-repo`, {
  headers: { 'Authorization': `Bearer ${token}` }
})
console.log('list_issues:', resp3.status, await resp3.text().then(t => t.slice(0, 200)))
```

运行：
```bash
export GRAPE_BASE_URL=http://localhost:8000
export GRAPE_API_TOKEN=grape_xxxxx
node test-connection.mjs
# 期望：三个请求都返回 200 或合理的业务状态
```

### 验证 3：插件加载（dsh 启动）

```bash
# 确保 grape 服务在运行
curl -s http://localhost:8000/health

# 启动 dsh，确认插件加载
export GRAPE_BASE_URL=http://localhost:8000
export GRAPE_API_TOKEN=grape_xxxxx
dsh --profile grape --dump-config 2>&1 | grep grape
# 期望：看到 grape-tools 插件条目

# 或启动 web 模式
dsh --profile grape
# 查看启动日志中是否有 "[grape-dsh] Registered 10 tools"
```

### 验证 4：工具列表确认

在 dsh 对话中输入：
```
你有哪些 grape 相关的工具？
```

期望模型列出 10 个工具：
- grape_list_scenes
- grape_get_repo_scene
- grape_apply_scene
- grape_list_managed_repos
- grape_trigger_pipeline
- grape_get_task_status
- grape_wait_task
- grape_get_pipeline_info
- grape_list_issues
- grape_get_issue_events

### 验证 5：单工具调用（只读，不改状态）

在 dsh 对话中：
```
帮我看看 Grape 上托管了哪些仓库
```

期望：
- 模型调用 `grape_list_managed_repos`
- 返回托管仓库列表 JSON
- 模型用自然语言总结

### 验证 6：场景查询

```
有哪些可用的流水线场景？
```

期望：
- 模型调用 `grape_list_scenes`
- 返回场景列表（default / blog-publish / hello-world 等）
- 模型总结每个场景的用途

### 验证 7：端到端流水线触发

```
帮我在 owner/repo 仓库触发一个流水线，issue #12，任务是"实现用户登录功能"
```

期望流程：
1. 模型调 `grape_list_scenes()` → 确认场景
2. 模型调 `grape_trigger_pipeline(repository="owner/repo", issue_number="12", account="owner/repo", context="实现用户登录功能")`
3. 返回 `{"event_seq": 85, "status": "ok"}`
4. 模型调 `grape_wait_task(event_seq=85, timeout=300)`
5. 等待流水线完成
6. 模型向用户汇报最终结果

### 验证 8：错误场景

| 测试 | 方法 | 期望 |
|------|------|------|
| token 无效 | 设置错误的 GRAPE_API_TOKEN | 工具返回 401 错误，模型提示用户 |
| Grape 不可达 | 停止 Grape 服务 | 工具返回连接错误，模型提示 Grape 不可用 |
| 不存在的仓库 | list_issues(owner="nonexistent") | 返回空列表或 404 |
| 不存在的 event_seq | get_task_status(event_seq=99999) | 返回 404 或空 |

### 验证 9：等待超时

```
触发一个流水线，但只等 5 秒
```

期望：
- `wait_task` 在 5 秒后超时
- 返回当前状态（如 running）
- 模型告诉用户"流水线还在跑，可以稍后用 grape_get_task_status 查看"

## 5. 实施顺序

```
Step 1-3:   初始化项目 + package.json + tsconfig.json
Step 4-5:   类型定义 + HTTP 客户端
Step 6-9:   四组工具实现（scenes / repos / pipeline / issues）
Step 10:    插件入口
Step 11:    编译
验证 1:     tsc --noEmit 编译检查
验证 2:     Grape API 连通性测试
Step 12:    dsh 挂载配置
验证 3:     dsh 启动 + 插件加载
验证 4:     工具列表确认
验证 5-6:   只读工具调用
验证 7:     端到端流水线触发
验证 8-9:   错误场景
```
