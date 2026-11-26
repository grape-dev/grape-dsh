# grape CLI 命令全集清单（按 token 作用域分类 + CLI 可达性）

> 生成时间：2026-10-14 16:25 ｜ 契约版本：`2.1.0`（`GET http://127.0.0.1:8000/openapi.json`）
> 命令名 / 作用域 / 可达性判定**全部复用 CLI 自身代码**（`src/registry.py`），非外部推测。
> `grape refresh` 重建契约后本表需重新生成。

## 一、总量口径（三组数字，别混淆）

| 口径 | 数量 | 说明 |
|------|------|------|
| 契约中的命令名 | 236 | `/openapi.json`（187 paths）解析出的全部命令 |
| **CLI 实际可达** | **221** | 建树后能真正调到的；比上面少 15 条（见 §三） |
| 换 `/static/openapi.json`（200 paths）可达 | 224 | 比 `/openapi.json` 多 3 条：grape auth me、grape auth transfer context、grape auth update profile |

## 二、按 token 作用域分布

| 作用域 | 命令数 | 含义 | dsh（持 `grape_` API Key） |
|--------|-------|------|----------------------------|
| `dual` | 40 | 两通道皆可（`tk_` 会话 token **或** `grape_` API Key） | ✅ 可用 |
| `user_only` | 164 | 仅用户级通道（`grape_` API Key / Web JWT）；持 `tk_` 调 → 403 | ✅ 可用（用 `grape_` Key） |
| `session_only` | 32 | 仅会话级 token（`tk_`）；持 `grape_` API Key / JWT 调 → 403 | ❌ 用不上（Grape 内部流转） |
| **合计** | **236** | | |

**dsh 可用（dual + user_only）= 204 条**；**不可用（`tk_` 独占的内部流转）= 32 条**。

## 三、⚠️ CLI 可达性缺陷：契约里有、但 CLI 调不到的 15 条

根因：`src/registry.py::_insert` 用 `node[verb[-1]] = meta` 直接赋值建树，
当 A 的动词链是 B 的**前缀**时（如 `chat send` 与 `chat send async`），短命令后插入会**覆盖整棵子树**。
已实测：`grape chat send stream --help` 落到 `Usage: grape chat send [OPTIONS]`（命令不存在）。

| 丢失的命令 | 覆盖它的前缀命令 | HTTP |
|------------|------------------|------|
| `grape chat conversations create` | `grape chat conversations` | `POST /api/chat/conversations` |
| `grape chat conversations delete` | `grape chat conversations` | `DELETE /api/chat/conversations/{conv_id}` |
| `grape chat conversations ensure issue` | `grape chat conversations` | `POST /api/chat/conversations/ensure-issue` |
| `grape chat send async` | `grape chat send` | `POST /api/chat/send/async` |
| `grape chat send stream` | `grape chat send` | `POST /api/chat/send/stream` |
| `grape events a2a redo scene` | `grape events a2a redo` | `GET /api/events/{seq}/a2a-redo/scene` |
| `grape git-repo contents root` | `grape git-repo contents` | `GET /api/git-repo/{owner}/{repo}/contents` |
| `grape issues list attachments` | `grape issues list` | `GET /api/issues/{issue_id}/attachments` |
| `grape issues pipeline detail` | `grape issues pipeline` | `GET /api/issues/{issue_id}/pipeline` |
| `grape issues status get` | `grape issues status` | `GET /api/issues/{issue_id}/status` |
| `grape repos deploy url set` | `grape repos deploy url` | `PUT /api/repos/deploy-url` |
| `grape runtime machine health detail` | `grape runtime machine health` | `GET /api/runtime/admin/machine-health/{runtime_id}` |
| `grape scenes market experience check` | `grape scenes market experience` | `GET /api/scenes/market/{market_id}/experience-check` |
| `grape settings agent runtimes refresh` | `grape settings agent runtimes` | `POST /api/settings/agent-runtimes/refresh` |
| `grape settings backend agents refresh` | `grape settings backend agents` | `POST /api/settings/backend-agents/refresh` |

## 四、❌ Grape 内部流转命令（`session_only`，dsh 用不上）

