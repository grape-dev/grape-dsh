# Issue #5 任务拆解（Task）

## T1 加速窗口状态机（红 → 绿）

- [x] `test/follow-window.test.mjs`：假时钟覆盖首拍立即、4s 节奏、60s 到期停止、`stop()` 清理、pin 失效停止、后台跳过。
- [x] `src/follow-window.ts`：`startFollowWindow(opts)` 返回 `{ stop, stopped }`。

## T2 pins-store 接入

- [x] `followPin(id, durationMs = 60_000, stepMs = 4_000)`：入口先 `stopFollow`，pin 不存在直接返回。
- [x] `stopFollow(id)`：清定时器与句柄，幂等。
- [x] `removePin` / `clearPins` 调用清理。
- [x] 加速拍与常规轮询共用静默取数（`force` 参数区分）。

## T3 面板触发

- [x] `GrapeFocusPanel.tsx`：`takeover-finish` 成功 → `followPin`。
- [x] `takeover-abort` 且 `redispatch.ok` → `followPin`。

## T4 验证与交付

- [x] `npm run typecheck`
- [x] `npm test`（Windows：89 pass / 1 skip；skip 为既有 POSIX-only 用例；Linux 待 CI）
- [x] 自审查 + 开源前置增量检查
- [x] 建 PR（#4）、Issue 评论、A2A 通知 QA
- [x] 合入 dev-ch（merge !4，head `4092ec7`）