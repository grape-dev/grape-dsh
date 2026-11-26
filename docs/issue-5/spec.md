# Issue #5 需求文档（Spec）

## 目标

接管面板点「确认完成 · 派发下一节点」或「放弃接管（触发重派）」后，观察卡的流水线下一节点在 ≤5s 内自动点亮，用户无需手动点「刷新」；60s 后自动回到常规 20s 轮询，不留下常驻高频开销。

## 现状

- 观察卡固定 20s 轮询 `pins-store.ts`，叠加宿主侧 30s TTL 缓存，新节点最长约 50s 才可见。
- 接管动作完成后不会立即触发刷新，观感像「卡住」。

## 期望行为

1. `src/client/pins-store.ts` 新增 `followPin(id, durationMs = 60_000, stepMs = 4_000)`：首个 tick **立即**执行并以 `force=1` 拉 `/pipeline`（绕过宿主缓存），随后每 4s 一拍；60s 到期自动停止。
2. `document.hidden` 时跳过该拍（不 spawn 子进程），回前台由下一拍补拉。
3. 新增 `stopFollow(id)` 清理定时器，并在 `removePin()` / `clearPins()` 中调用，避免空跑与泄漏。
4. `src/client/GrapeFocusPanel.tsx`：`takeover-finish` 成功、`takeover-abort` 且重派成功后调用 `followPin(`${repoStr}#${issueNum}`)`。
5. 常规 20s 轮询、宿主 30s 缓存语义不变；未 pin 的 issue 不受影响。

## 验收标准

- [ ] 点确认后 ≤5s，节点链出现下一节点并进入「待处理/进行中」；
- [ ] 60s 后回到 20s 常规轮询，不再有持续子进程开销；
- [ ] 未被 pin 的 issue 不受影响；
- [ ] 卡片移除 / 清空后定时器被清理（无泄漏）；
- [ ] `npm run typecheck` 通过；`npm test` 在 Windows 与 Linux 均全绿（Windows 若有 skip 需说明）。

## 边界

- 基线 `dev-ch`，开发分支 `feat/issue-5`；禁 force push、禁改 `main`。
- 不做 F10 的按钮语义与 finished 只读改造。