这些是 agent 执行期专用：`tk_` 由服务端启动 agent 时签发并注入子进程 env，
用户级 `grape_` API Key 调用一律 403（代码级依据见 `DECISION.md`）。

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape git-repo branches` | `GET /api/git-repo/{owner}/{repo}/branches` | ✅ | List branches |
| `grape git-repo commits` | `GET /api/git-repo/{owner}/{repo}/commits` | ✅ | Commit history |
| `grape git-repo contents` | `GET /api/git-repo/{owner}/{repo}/contents/{path}` | ✅ | Repository contents: dir listing or file content (base64) |
| `grape git-repo contents root` | `GET /api/git-repo/{owner}/{repo}/contents` | ❌ 被覆盖 | Repository contents: root directory listing |
| `grape git-repo issues close` | `POST /api/git-repo/{owner}/{repo}/issues/{number}/close` | ✅ | Close issue |
| `grape git-repo issues comments create` | `POST /api/git-repo/{owner}/{repo}/issues/{number}/comments` | ✅ | Create issue comment |
| `grape git-repo issues comments list` | `GET /api/git-repo/{owner}/{repo}/issues/{number}/comments` | ✅ | List issue comments |
| `grape git-repo issues create` | `POST /api/git-repo/{owner}/{repo}/issues` | ✅ | Create issue |
| `grape git-repo issues get` | `GET /api/git-repo/{owner}/{repo}/issues/{number}` | ✅ | Get issue |
| `grape git-repo issues list` | `GET /api/git-repo/{owner}/{repo}/issues` | ✅ | List issues |
| `grape git-repo issues update` | `PATCH /api/git-repo/{owner}/{repo}/issues/{number}` | ✅ | Update issue |
| `grape git-repo labels create` | `POST /api/git-repo/{owner}/{repo}/labels` | ✅ | Create label |
| `grape git-repo labels list` | `GET /api/git-repo/{owner}/{repo}/labels` | ✅ | List labels |
| `grape git-repo milestones` | `GET /api/git-repo/{owner}/{repo}/milestones` | ✅ | List milestones |
| `grape git-repo pulls comments create` | `POST /api/git-repo/{owner}/{repo}/pulls/{number}/comments` | ✅ | Create PR comment |
| `grape git-repo pulls comments list` | `GET /api/git-repo/{owner}/{repo}/pulls/{number}/comments` | ✅ | List PR comments |
| `grape git-repo pulls create` | `POST /api/git-repo/{owner}/{repo}/pulls` | ✅ | Create pull request |
| `grape git-repo pulls files` | `GET /api/git-repo/{owner}/{repo}/pulls/{number}/files` | ✅ | List PR changed files |
| `grape git-repo pulls get` | `GET /api/git-repo/{owner}/{repo}/pulls/{number}` | ✅ | Get pull request |
| `grape git-repo pulls list` | `GET /api/git-repo/{owner}/{repo}/pulls` | ✅ | List pull requests |
| `grape git-repo pulls merge` | `PUT /api/git-repo/{owner}/{repo}/pulls/{number}/merge` | ✅ | Merge pull request |
| `grape git-repo pulls update` | `PATCH /api/git-repo/{owner}/{repo}/pulls/{number}` | ✅ | Update pull request |
| `grape git-repo repo` | `GET /api/git-repo/{owner}/{repo}` | ✅ | Repository info (clone_url/default_branch) |
| `grape git-repo tree` | `GET /api/git-repo/{owner}/{repo}/tree` | ✅ | Repository tree (single-level; GitHub recursive) |
| `grape issues awaiting-input` | `POST /api/issues/{issue_id}/awaiting-input` | ✅ | Agent declares issue awaiting-input (待澄清) |
| `grape issues pending-review` | `POST /api/issues/{issue_id}/pending-review` | ✅ | Agent declares issue pending_review (阶段审核点) |
| `grape issues review-pass` | `POST /api/issues/{issue_id}/review-pass` | ✅ | Agent decides review passed |
| `grape issues review-reject` | `POST /api/issues/{issue_id}/review-reject` | ✅ | Agent decides review rejected |
| `grape repos git credential` | `GET /api/repos/{owner}/{repo}/git-credential` | ✅ | One-shot git platform credential (CLI internal, TTL) |
| `grape repos workspace` | `GET /api/repos/{owner}/{repo}/workspace` | ✅ | Repository workspace path (local git via CLI) |
| `grape tasks current` | `GET /api/tasks/current` | ✅ | Get current task detail (Agent runtime) |
| `grape tasks notify` | `POST /api/tasks/notify` | ✅ | Task assign/notify (Agent runtime) |

## 五、✅ 可用（用 `grape_` Key） — `user_only`（164 条）

仅用户级通道（`grape_` API Key / Web JWT）；持 `tk_` 调 → 403

### `grape clean`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape agents clean` | `POST /api/agents/{name}/{owner}/{repo}/clean` | ✅ | Clean agent session |
### `grape detail`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape agents detail` | `GET /api/agents/{name}/{owner}/{repo}` | ✅ | Get agent config |
### `grape update`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape agents update` | `PUT /api/agents/{name}/{owner}/{repo}` | ✅ | Update agent config |
### `grape logout`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape auth logout` | `POST /api/auth/logout` | ✅ | Logout (revoke all tokens) |
### `grape profile`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape auth profile` | `GET /api/auth/profile` | ✅ | Get current user profile |
### `grape config`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape chat config get` | `GET /api/chat/config` | ✅ | Get chat config |
| `grape chat config update` | `PUT /api/chat/config` | ✅ | Update chat config |
### `grape conversations`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape chat conversations` | `GET /api/chat/conversations` | ✅ | List conversations |
| `grape chat conversations create` | `POST /api/chat/conversations` | ❌ 被 `chat conversations` 覆盖 | Create conversation |
| `grape chat conversations delete` | `DELETE /api/chat/conversations/{conv_id}` | ❌ 被 `chat conversations` 覆盖 | Delete conversation |
| `grape chat conversations ensure issue` | `POST /api/chat/conversations/ensure-issue` | ❌ 被 `chat conversations` 覆盖 | Ensure issue conversation |
### `grape feedback`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape chat feedback` | `POST /api/chat/feedback` | ✅ | Submit feedback |
### `grape messages`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape chat messages` | `GET /api/chat/messages/{conv_id}` | ✅ | List conversation messages |
### `grape send`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape chat send` | `POST /api/chat/send` | ✅ | Send message |
| `grape chat send async` | `POST /api/chat/send/async` | ❌ 被 `chat send` 覆盖 | Send message (async) |
| `grape chat send stream` | `POST /api/chat/send/stream` | ❌ 被 `chat send` 覆盖 | Send message (SSE stream) |
### `grape submit`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape chat submit` | `POST /api/chat/submit` | ✅ | Submit (task scenario) |
### `grape task`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape chat task status` | `GET /api/chat/task/{task_id}/status` | ✅ | Async task status |
| `grape chat task stream` | `GET /api/chat/task/{task_id}/stream` | ✅ | Async task stream |
### `grape config`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape devstage config get` | `GET /api/devstage/config` | ✅ | Get DevStage config |
| `grape devstage config update` | `PUT /api/devstage/config` | ✅ | Update DevStage config |
### `grape environment`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape devstage environment action` | `POST /api/devstage/environments/{action}` | ✅ | Dev environment start/stop |
| `grape devstage environment create` | `POST /api/devstage/environments` | ✅ | Create dev environment |
| `grape devstage environment delete` | `DELETE /api/devstage/environments/{devstage_id}` | ✅ | Delete dev environment |
### `grape environments`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape devstage environments` | `GET /api/devstage/environments` | ✅ | List dev environments |
### `grape specs`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape devstage specs` | `GET /api/devstage/specs` | ✅ | List available specs |
### `grape templates`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape devstage templates` | `GET /api/devstage/templates` | ✅ | List available templates |
### `grape a2a`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape events a2a redo` | `POST /api/events/{seq}/a2a-redo` | ✅ | A2A redo (manual handoff) |
| `grape events a2a redo scene` | `GET /api/events/{seq}/a2a-redo/scene` | ❌ 被 `events a2a redo` 覆盖 | A2A redo scene info |
### `grape chat`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape events chat delete` | `DELETE /api/events/{seq}/chat` | ✅ | Delete event conversation thread |
| `grape events chat send` | `POST /api/events/{seq}/chat` | ✅ | Send event conversation |
| `grape events chat stream` | `POST /api/events/{seq}/chat/stream` | ✅ | Event conversation SSE |
| `grape events chat submit` | `POST /api/events/{seq}/chat/submit` | ✅ | Submit event conversation (async) |
| `grape events chat task status` | `GET /api/events/chat/task/{task_id}/status` | ✅ | Event conversation async status |
| `grape events chat task stream` | `GET /api/events/chat/task/{task_id}/stream` | ✅ | Event conversation async stream |
### `grape knowledge`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape events knowledge delete` | `DELETE /api/events/{seq}/knowledge/{scope}` | ✅ | Delete issue knowledge |
### `grape redispatch`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape events redispatch` | `POST /api/events/{seq}/redispatch` | ✅ | Redispatch event |
### `grape terminate`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape events terminate` | `POST /api/events/{seq}/terminate` | ✅ | Terminate event |
### `grape thread`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape events thread` | `GET /api/events/{seq}/thread` | ✅ | Event conversation thread |
### `grape onboard`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape feishu onboard cancel` | `POST /api/feishu/onboard/cancel` | ✅ | Cancel Feishu onboarding |
| `grape feishu onboard start` | `POST /api/feishu/onboard/start` | ✅ | Start Feishu scan onboarding |
| `grape feishu onboard status` | `GET /api/feishu/onboard/status` | ✅ | Get Feishu onboarding status |
### `grape cancel`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues cancel` | `POST /api/issues/{issue_id}/cancel` | ✅ | Cancel issue (stop pipeline) |
### `grape clarifications`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues clarifications` | `GET /api/issues/{issue_id}/clarifications` | ✅ | Issue clarification history |
### `grape clarify`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues clarify` | `POST /api/issues/{issue_id}/clarify` | ✅ | Reply issue clarification |
### `grape confirm`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues confirm done` | `POST /api/issues/{issue_id}/confirm-done` | ✅ | Confirm issue done |
### `grape delete`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues delete attachment` | `DELETE /api/issues/{issue_id}/attachments/{filename}` | ✅ | Delete issue attachment |
### `grape pipeline`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues pipeline detail` | `GET /api/issues/{issue_id}/pipeline` | ❌ 被 `issues pipeline` 覆盖 | Issue pipeline roadmap (by issue.id) |
### `grape resume`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues resume` | `POST /api/issues/{issue_id}/resume` | ✅ | Resume cancelled issue |
### `grape start`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues start` | `POST /api/issues/{issue_id}/start` | ✅ | Open issue session |
### `grape status`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues status` | `PUT /api/issues/{issue_id}/status` | ✅ | Update issue status |
### `grape upload`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues upload attachment` | `POST /api/issues/{issue_id}/attachments` | ✅ | Upload issue attachment |
### `grape add`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape knowledge add refs batch` | `POST /api/knowledge/{knowledge_id}/refs/batch` | ✅ | Add knowledge refs (batch) |
### `grape delete`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape knowledge delete` | `DELETE /api/knowledge/{knowledge_id}` | ✅ | Delete knowledge entry |
### `grape entry`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape knowledge entry create` | `POST /api/knowledge/entry` | ✅ | Create knowledge entry |
### `grape ref`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape knowledge ref create` | `POST /api/knowledge/{knowledge_id}/refs` | ✅ | Add knowledge ref |
| `grape knowledge ref delete` | `DELETE /api/knowledge/ref/{ref_id}` | ✅ | Delete knowledge ref |
| `grape knowledge ref update` | `PUT /api/knowledge/ref/{ref_id}` | ✅ | Update knowledge ref |
### `grape refs`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape knowledge refs list` | `GET /api/knowledge/{knowledge_id}/refs` | ✅ | List knowledge refs |
### `grape update`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape knowledge update` | `PUT /api/knowledge/{knowledge_id}` | ✅ | Update knowledge |
### `grape create`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape orgs create` | `POST /api/orgs` | ✅ | 创建组织 |
### `grape detail`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape orgs detail` | `GET /api/orgs/{org_id}` | ✅ | 获取组织详情 |
### `grape leave`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape orgs leave` | `POST /api/orgs/{org_id}/leave` | ✅ | 离开组织 |
### `grape list`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape orgs list` | `GET /api/orgs` | ✅ | 列出当前用户加入的组织 |
### `grape members`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape orgs members list` | `GET /api/orgs/{org_id}/members` | ✅ | 列出组织成员 |
### `grape search`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape orgs search users` | `GET /api/orgs/search/users` | ✅ | 搜索用户（添加成员用） |
### `grape get`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape pipeline get` | `GET /api/pipeline/{owner}/{repo}` | ✅ | Repository pipeline roadmap |
### `grape template`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape project template preview` | `GET /api/project-templates/{template_id}/preview` | ✅ | Get template preview HTML |
| `grape project template readme` | `GET /api/project-templates/{template_id}/readme` | ✅ | Get template README |
### `grape templates`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape project templates list` | `GET /api/project-templates` | ✅ | List template categories |
### `grape bot`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape repos bot token get` | `GET /api/repos/bot-token/{owner}/{repo_name}` | ✅ | Get repository bot token |
| `grape repos bot token set` | `PUT /api/repos/bot-token` | ✅ | Set repository bot token |
### `grape check`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape repos check name` | `GET /api/repos/check-name` | ✅ | Check repo name availability |
### `grape create`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape repos create` | `POST /api/repos/create` | ✅ | Create repository (optionally auto-host) |
### `grape deploy`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape repos deploy url` | `GET /api/repos/deploy-url/{owner}/{repo_name}` | ✅ | Get repository deployment URL |
| `grape repos deploy url set` | `PUT /api/repos/deploy-url` | ❌ 被 `repos deploy url` 覆盖 | Set deployment URL |
### `grape host`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape repos host` | `POST /api/repos/host` | ✅ | Host repository |
### `grape remove`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape repos remove` | `POST /api/repos/remove` | ✅ | Remove hosting |
### `grape repair`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape repos repair host` | `POST /api/repos/{owner}/{repo}/repair-host` | ✅ | Repair hosting |
### `grape scene`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape repos scene recommend config get` | `GET /api/repos/{owner}/{repo}/scene-recommend-config` | ✅ | Get scene recommend config |
| `grape repos scene recommend config set` | `PUT /api/repos/{owner}/{repo}/scene-recommend-config` | ✅ | Save scene recommend config |
### `grape alias`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime alias set` | `PUT /api/runtime/runtimes/{runtime_id}/alias` | ✅ | Set runtime alias |
### `grape batch`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime batch recover` | `POST /api/runtime/admin/batch-recover` | ✅ | Batch recover stale tasks |
### `grape credential`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime credential tasks` | `GET /api/runtime/credentials/{cid}/tasks` | ✅ | Tasks aggregated by credential |
### `grape event`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime event bus` | `GET /api/runtime/admin/event-bus` | ✅ | Event bus debug |
### `grape machine`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime machine health` | `GET /api/runtime/admin/machine-health` | ✅ | Machine health overview |
| `grape runtime machine health detail` | `GET /api/runtime/admin/machine-health/{runtime_id}` | ❌ 被 `runtime machine health` 覆盖 | Single runtime health detail |
### `grape max`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime max concurrent set` | `PUT /api/runtime/runtimes/{runtime_id}/max-concurrent` | ✅ | Set max concurrent |
### `grape refresh`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime refresh skills` | `POST /api/runtime/runtimes/{runtime_id}/refresh-skills` | ✅ | Rescan runtime skills |
### `grape role`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime role tags` | `GET /api/runtime/runtimes/{runtime_id}/role-tags` | ✅ | Runtime role tags |
### `grape scene`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime scene tags get` | `GET /api/runtime/runtimes/{runtime_id}/scene-tags` | ✅ | Runtime scene tags |
| `grape runtime scene tags list` | `GET /api/runtime/scene-tags` | ✅ | List scene tags |
| `grape runtime scene tags set` | `PUT /api/runtime/runtimes/{runtime_id}/scene-tags` | ✅ | Set runtime scene tags |
### `grape sessions`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime sessions list` | `GET /api/runtime/runtimes/{runtime_id}/sessions` | ✅ | List runtime sessions |
### `grape tags`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime tags set` | `PUT /api/runtime/runtimes/{runtime_id}/tags` | ✅ | Set role tags |
### `grape task`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime task cancel` | `POST /api/runtime/tasks/{task_id}/cancel` | ✅ | Cancel task |
| `grape runtime task status` | `GET /api/runtime/tasks/{task_id}/status` | ✅ | Task status polling |
### `grape tasks`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape runtime tasks list` | `GET /api/runtime/runtimes/{runtime_id}/tasks` | ✅ | List runtime tasks |
### `grape advanced`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes advanced options get` | `GET /api/scenes/{scene_id}/advanced-options` | ✅ | Get scene advanced options |
| `grape scenes advanced options set` | `PUT /api/scenes/{scene_id}/advanced-options` | ✅ | Save scene advanced options |
### `grape apply`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes apply` | `POST /api/scenes/apply/{owner}/{repo}` | ✅ | Apply scene to repository |
### `grape branch`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes branch create` | `POST /api/scenes/branches/{owner}/{repo}` | ✅ | Create repo branch |
### `grape branches`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes branches` | `GET /api/scenes/branches/{owner}/{repo}` | ✅ | List repo branches |
### `grape check`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes check name` | `GET /api/scenes/check-name` | ✅ | Check scene name availability |
### `grape create`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes create` | `POST /api/scenes` | ✅ | Create scene |
### `grape delete`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes delete` | `DELETE /api/scenes/{scene_id}` | ✅ | Delete scene |
### `grape list`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes list` | `GET /api/scenes` | ✅ | List scenes |
### `grape market`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes market applied` | `GET /api/scenes/market/{market_id}/applied` | ✅ | Check market scene applied |
| `grape scenes market apply` | `POST /api/scenes/market/{market_id}/apply` | ✅ | Apply market scene |
| `grape scenes market categories` | `GET /api/scenes/market/categories` | ✅ | List scene market categories |
| `grape scenes market create` | `POST /api/scenes/market` | ✅ | Create market scene |
| `grape scenes market delete` | `DELETE /api/scenes/market/{market_id}` | ✅ | Delete market scene |
| `grape scenes market detail` | `GET /api/scenes/market/{market_id}` | ✅ | Get market scene detail |
| `grape scenes market experience` | `POST /api/scenes/market/{market_id}/experience` | ✅ | Experience market scene |
| `grape scenes market experience check` | `GET /api/scenes/market/{market_id}/experience-check` | ❌ 被 `scenes market experience` 覆盖 | Market scene experience pre-check |
| `grape scenes market icon upload` | `POST /api/scenes/market/icon-upload` | ✅ | Upload scene icon |
| `grape scenes market like toggle` | `POST /api/scenes/market/{market_id}/like` | ✅ | Toggle scene like |
| `grape scenes market list` | `GET /api/scenes/market` | ✅ | List scene market |
| `grape scenes market update` | `PUT /api/scenes/market/{market_id}` | ✅ | Update market scene |
### `grape skills`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes skills for agent` | `GET /api/scenes/skills/{agent_type}` | ✅ | List skills for agent type |
### `grape update`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes update` | `PUT /api/scenes/{scene_id}` | ✅ | Update scene |
### `grape with`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes with pipeline` | `GET /api/scenes/with-pipeline` | ✅ | List scenes with pipeline |
### `grape global`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape search global` | `GET /api/search` | ✅ | Global search |
### `grape backend`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings backend agents` | `GET /api/settings/backend-agents` | ✅ | List backend agents (legacy alias) |
### `grape credentials`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings credentials get` | `GET /api/settings/credentials` | ✅ | Get third-party credential status |
| `grape settings credentials update` | `PUT /api/settings/credentials` | ✅ | Update third-party credentials |
### `grape engine`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings engine tag create` | `POST /api/settings/agent-runtimes/{rid}/tags` | ✅ | Add engine tag |
| `grape settings engine tag delete` | `DELETE /api/settings/agent-runtimes/{rid}/tags/{tag}` | ✅ | Delete engine tag |
| `grape settings engine tag update` | `PUT /api/settings/agent-runtimes/{rid}/tags/{tag}` | ✅ | Update engine tag |
| `grape settings engine tags` | `GET /api/settings/agent-runtimes/{rid}/tags` | ✅ | List engine tags |
### `grape event`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings event action filters` | `GET /api/settings/event-action-filters` | ✅ | List event action filter rules |
| `grape settings event action rule create` | `POST /api/settings/event-action-filters` | ✅ | Add event action filter rule |
| `grape settings event action rule delete` | `DELETE /api/settings/event-action-filters/{rule_id}` | ✅ | Delete event action filter rule |
| `grape settings event action rule update` | `PUT /api/settings/event-action-filters/{rule_id}` | ✅ | Update event action filter rule |
### `grape execution`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings execution mode get` | `GET /api/settings/execution-mode` | ✅ | Get execution mode |
| `grape settings execution mode set` | `PUT /api/settings/execution-mode` | ✅ | Set execution mode |
### `grape gitcode`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings gitcode repo get` | `GET /api/settings/gitcode-repo/{owner}/{repo}` | ✅ | Get repo GitCode config |
| `grape settings gitcode repo update` | `PUT /api/settings/gitcode-repo/{owner}/{repo}` | ✅ | Update repo GitCode config |
### `grape key`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings key create` | `POST /api/settings/api-keys` | ✅ | Create API key |
| `grape settings key delete` | `DELETE /api/settings/api-keys/{key_id}` | ✅ | Revoke API key |
### `grape keys`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings keys` | `GET /api/settings/api-keys` | ✅ | List API keys |
### `grape notifications`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings notifications get` | `GET /api/settings/notifications` | ✅ | Get notification preferences |
| `grape settings notifications update` | `PUT /api/settings/notifications` | ✅ | Update notification preferences |
### `grape oauth`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings oauth get` | `GET /api/settings/oauth` | ✅ | Get GitCode OAuth config |
| `grape settings oauth github get` | `GET /api/settings/oauth-github` | ✅ | Get GitHub OAuth config |
| `grape settings oauth github update` | `PUT /api/settings/oauth-github` | ✅ | Update GitHub OAuth config |
| `grape settings oauth update` | `PUT /api/settings/oauth` | ✅ | Update GitCode OAuth config |
### `grape pipeline`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings pipeline mode get` | `GET /api/settings/pipeline-mode` | ✅ | Get pipeline mode |
| `grape settings pipeline mode set` | `PUT /api/settings/pipeline-mode` | ✅ | Set pipeline mode |
### `grape runtime`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings runtime credential rename` | `PUT /api/settings/runtime-credentials/{cid}` | ✅ | Rename runtime credential |
| `grape settings runtime credential revoke` | `POST /api/settings/runtime-credentials/{cid}/revoke` | ✅ | Revoke runtime credential |
| `grape settings runtime credential scope` | `PUT /api/settings/runtime-credentials/{cid}/scope` | ✅ | Change credential scope |
### `grape agent`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills agent stats` | `GET /api/skills/agent-stats` | ✅ | Skill stats (total + by agent_type) |
### `grape categories`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills categories` | `GET /api/skills/categories` | ✅ | List skill categories |
### `grape convert`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills convert` | `POST /api/skills/convert` | ✅ | Convert skill (cross scope) |
### `grape delete`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills delete` | `DELETE /api/skills/by-id/{skill_id}` | ✅ | Delete skill |
### `grape download`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills download` | `GET /api/skills/by-id/{skill_id}/download` | ✅ | Download skill ZIP |
### `grape featured`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills featured` | `GET /api/skills/featured` | ✅ | List featured skills |
### `grape like`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills like toggle` | `POST /api/skills/{skill_id}/like` | ✅ | Toggle skill like |
### `grape search`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills search` | `GET /api/skills/search` | ✅ | Search skills |
### `grape stats`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills stats` | `GET /api/skills/stats` | ✅ | Skill usage stats (scene/repo aggregation) |
### `grape logs`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape task logs info` | `GET /api/task-logs/{task_id}/info` | ✅ | Task runtime info |
| `grape task logs messages` | `GET /api/task-logs/{task_id}/messages` | ✅ | Task messages |
| `grape task logs stream` | `GET /api/task-logs/{task_id}/stream` | ✅ | Task message stream (SSE) |

