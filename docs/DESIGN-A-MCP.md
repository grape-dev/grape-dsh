# 方案 A：MCP Server — 完整技术框架

## 1. 一句话方案

在 Grape 服务端新增一个 MCP Server 端点（Python），把 Grape 的流水线能力暴露为 MCP 工具。dsh 通过内置的 `dsh-mcp-client` 连接这个 MCP Server，模型即可在对话中调用 Grape 流水线。dsh 侧零代码，纯 YAML 配置。

## 2. 为什么是 MCP

### 2.1 插件的本质回顾

插件 = 契约（接口）+ 注册（发现）+ 调度（宿主调插件）+ 隔离（边界）。

MCP（Model Context Protocol）是 Anthropic 提出的开放协议，它定义了 LLM agent 与外部工具之间的标准契约。MCP Server 暴露工具列表和 schema，MCP Client（宿主）发现并注册这些工具，模型在对话中决定调用哪个工具，宿主执行调用并返回结果。

这和 dsh 的插件体系完全对齐：

| 插件四要素 | MCP 对应 |
|-----------|----------|
| 契约 | MCP 协议（JSON-RPC 2.0，工具 schema 声明） |
| 注册 | `tools/list` → 宿主自动注册 `mcp__<server>__<tool>` |
| 调度 | 模型决定调用 → 宿主发 `tools/call` → server 执行 → 结果返回 |
| 隔离 | stdio（子进程）或 streamable-http（网络边界） |

### 2.2 dsh 原生支持 MCP

dsh 内置 `@deepseek-ai/dsh-mcp-client` 包，支持两种 transport：

- **stdio**：本地子进程，dsh spawn MCP server 进程，通过 stdin/stdout JSON-RPC 通信
- **streamable-http**：远程 HTTP 服务，dsh 通过 HTTP 请求调用 MCP server

配置后 MCP server 的工具自动出现在模型工具列表中，命名格式 `mcp__<serverName>__<toolName>`，例如 `mcp__grape__trigger_pipeline`。

### 2.3 对比路径 B（Tool 插件）

| 维度 | 方案 A（MCP） | 方案 B（Tool 插件） |
|------|--------------|-------------------|
| dsh 侧代码 | 零，纯 YAML | TypeScript npm 包 |
| Grape 侧代码 | 新增 MCP server endpoint | 零 |
| 语言 | 全 Python | TypeScript + Python |
| dsh 生态融入 | 工具名带 `mcp__` 前缀 | 原生工具名 |
| 凭据管理 | MCP server 自己管 | dsh credentials 注入 |
| 进度反馈 | MCP progress notification | 工具 execute 同步返回 |
| 维护成本 | 低（一个 Python 模块） | 中（TS 包 + 版本同步） |

## 3. MCP 协议基础

### 3.1 通信模型

MCP 基于 JSON-RPC 2.0，支持两种传输层：

```
stdio transport:
  dsh (MCP client)
    │ stdin/stdout (JSON-RPC line-delimited)
    ▼
  grape MCP server (子进程)

streamable-http transport:
  dsh (MCP client)
    │ HTTP POST (JSON-RPC in body)
    ▼
  grape MCP server (HTTP endpoint)
```

### 3.2 核心交互流程

```
1. 连接建立
   client → server: initialize({ protocolVersion, capabilities, clientInfo })
   server → client: { protocolVersion, capabilities, serverInfo }

2. 工具发现
   client → server: tools/list()
   server → client: { tools: [{ name, description, inputSchema }, ...] }

3. 工具调用
   client → server: tools/call({ name, arguments })
   server → client: { content: [{ type: "text", text: "..." }], isError: false }

4. （可选）进度通知
   server → client: notifications/progress({ progressToken, progress, total, message })

5. （可选）资源发现
   client → server: resources/list()
   server → client: { resources: [{ uri, name, description }, ...] }

6. （可选）资源读取
   client → server: resources/read({ uri })
   server → client: { contents: [{ uri, text }] }
```

### 3.3 工具 schema 格式

MCP 工具的 `inputSchema` 使用 JSON Schema：

