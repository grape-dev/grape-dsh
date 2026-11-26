# 方案对比与决策

## 最终决策：方案 B（Cordis 原生插件）为主方案

### 决策理由

方案 B 的核心优势在于控制力——工具调用经过 dsh 内部流水线（pre-execute → execute → post-execute），dsh 能拦截、能审计、能管理凭据、能渲染 UI。这对实际使用场景更有价值：

| 场景 | 方案 A（MCP） | 方案 B（Cordis 插件） |
|------|--------------|---------------------|
| 模型选工具 | 工具名带 `mcp__grape__` 前缀，和别的 MCP 工具混在一起 | 工具名 `grape_trigger_pipeline`，和原生工具同级 |
| 危险操作确认 | 拦不住，MCP server 直接执行 | `tools/pre-execute` 瀑布可弹确认 |
| 进度展示 | 返回 JSON 文本，模型复述 | 可注册 ConversationNodeDefinition 渲染进度卡片 |
| Token 管理 | 过期需手动改 YAML 重启 | dsh credentials 系统自动管理/续期 |
| 审计日志 | HTTP 黑盒，只记请求和结果 | `tools/post-execute` 钩子完整记录调用链 |
| 权限控制 | 不可拦截 | `tools/pre-execute` 可做细粒度权限 |

### 方案 A 保留为备选

方案 A（MCP Server）的优势是跨平台和零 TypeScript 代码。如果后续需要让 Grape 同时服务 Claude Desktop / Cursor / Codex 等 MCP agent，可以再实现 MCP server。两个方案不互斥——Grape 可以同时有 MCP endpoint 和 Cordis 插件。

## 实现期追加决策：工具传输走 HTTP，不 spawn CLI

**决策（2026-10-14 补记）：** 插件的 9 个工具全部通过 `GrapeClient`（`src/client.ts`，基于 `fetch`）直连 Grape HTTP API，**不 spawn `grape` CLI 子进程**。

**背景：** `DESIGN.md` 最初写的是「dsh tool execute: spawn grape CLI 子进程」，理由是「dsh 的 agent 后端体系天然是 CLI 子进程模型（opencode/hermes/codex 均如此）」。实现阶段改成了 HTTP 客户端（`IMPLEMENTATION.md` Step 5「src/client.ts — Grape HTTP 客户端（fetch + token 注入）」），但本文件此前**未记录该变更** —— 现补记。

**决策理由：**

1. **CLI 不带来任何额外能力。** CLI 是按 OpenAPI `operationId` 契约生成的命令树（`grape refresh` 自动跟进新接口），命令内部走 httpx 调**同一批** HTTP 端点。`DESIGN.md` 自己也写明「CLI 是 API 薄包装——所有命令内部走 httpx 调 Grape HTTP API」。换 CLI = 多一层子进程包裹，端点集合不变。
2. **换来的是额外依赖与故障面。** 需在 dsh 运行环境安装 Python CLI；需解析 stdout JSON；需处理退出码语义（0/1/2/≥400/130）；需把 `exec.signal` 的取消转成子进程 kill。HTTP 版直接拿到已解析对象，`signal` 直接传给 `fetch`。
3. **「dsh 后端都是 spawn CLI」的类比不成立。** 那句话指 opencode/hermes/codex 作为**模型驱动后端**；传输方式是**工具实现内部细节**。dsh 的关键优势（`tools/pre-execute` 拦截、`post-execute` 审计、UI 渲染、凭据管理）取决于插件形态是 Cordis 原生插件，与传输方式无关 —— 走 HTTP 无损失。

**CLI 独有命令为何用不上（记录以免日后重复评估）：** `grape a2a handoff` / `knowledge list` / `git-repo contents|tree` / `git <any>` 属**设计上明确排除**（A2A 不对外暴露、不代理 GitCode 操作、Grape 内部数据）；`grape tasks current|complete` 需要 `tk_` 会话 token，而该 token 由流水线引擎内部签发、dsh 拿不到。**卡点是 token 模型，不是传输方式** —— 改用 CLI 也解锁不了这些。

#### 上述结论的代码级依据（2026-10-14 核查，避免日后重新排查）

**1. tk_ 只能由 Grape 内部签发，共 3 处调用点，全在内部：**

