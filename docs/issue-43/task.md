# Issue #43 任务拆解

- [x] 1. 新增 `src/takeover-session.ts`：去重 key、in-flight Map、创建态门禁、10s 窗口、重复取消/reconcile。
- [x] 2. `src/client/takeover-switch.ts`：两个建会话入口统一走 `createTakeoverSession`；导出 `canAutoRecoverPendingTakeover` / `reconcileTakeoverSessions`；release 接 `stopLocalSession`。
- [x] 3. `src/client/GrapeFocusPanel.tsx`：`load()` 自动恢复加创建态门禁；服务端已登记 `client_session` 时 reconcile。
- [x] 4. 单测 `test/takeover-session.test.mjs`：R1 并发去重 / R2 门禁与失败复位 / R3 时间窗 / R4 取消与 reconcile。
- [x] 5. 端到端 `test/takeover-create-e2e.test.mjs`：R5 deferred 创建 + 强制恢复，断言 1 会话 / 1 个 attach id；源码门禁断言。
- [x] 6. 自测 `npm run typecheck` / `npm test` / `npm run build`，提交并发起 PR。
- [x] 7. 复审①（Required）：UI 回退（DOM 点击）建会话纳入协调器创建态，stash 持久化 + TTL，面板门禁与两个 API 入口同步生效。
- [x] 8. 复审②（Optional）：takeoverId 单一来源 —— `TK_KEY` 始终覆盖写（允许空串）、`_stashClear` 一并清，create/recover/reconcile 统一从 stash 取。
- [x] 9. 复审③（Optional/Nit）：唯一保留策略（已登记优先、已释放不复活），过期窗口清理 Map。
- [x] 10. 复审工作流（Required）：新增 `.gitcode/workflows/ci.yml` 执行 typecheck + build + test（仓库级合并门禁需维护者开启）。
- [x] 11. 复审④（Required）：`resumeTakeoverAfterReload` 不再无条件清创建态标记 —— 标记改为 API/UI 共用（`<source>|<key>|<at>`，兼容旧格式），TTL 内 reload 不自动建会话，TTL 到期或手动「继续接管」才继续；补真实入口回归（API 创建中 reload / UI 回退创建中 reload / TTL 到期恢复）。
- [x] 12. 复审⑤（Required）：阶梯自行 reload 不得被当成「创建仍在进行」—— 两条 `location.reload()` 分支共走 `_reloadForLadder()`（先 `_creatingForget()` 清创建态，再写 `grape.takeover.ladderReload` 续做意图）；`resumeTakeoverAfterReload` 命中意图即按续做处理；补回归「行未渲染 → 自行 reload → 新页继续接管、create 计数 = 1」。
- [x] 13. 复审⑥（Optional）：创建态 TTL 到期 = 结果未知 —— `_creatingActive` 记一次性信号 `unknownOutcomeKeys`；恢复前提示「可能已建过会话、先看侧栏」（`creating_state_expired` / `creating_outcome_unknown`）；跳过分支补 `setNotice`，不再静默悬空。

## reload 实测对照（验收 → 代码位置 → 测试名）

| 验收 | 代码位置 | 测试名 |
|------|----------|--------|
| R2 reload 后门禁仍生效，且不第二次调用 `apiSessionCreator`（API 创建中） | `src/client/takeover-switch.ts` `_creatingBegin(identity,'api')`、`resumeTakeoverAfterReload` 的 `_creatingActive` 前置判定 | `R2 resumeTakeoverAfterReload：API 创建中 reload 不得再次调用 apiSessionCreator` |
| R2 reload 后门禁仍生效，且不第二次调用 `apiSessionCreator`（UI 回退创建中） | `src/client/takeover-switch.ts` `openSessionInWorkspace` → `_creatingBegin(identity)`（ui 来源）、`resumeTakeoverAfterReload` | `R2 resumeTakeoverAfterReload：UI 回退创建中 reload 不得再次调用 apiSessionCreator` |
| R2 TTL 到期后解除门禁（不会永久关） | `src/takeover-session.ts` `DEFAULT_EXTERNAL_CREATE_TTL_MS` / `isExternalCreating`；`_creatingActive` 过期清理 | `R2 resumeTakeoverAfterReload：创建态 TTL 到期后允许自动恢复` |
| R2 面板 load() 仍经过门禁 | `src/client/GrapeFocusPanel.tsx` `load()` 的 `canAutoRecoverPendingTakeover()` 前置 | `R2 页面 reload 后持久化创建态仍关闭门禁`、`R2 面板 load() 的自动恢复必须经过创建态门禁并做重复对账` |
| R8 阶梯自行 reload（行未渲染）→ 新页续做、create = 1 | `takeover-switch.ts` `_reloadForLadder`（两条 reload 分支共用）/ `_consumeLadderReload` / `resumeTakeoverAfterReload` 续做分支 | `R7 阶梯自行 reload（行未渲染）后新页继续接管，create 计数 = 1` |
| R9 跳过分支不静默（有用户可见提示） | `takeover-switch.ts` `resumeTakeoverAfterReload` 跳过分支的 `setNotice` | `R7 创建态跳过时必须有用户可见提示（不得静默悬空）` |
| R9 TTL 到期 = 结果未知，恢复前提示 | `takeover-switch.ts` `unknownOutcomeKeys` / `_takeUnknownOutcome` / `_noticeUnknownOutcome`；`_creatingActive` 过期留痕 | `R7 创建态 TTL 到期后恢复前提示「可能已建过会话」` |