```json
{
  "name": "grape_trigger_pipeline",
  "description": "Trigger a Grape DevOps pipeline for a repository issue.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "repository": { "type": "string", "description": "owner/repo" },
      "issue_number": { "type": "string", "description": "Issue number" },
      "context": { "type": "string", "description": "Additional context" }
    },
    "required": ["repository", "issue_number"]
  }
}
```

### 3.4 工具返回格式

```json
{
  "content": [
    { "type": "text", "text": "Pipeline triggered. Event seq: 85, agent: vod, status: running." }
  ],
  "isError": false
}
```

## 4. Grape MCP Server 设计

### 4.1 Transport 选择：streamable-http

理由：
- Grape 已经是 FastAPI 服务，加一个 HTTP 端点最自然
- 不需要 dsh 所在机器安装 grape CLI 或 Python 环境
- 支持远程部署（dsh 和 Grape 可以在不同机器上）
- stdio 需要子进程管理，streamable-http 更简单

### 4.2 端点位置

```
POST /mcp    — MCP streamable-http 端点
```

挂在 Grape FastAPI 的 `src/api/main:app` 上，和现有 API 共享进程、共享数据库、共享认证体系。

### 4.3 架构图

```
┌─────────────────────────────────────────────────────┐
│  dsh agent (DeepSeek V4.1 模型)                      │
│                                                       │
│  对话 → 模型看到工具列表（含 mcp__grape__* 工具）     │
│       → 模型选择调用 mcp__grape__trigger_pipeline     │
│       → dsh MCP client 发 tools/call                  │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  dsh-mcp-client (内置)                           │ │
│  │                                                   │ │
│  │  transport: streamable-http                      │ │
│  │  url: http://grape-host:8000/mcp                 │ │
│  │  headers: { Authorization: Bearer *** }          │ │
│  │                                                   │ │
│  │  工具发现：tools/list → 注册到 ctx.tools          │ │
│  │  工具调用：tools/call → HTTP POST → 解析结果      │ │
│  └──────────────────────┬──────────────────────────┘ │
│                         │ HTTP POST (JSON-RPC)        │
└─────────────────────────┼─────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────┐
│  Grape 服务端 (FastAPI)                               │
│                                                       │
│  POST /mcp  ← MCP streamable-http endpoint           │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  MCP Server (Python, mcp SDK)                    │ │
│  │                                                   │ │
│  │  认证：Bearer token（复用 Grape JWT）              │ │
│  │  工具实现：内部调 Grape 业务函数 / API              │ │
│  │                                                   │ │
│  │  工具集：                                          │ │
│  │   - trigger_pipeline  → POST /api/a2a             │ │
│  │   - get_task_status   → 查 events 表              │ │
│  │   - wait_task         → 轮询 events 表            │ │
│  │   - list_issues       → GET /api/issues           │ │
│  │   - get_issue_detail  → GET /api/issues/detail    │ │
│  │   - get_pipeline_info → GET /api/issues/pipeline  │ │
│  │   - list_events       → GET /api/events           │ │
│  │   - read_repo_file    → GET /api/git-repo/contents│ │
│  │   - list_knowledge    → GET /api/knowledge        │ │
│  │   - create_comment    → POST git-repo comments    │ │
│  │   - list_commands     → grape CLI 契约发现         │ │
│  │                                                   │ │
│  │  资源（可选）：                                     │ │
│  │   - grape://repo/{owner}/{repo}     → 仓库摘要     │ │
│  │   - grape://issue/{owner}/{repo}/{n} → issue 全文  │ │
│  │   - grape://pipeline/{owner}/{repo}/{n} → 流水线状态│ │
│  └──────────────────────┬──────────────────────────┘ │
│                         │                             │
│  ┌──────────────────────▼──────────────────────────┐ │
│  │  Grape 业务层（已有，不改）                        │ │
│  │                                                   │ │
│  │  A2A API / tasks / issues / events / git-repo    │ │
│  │  SQLite/MySQL / 流水线引擎 / 技能体系              │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 4.5 工具集设计

#### 设计原则：只触发，只观察，不干预中间过程

dsh 对 Grape 流水线的操作边界严格限定为：
- **触发**：把任务丢给 Grape，Grape 内部自己跑完整链路
- **观察**：查状态、等结果、看有哪些 issue 在跑流水线
- **不干预**：流水线节点间交接（A2A）由 Grape 内部 pipelines.json 驱动，不对外暴露

工具集精简为 5 个，全部 `[Grape-unique]`：

#### 4.5.1 Core workflows（触发与等待）

**`trigger_pipeline`** [Grape-unique]
- 描述：Trigger a Grape DevOps pipeline by creating an A2A handoff to the first pipeline node (usually vod). This is Grape's multi-agent pipeline orchestration — no alternative in dsh. Pipeline node-to-node handoff is managed internally by Grape, not controllable from outside.
- 参数：
  ```json
  {
    "repository": "string — owner/repo",
    "issue_number": "string — issue number",
    "account": "string — account identity (usually owner/repo)",
    "context": "string — task description / context for the agent",
    "agent": "string, optional — target agent (default: vod)"
  }
  ```
- 实现：调 `POST /api/a2a`，body = `{"agent": agent, "payload": {repository, account, issue_number, context}}`
- 返回：`{"event_seq": 85, "agent": "vod", "status": "running", "message": "Pipeline triggered. VOD agent is analyzing the requirement."}`

**`get_task_status`** [Grape-unique]
- 描述：Get the current status of a pipeline task by event sequence number. Queries Grape's internal events table — not accessible from outside Grape.
- 参数：`{"event_seq": "number — event sequence number"}`
- 实现：查 events 表 `SELECT status, agent_type, summary, result FROM events WHERE seq = ?`
- 返回：`{"status": "completed", "agent": "vod", "summary": "需求分析完成，已交接给 issue 节点", "result": "..."}`

**`wait_task`** [Grape-unique]
- 描述：Poll a task until it reaches a terminal state (completed/failed/cancelled) or timeout. Monitors Grape's internal pipeline execution.
- 参数：`{"event_seq": "number", "timeout": "number, optional — seconds (default 120)", "interval": "number, optional — poll interval (default 3)"}`
- 实现：循环查 events 表，每 interval 秒一次，直到终态或超时
- 返回：`{"status": "completed", "agent": "issue", "summary": "...", "duration_seconds": 45}`
- 进度通知：每次轮询时发 `notifications/progress`（如果客户端支持）

#### 4.5.2 Pipeline Context（流水线状态查询）

**`get_pipeline_info`** [Grape-unique]
- 描述：Get the pipeline configuration and current node status for an issue. Grape-only data — pipeline node states are not on GitCode.
- 参数：`{"owner": "string", "repo": "string", "number": "string"}`
- 实现：调 `GET /api/issues/pipeline`
- 返回：`{"scene": "default", "nodes": [{"tag": "vod", "status": "completed"}, {"tag": "issue", "status": "running"}, ...]}`

**`list_issues`** [Grape-unique]
- 描述：List issues for a repository with Grape pipeline status. Includes pipeline state that GitCode API does not have. If you only need raw issue list and have your own GitCode token, use GitCode API directly instead.
- 参数：`{"owner": "string", "repo": "string", "state": "string, optional — open/closed/all (default: open)"}`
- 实现：调 `GET /api/issues/list?owner=...&repo=...`
- 返回：`[{"number": 7, "title": "...", "state": "open", "pipeline_status": "running"}, ...]`

#### 已移除的工具及原因

| 工具 | 移除原因 |
|------|---------|
| `a2a_handoff` | A2A 是流水线内部节点间调度，外部直接调用会破坏节点顺序，跳过必要环节 |
| `get_issue_detail` | 与 get_pipeline_info 重叠，pipeline_info 已含节点状态 |
| `get_issue_events` | 事件历史是 Grape 内部运维数据，dsh 不需要 |
| `list_knowledge` / `get_knowledge_detail` | 知识库是 Grape 平台内部数据，dsh 不需要 |
| `read_repo_file` / `list_repo_tree` / `create_comment` | [Proxy] 代理 GitCode 操作，dsh 有自己的 token 时自己做，不该通过 Grape 绕 |
| `commands_list` / `refresh_contract` | CLI 调试工具，不该暴露给模型 |

### 4.6 认证设计

#### Token 流程

dsh 不是 Grape 流水线内部的 agent，不会被 event_pipeline.py 注入 `tk_` 会话 token。dsh 是外部调用者，代表一个用户操作 Grape。

使用用户级 API Key（`grape_` 前缀）：

```
一次性配置（用户做一次）：
  1. 用户登录 Grape Web → 设置页 → 创建 API Key → 拿到 grape_xxxx
  2. 用户在 dsh credentials 系统填入这个 token

