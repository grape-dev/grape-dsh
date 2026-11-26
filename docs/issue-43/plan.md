# Issue #43 方案设计

## 核心思路

新增与 DOM 无关的协调器 `src/takeover-session.ts`，把「建会话」收敛成一个可单测的高层 seam：

```
switchToTakeoverWorkspace ─┐
                           ├─> createTakeoverSession() ─> TakeoverSessionCoordinator
tryRecoverPendingTakeover ─┘                                  │
                                                              ├─ in-flight Map（R1 去重）
                                                              ├─ isCreating（R2 门禁）
                                                              ├─ lastCreatedAt + 10s 窗口（R3）
                                                              └─ ids + release（R4 取消重复）
```

## 关键设计

### R1 in-flight 去重
- `takeoverSessionKey()`：`takeoverId` 非空 → `takeover:<id>`；否则 `workspace:<ws>|prompt:<FNV1a(len:hash)>`。
- `createSession()` 首次注册 `Map<key, Promise>`；同 key 后续调用返回共享 Promise，结果标记 `created:false`，不重复调用 `create`。
- 只有 `created:true` 的调用方负责 attach + clearPending，避免重复 attach。

### R2 创建态门禁
- 协调器以 in-flight Map 作为「正在创建」事实源，导出 `canAutoRecover()`。
- 面板 `load()` 的自动恢复分支增加 `canAutoRecoverPendingTakeover()` 条件；被门禁挡住时不写 `_recoverAttempted`，窗口过后仍可自动恢复。
- 失败由 Promise reject 收敛，in-flight 在 `finally` 清理 → 失败后 `canAutoRecover()` 恢复为 true。

### R3 时间兜底
- 创建成功时写 `lastCreatedAt`；`canAutoRecover()` 在成功后的 `recoveryWindowMs`（默认 10s）内返回 false。
- 失败不写窗口 → 允许立即恢复。

### R4 重复兜底
- 同一 key 下记录已创建 session ids；新 session 创建成功时取消旧 id（保留最新），并通过注入的 `release`（复用 `stopLocalSession` → `Session.cancel()`）执行。
- 面板拿到服务端已登记 `client_session` 时调用 `reconcileTakeoverSessions(takeoverId, registeredSessionId)`：保留已登记项，取消其它已跟踪项。
- 每次取消都 `tkLog`（`duplicate_session_cancelled` / `duplicate_session_reconciled`）。

### R5 回归
- 新增 `test/takeover-create-e2e.test.mjs`：用 esbuild 加载 `src/client/takeover-switch.ts`（stub 浏览器全局），先触发 switch 的 deferred 创建，再在 resolve 之前调用 `tryRecoverPendingTakeover()` 模拟面板强制恢复；断言 create 计数 = 1、attach 的不同 session id = 1。
- 另加源码级断言：`GrapeFocusPanel.load()` 的自动恢复分支必须经过 `canAutoRecoverPendingTakeover()`，防止门禁被后续改动绕过。

## 复审补强（QA #43 审查意见）

### ① UI 回退建会话纳入创建态（Required）
- 协调器新增外部创建态：`beginExternalCreate()` / `endExternalCreate()` / `isExternalCreating()`，
  与 in-flight 共用 `isCreating()` → `canAutoRecover()` 门禁语义；TTL 180s 防异常遗留永久关闭门禁。
- `openSessionInWorkspace()`（DOM 阶梯）进入即登记创建态，成功发送/最终失败时解除；
  `switchToTakeoverWorkspace()` 与 `tryRecoverPendingTakeover()` 在「同一接管 UI 回退进行中」时不再并行发起 API 建会话。
- 创建态同时落 stash（`grape.takeover.uiCreating = <key>|<startedAt>`）：页面 reload 后内存态丢失，
  `canAutoRecoverPendingTakeover()` 按标记时间重新登记，门禁继续有效；`resumeTakeoverAfterReload()` 先解除上一页的遗留标记再重新决策路径。

### ② takeoverId 单一来源（Optional）
- `switchToTakeoverWorkspace()` 始终覆盖写 `TK_KEY`（允许空串），`_stashClear()` 一并清 `TK_KEY`。
- `tryRecoverPendingTakeover()` 与 `reconcileTakeoverSessions()` 均从 stash 取 takeoverId（stash 为空才退回服务端 id），
  create / recover / reconcile 算出同一个去重 key。
- DOM 成功后先把 `TK_KEY` 交给 `_attachLocalSession(tid)` 再清底稿，避免清理顺序导致 attach 丢失。

### ③ 唯一保留策略（Optional）
- 协调器记录「已释放」会话集合：`runCreate` 不取消平台已登记项、也不复活已释放项；
  `reconcile` 遇到已被取消的陈旧登记项时退回保留最新跟踪项并记 `registered_session_released`，不再出现 A/B 先后都被取消。
- `lastCreatedAt` 在窗口过期读取时清理（长生命周期页面的 Map 增长，Nit）。

### ④ 阶梯自行 reload 的续做（复审 Required，R8）
- 根因：`openSessionInWorkspace()` 一进入就 `_creatingBegin(identity)` 登记 ui 创建态，而两条
  `location.reload()` 分支（行未渲染 / 三种入口都失效）都发生在**任何 New session 点击之前**——
  此时一个会话都没建，标记已无意义却不清，新页 `resumeTakeoverAfterReload()` 命中
  `_creatingActive` 直接 return（只记 `resume_skipped_creating`），接管静默悬空到 180s TTL。
