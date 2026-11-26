# Issue #43 Spec：创建并接管偶发双会话修复

## 背景

在浏览页点「创建需求并接管」后，同一 issue 偶发出现两个本地 DSH 会话（同 workspace、同接管 prompt），平台只登记其中一个，另一条成为孤儿会话继续跑同一任务。

基线 `dev-ch-11 @ f9ed14c` 根因：

1. `switchToTakeoverWorkspace()` 先写 stash（prompt/workspaceId/takeoverId），再 `await apiSessionCreator(...)`，成功后才 `attachSessionToGrape()` / `clearPendingTakeover()`。
2. `GrapeFocusPanel.load()` 在「服务端 `client_session` 为空 + 本地有 stash」时判定为「半截接管」，调用 `tryRecoverPendingTakeover()`。
3. 创建到 attach 回写之间的窗口内，面板挂载/轮询就会触发第二次 `apiSessionCreator`，且两处入口都没有 in-flight 去重 → 双会话。

## 目标

把「建会话」收敛为单一幂等入口，并在面板自动恢复路径上加创建态门禁与时间兜底；仍出现重复会话时主动取消多余项并留痕。

## 验收条款（R1–R9）

| 条款 | 要求 |
|------|------|
| R1 | `apiSessionCreator` 并发去重：key 优先 takeoverId，否则 workspaceId+prompt 指纹；同 key 并发调用共享同一 Promise，只调用一次 `ctx.sessions.create`。并发 3 次 → create 计数 = 1，返回同一 sessionId。 |
| R2 | 创建态门禁：区分「有底稿待恢复」与「正在创建」。创建进行中面板 `load()` 不得触发 `tryRecoverPendingTakeover`；成功/失败都复位，失败后仍允许恢复。**覆盖 API 路径与 UI 回退（DOM 点击「New session in X」）两条创建路径**；UI 回退的创建态落 stash，页面 reload 后仍生效（TTL 180s 兜底解除）。 |
| R3 | 时间兜底：接管创建成功后 N 秒（默认 10s）内不自动恢复，覆盖面板在 attach 前挂载的其它时序。 |
| R4 | 重复兜底：检测到同一 takeover/workspace 有 >1 个本地会话时，主动 `cancel()` 多余项并 `tkLog` 留痕。唯一保留策略 = 已登记优先；已释放（已取消）的会话不得在后续 create/reconcile 中复活。去重 key 的 takeoverId 单一来源 = stash（`TK_KEY` 始终覆盖写、清理时一并清）。 |
| R5 | 端到端回归：模拟「创建并接管」，在会话创建与 attach 之前强制触发面板恢复路径 → 只建 1 个会话、只有 1 个 session id 被 attach；另覆盖「API 失败 → UI 回退期间门禁关闭」与「reload 后门禁仍关闭」。 |
| R6 | 门禁：不删/不弱化既有测试；`npm run typecheck`、`npm test`、`npm run build` 全绿；不改平台侧（本单纯插件）。 |
| R7 | CI 门禁：仓库提供 `.gitcode/workflows/ci.yml`，push / PR 自动执行 typecheck + build + test。 |
| R8 | 阶梯自发起 reload 必须续做：DOM 阶梯在**尚未点过任何 New session**（一个会话都没建）时自行 `location.reload()`（行未渲染、入口全失效两条分支）——reload 前必须先 `_creatingForget()` 清创建态，并写「阶梯续做」意图 `grape.takeover.ladderReload`；新页 `resumeTakeoverAfterReload` 读到意图即按续做处理（继续建会话），不得判为「创建仍在进行」静默跳过。回归：行未渲染 → 阶梯自行 reload → 新页继续接管且 create 计数 = 1。 |
| R9 | 不静默悬空：`resumeTakeoverAfterReload` 因创建态门禁跳过时必须 `setNotice` 给出可操作提示（明确可点面板「继续接管」）；创建态标记 TTL 到期（= 上一页建会话结果未知，可能已建出会话）时，恢复前提示「可能已建过会话，先看侧栏」，并留痕 `creating_state_expired` / `creating_outcome_unknown`，避免不声不响再建一条。 |

## 边界

- 不重新设计接管协议、不动平台接口，只修并发与状态判定。
- 「接管结束停会话」链路（`session-ctl`）行为不变。
- 去重所需共享状态只放客户端内存 + stash 标记，不引入后端字段。