每次对话时（自动，用户不感知）：
  3. dsh agent 启动对话 → dsh 从 credentials 读出 token
  4. 模型调用 mcp__grape__trigger_pipeline
  5. dsh MCP client 带 Authorization: Bearer grape_xxxx 请求 Grape /mcp
  6. Grape MCP server 验证 token → 确认用户身份 → 执行
  7. Grape 内部用仓库绑定的 GitCode token 操作代码仓（不需要 dsh 关心）
```

dsh 配置中注入 token：

```yaml
- id: mcp-grape
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: grape
    transport: streamable-http
    url: http://grape-host:8000/mcp
    headers:
      Authorization: 'Bearer ${GRAPE_API_TOKEN}'
```

#### Token 类型选择

| Token | 前缀 | 来源 | 适用 dsh | 说明 |
|-------|------|------|---------|------|
| 用户级 API Key | `grape_` | 用户在 Grape Web 手动创建 | ✅ | 长期有效，代表用户身份，可吊销 |
| 会话级 token | `tk_` | Grape 流水线内部签发 | ❌ | 绑定 task+repo，6h 过期，dsh 不是内部 agent 拿不到 |

`grape_` token 是 `user_only` 作用域，部分 `session_only` 端点（git-repo / tasks current）会返回 403。MCP server 的工具实现需要处理这个限制：
- 只读查询（issues/events/knowledge/pipeline）走 `dual` API，`grape_` token 可用
- 仓库操作（git-repo contents/tree）是 `session_only`，`grape_` token 会 403
- 解决方案：MCP server 在同进程内直接调业务函数绕过 HTTP token 作用域检查，但 `/mcp` 端点入口仍然验证 `grape_` token 确认用户身份

#### 代码仓操作的身份链

dsh 不需要关心代码仓的 GitCode token。Grape 内部有自己的身份链：

```
dsh agent（带 grape_ token）
  → Grape MCP server 验证 grape_ token → 确认用户身份
    → 触发流水线
      → Grape 内部用仓库绑定的 GitCode bot token / 用户 OAuth token
        → clone 仓库、写代码、提交 PR