## 六、✅ 可用 — `dual`（40 条）

两通道皆可（`tk_` 会话 token **或** `grape_` API Key）

### `grape handoff`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape a2a handoff` | `POST /api/a2a` | ✅ | Hand off to another agent (A2A) |
### `grape ops`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape dashboard ops overview` | `GET /api/dashboard/ops/overview` | ✅ | Ops overview |
### `grape repo`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape dashboard repo` | `GET /api/dashboard/{owner}/{repo}` | ✅ | Repository dashboard |
### `grape detail`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape events detail` | `GET /api/events/detail/{seq}` | ✅ | Event detail (result/log) |
### `grape list`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape events list` | `GET /api/events/{owner}/{repo}` | ✅ | List repository events |
### `grape create`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues create` | `POST /api/issues/{owner}/{repo}` | ✅ | Create issue (unified entry) |
### `grape detail`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues detail` | `GET /api/issues/{owner}/{repo}/{number}` | ✅ | Issue detail (stage+events+pipeline) |
### `grape events`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues events` | `GET /api/issues/{owner}/{repo}/{number}/events` | ✅ | Issue events list (with structured output) |
### `grape list`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues list` | `GET /api/issues/{owner}/{repo}` | ✅ | Repo issue list (stage/status enriched) |
| `grape issues list attachments` | `GET /api/issues/{issue_id}/attachments` | ❌ 被 `issues list` 覆盖 | List issue attachments |
### `grape mine`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues mine` | `GET /api/issues/mine` | ✅ | My issues (personal dimension) |
### `grape pipeline`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues pipeline` | `GET /api/issues/{owner}/{repo}/{number}/pipeline` | ✅ | Issue pipeline roadmap |
### `grape status`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape issues status get` | `GET /api/issues/{issue_id}/status` | ❌ 被 `issues status` 覆盖 | Query issue status (polling) |
### `grape detail`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape knowledge detail` | `GET /api/knowledge/{knowledge_id}` | ✅ | Knowledge detail |
### `grape list`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape knowledge list` | `GET /api/knowledge` | ✅ | List knowledge (paged) |
### `grape stats`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape knowledge stats` | `GET /api/knowledge/stats` | ✅ | Knowledge stats |
### `grape delete`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape orgs delete` | `DELETE /api/orgs/{org_id}` | ✅ | 删除组织（个人组织不可删） |
### `grape members`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape orgs members add` | `POST /api/orgs/{org_id}/members` | ✅ | 添加成员 |
| `grape orgs members remove` | `DELETE /api/orgs/{org_id}/members/{user_id}` | ✅ | 移除成员 |
| `grape orgs members update` | `PATCH /api/orgs/{org_id}/members/{user_id}` | ✅ | 修改成员角色 |
### `grape update`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape orgs update` | `PUT /api/orgs/{org_id}` | ✅ | 更新组织信息 |
### `grape template`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape project template create` | `POST /api/project-templates/create` | ✅ | Create project from template |
### `grape managed`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape repos managed` | `GET /api/repos/managed` | ✅ | List managed repositories |
### `grape member`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape repos member` | `GET /api/repos/member` | ✅ | List repos I can operate |
### `grape project`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape repos project info` | `GET /api/repos/{owner}/{repo}/project-info` | ✅ | Get project knowledge |
### `grape sync`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape repos sync` | `POST /api/repos/sync` | ✅ | Sync repo list from VCS |
### `grape detail`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape scenes detail` | `GET /api/scenes/{scene_id}` | ✅ | Get scene detail |
### `grape agent`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings agent runtimes` | `GET /api/settings/agent-runtimes` | ✅ | List agent runtimes |
| `grape settings agent runtimes refresh` | `POST /api/settings/agent-runtimes/refresh` | ❌ 被 `settings agent runtimes` 覆盖 | Refresh agent runtimes |
### `grape backend`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings backend agents refresh` | `POST /api/settings/backend-agents/refresh` | ❌ 被 `settings backend agents` 覆盖 | Refresh backend agents (legacy alias) |
### `grape runtime`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape settings runtime credential create` | `POST /api/settings/runtime-credentials` | ✅ | Create runtime credential |
| `grape settings runtime credentials` | `GET /api/settings/runtime-credentials` | ✅ | List runtime credentials |
| `grape settings runtime devices` | `GET /api/settings/runtime-devices` | ✅ | List runtime devices (paginated) |
### `grape detail`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills detail` | `GET /api/skills/by-id/{skill_id}` | ✅ | Skill detail (incl. SKILL.md) |
### `grape list`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills list` | `GET /api/skills` | ✅ | List skills |
### `grape package`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills package sub get` | `GET /api/skills/package-sub/{pkg_id}/{sub_name}` | ✅ | Get sub-skill detail from package |
### `grape sub`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills sub get` | `GET /api/skills/{skill_id}/sub/{sub_name}` | ✅ | Read sub-skill SKILL.md |
| `grape skills sub list` | `GET /api/skills/{skill_id}/sub` | ✅ | List sub-skills of a skill package |
### `grape upload`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape skills upload` | `POST /api/skills/upload` | ✅ | Upload skill (user personal / repo) |
### `grape complete`

| 命令 | HTTP | CLI 可达 | 说明 |
|------|------|----------|------|
| `grape tasks complete` | `POST /api/tasks/complete` | ✅ | Self-report task complete |

