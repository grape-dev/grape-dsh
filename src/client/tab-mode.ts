/**
 * 侧栏 Tab 的「实时 / 浏览 / 本机」模式（client 侧，模块级单例）。
 *
 * 为什么单独一份而不是留在 GrapeTab 的 useState 里：
 * **P3「跟随此 issue」需要从浏览面板内部切回实时模式**。
 * 如果把 mode 关在 GrapeTab 组件内，浏览面板就只能靠"焦点 URL 变了"这种副作用
 * 间接触发切换 —— 而"AI 已经跟在同一个 issue 上"这个常见情况下 URL 根本不变，
 * 点了「跟随」会毫无反应。显式共享状态才能保证这一下必有反馈。
 *
 * 订阅方式用 `useSyncExternalStore`（与 store.ts 一致，引用稳定）。
 */

/** 面板模式（machine = 本机 Worker 接入） */
export type GrapeTabMode = 'live' | 'browse' | 'machine'

let mode: GrapeTabMode = 'live'

const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) {
    try { l() } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

/** 读取当前模式 */
export function getMode(): GrapeTabMode {
  return mode
}

/** 设置模式（同值不通知） */
export function setMode(next: GrapeTabMode): void {
  if (next === mode) return
  mode = next
  emit()
}

/** 订阅模式变化 */
export function subscribeMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}