```

用户在 Grape Web 托管仓库时已经授权了 GitCode OAuth，Grape 把凭据存在自己的数据库里。dsh 只需要 `grape_` token 证明"我是这个用户"，剩下的由 Grape 内部处理。

### 4.7 错误处理

MCP 工具返回错误的方式：

```json
{
  "content": [
    { "type": "text", "text": "Authentication failed: token expired. Re-inject GRAPE_SESSION_TOKEN." }
  ],
  "isError": true
}
```

| 场景 | MCP server 返回 |
|------|----------------|
| Token 无效 | isError=true, message="Authentication failed: token expired" |
| Grape 内部错误 | isError=true, message="Pipeline engine error: ..." |
| 流水线超时 | isError=true, message="wait_task timeout (>120s), current status: running" |
| 仓库不存在 | isError=true, message="Repository not found: owner/repo" |
| 权限不足 | isError=true, message="403: session token rejected for this scope, use API token" |

## 5. 实现方案

### 5.1 MCP Python SDK

使用官方 `mcp` Python 包（v2.3.0，PyPI 可装）。

```bash
pip install mcp
```

### 5.2 代码结构

在 Grape 仓库中新增：

```
src/api/routes/
  mcp.py              — MCP server 端点 + 工具定义
src/api/mcp_server.py  — MCP server 逻辑（工具实现、认证、资源）
```

### 5.3 MCP Server 核心代码框架

```python
# src/api/mcp_server.py
"""Grape MCP Server — 把 Grape 流水线能力暴露为 MCP 工具。"""
import json
from mcp.server import Server
from mcp.types import Tool, TextContent, Resource
from src.api.jwt_utils import verify_token
from src.api.a2a import trigger_a2a
from src.api.routes.issues import list_issues, get_issue_detail
from src.api.routes.events import get_events, get_event_detail
from src.api.routes.git_repo import get_contents, get_tree, create_comment
from src.api.routes.knowledge import list_knowledge, get_knowledge

