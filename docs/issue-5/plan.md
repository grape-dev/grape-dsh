# Issue #5 方案设计（Plan）

## 模块与职责

| 模块 | 改动 |
|---|---|
| `src/follow-window.ts`（新增，host 侧纯逻辑） | 加速窗口状态机：首拍立即、按 stepMs 续拍、到期/失效自动停止、后台跳过该拍；时钟与调度注入，便于 `node:test` 覆盖 |
| `src/client/pins-store.ts` | `followPin(id, durationMs, stepMs)` / `stopFollow(id)`；复用 `panelGet('pipeline', qs)` + `patch`；`removePin` / `clearPins` 清理定时器；常规轮询与加速轮询共用静默取数函数 |
| `src/client/GrapeFocusPanel.tsx` | `takeover-finish` 成功、`takeover-abort` 且重派成功后触发 `followPin` |

## 关键决策

- **60s 窗口而非常驻高频**：兼顾「动作后尽快看到下一节点」与子进程开销；到期自动回落到常规 20s。
- **每拍 `force=1`**：4s 间隔小于宿主 30s 缓存，不带 force 会一直读到旧数据，等于没加速；只绕缓存、不改宿主缓存语义。
- **静默取数**：加速拍不置 `loading`，避免卡片每 4s 闪一次「加载中」；请求异常时静默、下一拍重试，上游返回可读 `message` 时仍如实展示（与常规轮询一致）。
- **后台跳过**：`document.hidden` 时该拍不 spawn 子进程。
- **入口先 `stopFollow`**：重复触发（如连点确认）不会叠加定时器。
- **纯逻辑独立成模块**：`pins-store` 依赖 React 与浏览器全局，无法在 `node:test` 直接跑；把「何时拍/何时停」抽成无依赖状态机，测试 seam 清晰。

## 测试 seam

- `src/follow-window.ts` 的 `startFollowWindow`：注入 `now` / `schedule` / `cancel`，测试假时钟驱动。
- 覆盖：首拍立即且强制、4s 节奏、60s 到期停止、`stop()` 清理定时器、pin 失效自动停止、后台跳过该拍后恢复补拉。
- 复用仓库既有约定：`node:test` + `npm test = build && node --test test/*.test.mjs`，跑 `lib/` 产物，不引入新依赖。

## 风险

| 风险 | 缓解 |
|---|---|
| 定时器泄漏 | `stopFollow` 幂等；窗口自然结束也清句柄；`removePin`/`clearPins` 统一清理 |
| 后台高频 spawn | `document.hidden` 跳过该拍 |
| 重复 follow 叠加 | 入口先 `stopFollow` |
| 加速期数据闪烁 | 静默 patch，不置 `loading` |

## 收尾（2026-11-17）

- `followPin` 只在 `takeover-finish` 的 `handoff` 真正派发成功（`dispatched=true`）时开窗；派发失败 / 无下一节点不再空转 60s。