| 位置 | 场景 | session_key | user_id |
|------|------|-------------|---------|
| `src/api/event_pipeline.py:3175` | 流水线起 agent | `task_id` 或 `d_{seq}` | **0** |
| `src/runtime/service.py:802` | runtime 起 agent | task 绑定 | — |
| `src/api/routes/chat.py:544`（`:543` 为 import 行） | 起 Chat Agent | `conv:{conv_id}` | 真实 user_id |

> ⚠️ 行号随源码演进会漂移，本表以 2026-10-14 的 `/root/grape` 为准。重查一行搞定：
> `grep -n 'GRAPE_SESSION_TOKEN"\] = issue_session_token' src/api/event_pipeline.py src/runtime/service.py src/api/routes/chat.py`

`issue_session_token()` 定义在 `src/api/auth_token.py:37`：

```
issue_session_token(*, session_key, repo_key, agent_type, user_id=0, ttl=SESSION_TOKEN_TTL)
# 明文（仅注入 env，不落盘）        ← 源码注释原文
# 明文的 sha256 落 session_api_tokens
```

绑定维度是 `repo_key + agent_type + session_key(task_id/conv_id)` —— 属**agent 的窄身份**，不是"用户 session"。

**2. 没有任何端点把 tk_ 交回给调用方**：签发只发生在服务端**启动 agent** 的那一刻，明文只进该子进程的 `env`。路由模块内确实有签发调用（`src/api/routes/chat.py:543-544`），但它是 Chat Agent 启动路径的一部分，token 同样只进 agent 的 env、不进 HTTP 响应。`GRAPE_SESSION_TOKEN` 在 `src/` 的全部出现可归三类：① 子进程 env 注入（上表 3 处）；② 注释与契约文案（`event_pipeline.py`、`tasks.py`、`webhook.py`、`agent/executor.py`）；③ prompt 指令（`prompt_builder.py` 明确要求 agent 不得读取/猜测平台 token）。**没有任何一处写入 HTTP 响应体。** → 用 `grape_` API Key「换一个 tk_」的路径**不存在**（不存在这种端点），不是权限不足的问题。

**3. 反过来，有一批接口硬门禁只认 tk_，`grape_` 调了就是 403：**

- `/api/git-repo/*` —— `src/api/git_repo_api.py:85` 注释「⚠️ 本接口**仅服务会话级临时 token（tk_）**——用户级 API Key（`grape_`）/ Web JWT **不适用**（403）」；`:93` 实现 `if user.get("auth_type") != "session_token": raise HTTPException(403, "Git 仓库接口仅支持会话级临时 token（agent 专用）…")`
- `/api/tasks/current`（`src/api/routes/tasks.py`）—— 契约描述即 "**Session-only (tk_); API key/JWT -> 403**"，:389 注明「仅会话通道：`auth_type` 必须为 `session_token`」

**结论：** 即便在 dsh 端装上 grape CLI，`grape git-repo contents|tree`、`grape tasks current|complete` 用 `grape_` Key 调用仍会 403 —— 这些能力是被**服务端 token 模型**在设计上关掉的，不是被传输方式（HTTP vs CLI）限制。

**影响：** 后续新增工具（`IMPROVEMENTS.md` 的 A1 `create_issue`、A2 `my_issues` 等）**沿用 HTTP**，不引入子进程。

**验证依据（均为只读实测，2026-10-14）：** 插件源码对 `child_process`/`spawn`/`execFile`/`grape-cli` 零命中；`scenes.ts`/`repos.ts`/`issues.ts` 的全部工具出口为 `client.request()`，`pipeline.ts` 的 `wait_task` 走 `client.pollUntilTerminal()`（同属 GrapeClient）；`src/client.ts:87` 为 `await fetch(...)`；本机未安装 `grape` 命令（CLI 源码在 `/root/grape-cli`，`pyproject.toml` 的 `name` 为 `grape`）。

## 文档索引

| 文件 | 内容 | 状态 |
|------|------|------|
| `DESIGN.md` | 方案 B 完整设计（架构、工具集、实施计划） | ✅ 主方案 |
| `DESIGN-A-MCP.md` | 方案 A 完整技术框架 | ⬜ 备选方案 |
| `IMPROVEMENTS.md` | 改进方案（issue 创建/查看能力补齐 + 状态结构化 UI） | ✅ 待实施 |
| `grape-cli-capabilities.md` | Grape CLI 能力清单 | ✅ 参考 |
| `dsh-plugin-reference.md` | dsh 插件架构速查 | ✅ 参考 |