server = Server("grape")

# ── 认证 ──
_auth_token: str = ""

def set_auth(token: str):
    global _auth_token
    _auth_token = token

def _check_auth() -> bool:
    if not _auth_token:
        return False
    return verify_token(_auth_token) is not None


# ── 工具列表 ──
@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="trigger_pipeline",
            description="Trigger a Grape DevOps pipeline by creating an A2A handoff.",
            inputSchema={
                "type": "object",
                "properties": {
                    "repository": {"type": "string", "description": "owner/repo"},
                    "issue_number": {"type": "string", "description": "Issue number"},
                    "account": {"type": "string", "description": "Account identity"},
                    "context": {"type": "string", "description": "Task context"},
                    "agent": {"type": "string", "description": "Target agent (default: vod)"},
                },
                "required": ["repository", "issue_number", "account", "context"],
            },
        ),
        Tool(
            name="get_task_status",
            description="Get the status of a pipeline task by event sequence number.",
            inputSchema={
                "type": "object",
                "properties": {
                    "event_seq": {"type": "number", "description": "Event sequence number"},
                },
                "required": ["event_seq"],
            },
        ),
        Tool(
            name="wait_task",
            description="Poll a task until terminal state or timeout.",
            inputSchema={
                "type": "object",
                "properties": {
                    "event_seq": {"type": "number"},
                    "timeout": {"type": "number", "description": "Max wait seconds (default 120)"},
                    "interval": {"type": "number", "description": "Poll interval (default 3)"},
                },
                "required": ["event_seq"],
            },
        ),
        # ... 更多工具
    ]


# ── 工具调用 ──
@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if not _check_auth():
        return [TextContent(type="text", text="Authentication failed: token invalid or expired")]

    try:
        if name == "trigger_pipeline":
            result = await trigger_a2a(
                agent=arguments.get("agent", "vod"),
                payload={
                    "repository": arguments["repository"],
                    "account": arguments["account"],
                    "issue_number": arguments["issue_number"],
                    "context": arguments["context"],
                },
            )
            return [TextContent(
                type="text",
                text=json.dumps(result, ensure_ascii=False, indent=2)
            )]

        elif name == "get_task_status":
            seq = arguments["event_seq"]
            result = await get_event_detail(seq)
            return [TextContent(
                type="text",
                text=json.dumps(result, ensure_ascii=False, indent=2)
            )]

        elif name == "wait_task":
            seq = arguments["event_seq"]
            timeout = arguments.get("timeout", 120)
            interval = arguments.get("interval", 3)
            result = await _poll_until_terminal(seq, timeout, interval)
            return [TextContent(
                type="text",
                text=json.dumps(result, ensure_ascii=False, indent=2)
            )]

        # ... 更多工具分支

    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]


# ── 资源（可选 Phase 2）──
@server.list_resources()
async def list_resources() -> list[Resource]:
    return [
        Resource(
            uri="grape://repos",
            name="Managed Repositories",
            description="List all repos managed by Grape",
        ),
    ]

@server.read_resource()
async def read_resource(uri: str) -> str:
    # 解析 URI，返回对应内容
    ...
```

### 5.4 FastAPI 端点集成

```python
# src/api/routes/mcp.py
"""MCP streamable-http endpoint，挂在 Grape FastAPI 上。"""
from fastapi import APIRouter, Request, Response
from mcp.server import Server
from src.api.mcp_server import server, set_auth

