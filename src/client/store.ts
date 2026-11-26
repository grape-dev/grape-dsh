/**
 * 侧栏 Tab 的「打开状态 + 手动静默」（client 侧）。
 *
 * 这里原本还存"当前焦点"（`current` / `setFocus` / `getFocus` / `clearFocus` /
 * `isStale`，以及配套的 subscribe/emit）。
 *
 * 2026-10-23 删除：焦点卡按用户判断从面板移除后，**存下来的焦点对象再没有任何消费者** ——
 * "AI 在看什么"只剩一个用途，就是触发「AI 调 Grape 工具时自动切到这个 Tab」，
 * 而那个信号改从**工具调用参数**读（client/GrapeToolView.tsx），不需要经过 store。
 *
 * 所以只保留 `autoOpenOrSwitch` 真正依赖的两件事：
 *   ① 这个 Tab 是否已经打开过 —— 决定"首次是否要自动打开"
 *   ② 用户是否刚手动操作过 —— 决定"暂时别抢他的注意力"
 *
 * 都是模块级单例（同一 bundle 内共享），无需 cordis service。
 */

/** 用户手动操作后的自动跟随静默时长 */
export const MANUAL_PAUSE_MS = 30_000

let opened = false
let manualPauseUntil = 0

/** 是否已打开过 Tab */
export function hasOpened(): boolean {
  return opened
}

/** 标记已打开 */
export function markOpened(): void {
  opened = true
}

/** 用户手动操作侧栏 → 暂停自动跟随一段时间 */
export function noteManualAction(ms: number = MANUAL_PAUSE_MS): void {
  manualPauseUntil = Date.now() + ms
}

/** 当前是否处于手动静默期 */
export function isManualPaused(): boolean {
  return Date.now() < manualPauseUntil
}