- `_reloadForLadder(identity)`：reload 前 `_creatingForget()` 清创建态 + 写意图标记
  `grape.takeover.ladderReload = <协调器 key>|<ts>`（一次性、按 key 匹配、TTL 内有效）+ 写 `RELOADED_KEY`。
- `resumeTakeoverAfterReload()`：先 `_consumeLadderReload(identity)`；命中意图 → 记
  `resume_ladder_continue` 并**跳过创建态判定**继续建会话；未命中仍走原门禁（API/UI 创建中不建）。
- 两条 reload 分支共用同一 helper，避免只改一条。

### ⑤ TTL 到期「结果未知」的用户提示（复审 Optional，R9）
- 创建态标记 TTL 到期被解除时记一次性信号 `unknownOutcomeKeys` + 留痕 `creating_state_expired`：
  语义是「上一页 create 可能已在服务端建成，只是 attach/底稿丢了」。
- `resumeTakeoverAfterReload()` / `tryRecoverPendingTakeover()` 恢复前消费该信号，
  `setNotice` 提示「可能已建过会话，先看侧栏；若出现两条保留一条即可」并留痕 `creating_outcome_unknown`。
- 跳过分支（TTL 内仍在创建）同样补 `setNotice`：明确告知可点面板「继续接管」，不再静默。
- 未做「按 workspace 列会话并 adopt」：`ctx.sessions` 现有契约只有 `create` / `using`，无列会话接口，
  猜测 API 会引入新的失败面，故取复审给出的保守方案（可见提示 + 留痕）。

## 测试 seam
- 单元：`lib/takeover-session.js`（协调器公开 API，node 可直接 import）。
- 端到端：`src/client/takeover-switch.ts` 公开函数（`setApiSessionCreator` / `switchToTakeoverWorkspace` / `tryRecoverPendingTakeover` / `canAutoRecoverPendingTakeover` / `resumeTakeoverAfterReload`）。
- 用户可见提示：e2e 用 `with-notice` 变体（同一 bundle 内导出 `pins-store.getNotice`）断言 `setNotice` 真的写了提示，
  不只靠源码字符串断言。

## 验收对照表（条款 → 代码位置 → 测试名）

| 条款 | 代码位置 | 测试名 |
|------|----------|--------|
| R1 | `src/takeover-session.ts` `takeoverSessionKey` / `createSession`；`src/client/takeover-switch.ts` `createTakeoverSession` | `R1 并发 3 次只建 1 个会话且共享同一 sessionId` |
| R2 | `src/takeover-session.ts` `isCreating` / `beginExternalCreate`；`src/client/takeover-switch.ts` `_creatingBegin/_creatingActive`（API + UI 共用标记，`<source>|<key>|<at>`）/ `openSessionInWorkspace` / `resumeTakeoverAfterReload`（TTL 内不清标记、不自动建）；`GrapeFocusPanel.tsx` `load()` 门禁 | `R2 创建中禁止自动恢复、失败后恢复为可恢复`；`R2 UI 回退建会话期间门禁关闭，且不重复发起建会话`；`R2 页面 reload 后持久化创建态仍关闭门禁`；`面板 load() 的自动恢复必须经过创建态门禁`；`R2 resumeTakeoverAfterReload：API 创建中 reload 不得再次调用 apiSessionCreator`；`R2 resumeTakeoverAfterReload：UI 回退创建中 reload 不得再次调用 apiSessionCreator`；`R2 resumeTakeoverAfterReload：创建态 TTL 到期后允许自动恢复` |
| R3 | `src/takeover-session.ts` `createdRecently` / `recoveryWindowMs` | `R3 创建成功后 10s 内不自动恢复，窗口过后恢复` |
| R4 | `src/takeover-session.ts` `runCreate` / `reconcile` / `released`；`src/client/takeover-switch.ts` `reconcileTakeoverSessions` | `R4 重复会话被取消并留痕`；`R4 reconcile 保留平台已登记会话`；`R4 reconcile 不复活已释放会话`；`R4 建新会话时不取消平台已登记会话`；`R4 takeoverId 单一来源` |
| R5 | `src/client/takeover-switch.ts` 两个入口统一走 `createTakeoverSession` | `R5 创建与 attach 前强制挂载面板只产生 1 个会话、1 个 attach` |
| R6 | 全量 `npm run typecheck` / `npm test` / `npm run build` | 上述测试 + 既有 26 个测试文件 |
| R7 | `.gitcode/workflows/ci.yml` | 流水线执行 typecheck + build + test |
| R8 | `src/client/takeover-switch.ts` `_reloadForLadder`（清创建态 + 写 `LADDER_RELOAD_KEY`）/ `_consumeLadderReload`；`resumeTakeoverAfterReload` 的续做分支；`openSessionInWorkspace` 两条 reload 分支 | `R7 阶梯自行 reload（行未渲染）后新页继续接管，create 计数 = 1` |
| R9 | `src/client/takeover-switch.ts` `resumeTakeoverAfterReload` 跳过分支的 `setNotice`；`_creatingActive` 的 `unknownOutcomeKeys` / `_takeUnknownOutcome` / `_noticeUnknownOutcome` | `R7 创建态跳过时必须有用户可见提示（不得静默悬空）`；`R7 创建态 TTL 到期后恢复前提示「可能已建过会话」` |