router = APIRouter()

@router.post("/mcp")
async def mcp_endpoint(request: Request):
    # 1. 提取认证
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    set_auth(token)

    # 2. 解析 JSON-RPC 请求
    body = await request.json()

    # 3. 交给 MCP server 处理
    response = await server.handle_request(body)

    # 4. 返回 JSON-RPC 响应
    return Response(
        content=json.dumps(response),
        media_type="application/json",
    )
```

在 `src/api/main.py` 中挂载：

```python
from src.api.routes.mcp import router as mcp_router
app.include_router(mcp_router)
```

### 5.5 dsh 侧配置

一行 YAML，无代码：

```yaml
# ~/.dsh/profiles/my-profile/cordis.patch.yml
- id: mcp-grape
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: grape
    transport: streamable-http
    url: http://grape-host:8000/mcp
    headers:
      Authorization: 'Bearer ${GRAPE_SESSION_TOKEN}'
    toolCallTimeoutMs: 120000    # 流水线操作可能较长
    failOnStartupError: false    # Grape 不可用时不阻止 dsh 启动
    reconnect:
      enabled: true
      initialDelayMs: 1000
      maxDelayMs: 30000
      maxAttempts: 10
```

环境变量：
```bash
export GRAPE_SESSION_TOKEN=tk_xxx   # dsh 注入给 MCP client
```

## 6. 同步等待机制

### 6.1 问题

Grape 的 A2A API 是 fire-and-forget——`POST /api/a2a` 立即返回 `{"status":"ok","seq":85}`，不等待流水线执行完毕。但 dsh 模型调用工具时，期望工具返回最终结果。

### 6.2 方案：MCP server 内部轮询

MCP server 的 `wait_task` 工具在内部循环轮询 events 表，直到流水线到达终态：

```python
async def _poll_until_terminal(seq: int, timeout: int, interval: int) -> dict:
    import time
    terminal = {"completed", "failed", "cancelled"}
    deadline = time.time() + max(0, timeout)
    while True:
        event = await get_event_detail(seq)
        status = event.get("status", "")
        if status in terminal or time.time() >= deadline:
            return event
        await asyncio.sleep(interval)
```

### 6.3 两步调用模式

模型分两步操作：
1. 调 `trigger_pipeline` → 立即返回 seq（fire-and-forget）
2. 调 `wait_task` → 阻塞等待结果

这和 grape CLI 的 `a2a handoff` + `tasks wait` 模式完全一致。

### 6.4 可选增强：progress notification

MCP 协议支持进度通知。`wait_task` 轮询时每次可以发 `notifications/progress`：

```python
# 每次轮询后推送进度
await server.send_progress(
    progress_token=progress_token,
    progress=current_step,
    total=total_steps,
    message=f"Agent {event['agent_type']} is {event['status']}..."
)
```

dsh 的 `agent/assistant-stream` 会把进度实时推到前端 UI。但不是所有 MCP client 都支持 progress notification，Phase 1 先用同步轮询。

## 7. 契约驱动工具生成（Phase 3 增强）

### 7.1 问题

Phase 1 手工定义工具列表。Grape 服务端新增 API 后，MCP server 的工具列表不会自动更新。

### 7.2 方案：从 OpenAPI 契约自动生成工具

Grape 已有 `/openapi.json` 契约。MCP server 启动时（或收到 `tools/list` 请求时）读取契约，自动生成工具列表：

```python
@server.list_tools()
async def list_tools() -> list[Tool]:
    # 1. 读 Grape OpenAPI 契约
    schema = load_openapi_schema()

    # 2. 解析 operationId → 工具名
    tools = []
    for path, methods in schema.get("paths", {}).items():
        for method, op in methods.items():
            if not op.get("operationId"):
                continue
            oid = op["operationId"]
            if "api_" in oid:  # 过滤自动生成的噪音
                continue

            # 3. operationId → 工具名：tasks_mine → tasks_mine
            tool_name = oid.replace("_", "_")  # 保持下划线

            # 4. 解析参数 → inputSchema
            input_schema = _build_input_schema(op, schema)

            # 5. 解析 summary → description
            description = op.get("summary", f"{method.upper()} {path}")

            tools.append(Tool(
                name=tool_name,
                description=description,
                inputSchema=input_schema,
            ))

    return tools
```

这和 grape CLI 的 `registry.py` 用完全相同的思路（operationId → 命令树），只是输出从 click 命令变成 MCP 工具 schema。

### 7.3 优势

- 服务端新增 API → MCP server 自动获得新工具
- 零维护——不需要手工同步工具列表
- 和 grape CLI 的契约驱动理念一致

## 8. 实施计划

### Phase 1：MCP Server 核心（最小可用）

1. `pip install mcp` 到 Grape venv
2. 创建 `src/api/mcp_server.py`——MCP server 实例 + 工具定义
3. 实现核心工具（5 个）：
   - `trigger_pipeline`（调 A2A API）
   - `get_task_status`（查 events 表）
   - `wait_task`（轮询 events 表）
   - `list_issues`（调 issues API）
   - `get_issue_detail`（调 issues API）
4. 创建 `src/api/routes/mcp.py`——FastAPI 端点 `/mcp`
5. 在 `main.py` 挂载路由
6. 认证：从 `Authorization` 头提取 token，复用 JWT 验证

### Phase 2：完整工具集 + 资源

7. 扩展工具集到 15+ 个（加上 events/pipeline/knowledge/git-repo/comments）
8. 实现 MCP resources（`grape://repo/*`、`grape://issue/*` 等 URI）
9. 错误处理完善：所有工具统一 try/except → isError 返回

### Phase 3：契约驱动 + 进度通知

10. 从 OpenAPI 契约自动生成工具列表（替代手工定义）
11. `wait_task` 发 progress notification
12. `tools/list` 支持增量更新（MCP `notifications/tools/list_changed`）

### Phase 4：验证与部署

13. dsh 配置 `cordis.patch.yml` 挂载 `dsh-mcp-client`
14. `dsh --profile web` 启动，确认 `mcp__grape__*` 工具出现在模型工具列表
15. 对话测试：模型触发流水线 → 等待 → 结果返回
16. 部署到测试环境（build-0001 等）

## 9. 文件清单

```
Grape 仓库（src/api/）：
├── mcp_server.py              — MCP server 实例 + 工具定义 + 工具实现
├── routes/
│   └── mcp.py                 — FastAPI /mcp 端点
└── main.py                    — 挂载 mcp_router（一行改动）

dsh 侧（纯配置）：
└── ~/.dsh/profiles/<profile>/cordis.patch.yml    — 挂载 dsh-mcp-client

依赖：
└── pip install mcp    — MCP Python SDK（加到 requirements.txt）
```

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| MCP SDK API 变更 | 工具定义代码需要适配 | 锁定 mcp 版本（`mcp>=2.3.0`） |
| streamable-http 兼容性 | dsh MCP client 版本可能不支持 | dsh 文档确认支持，fallback 到 stdio |
| 长时间轮询占用连接 | HTTP 连接长时间不返回 | `wait_task` 设默认 timeout=120s，超时返回当前状态 |
| Grape 服务重启 | MCP 连接断开 | dsh `reconnect.enabled=true` 自动重连 |
| Token 过期 | 工具调用 401 | isError 返回，模型提示用户重新注入 |
| 工具过多模型选择困难 | 模型在 15+ 工具中选错 | 工具描述精确，按场景分组命名 |

## 11. 参考文档

| 文档 | URL/路径 |
|------|----------|
| MCP 协议规范 | https://modelcontextprotocol.io/specification |
| MCP Python SDK | https://pypi.org/project/mcp/ |
| dsh MCP 子系统 | deepseek-harness/docs/subsystems/mcp.zh.md |
| dsh MCP client | deepseek-harness/packages/mcp/mcp-client/README.md |
| dsh 架构 | deepseek-harness/docs/architecture.zh.md |
| Grape CLI | gitcode.com/grape-dev/grape-cli.git |
| Grape 服务端 | gitcode.com/grape-dev/grape.git |
