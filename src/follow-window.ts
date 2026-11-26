/**
 * 接管动作后的短时加速轮询窗口 —— 纯逻辑，无 React / 浏览器依赖，便于 `node:test` 覆盖。
 *
 * 用户点「确认完成 · 派发下一节点」或「放弃接管（触发重派）」后，下一节点通常几秒内就会出现；
 * 但常规轮询是 20s、叠加宿主 30s 缓存，观感像「卡住」。这里开一个 60s 的短窗口：
 *   · **首拍立即执行**（不等 4s），调用方每拍带 `force=1` 绕过宿主缓存；
 *   · 之后每 `stepMs` 一拍，到 `durationMs` 自动停止，回落到常规轮询；
 *   · `document.hidden` 时跳过该拍（后台标签页不该持续 spawn 子进程），回前台由下一拍补拉；
 *   · pin 被移除（`isActive=false`）时立即停止，杜绝空跑。
 *
 * 为什么独立成模块：`pins-store.ts` 依赖 React 与浏览器全局，测试里跑不起来；
 * 把「何时拍 / 何时停」抽成注入时钟与调度器的状态机，时序与清理都能被确定性验证。
 */

export interface FollowWindowOptions {
  /** 窗口总时长（ms），到期自动停止 */
  durationMs: number
  /** 相邻两拍间隔（ms） */
  stepMs: number
  /** 当前时间（ms） */
  now: () => number
  /** 安排一次延时任务，返回句柄 */
  schedule: (fn: () => void, ms: number) => unknown
  /** 取消未执行的延时任务 */
  cancel: (handle: unknown) => void
  /** 每一拍的回调（调用方负责用 force=1 取数） */
  onTick: () => void
  /** 是否仍应继续（如 pin 仍在观察列表中） */
  isActive: () => boolean
  /** 页面是否在后台；为 true 时跳过该拍。缺省视为前台 */
  isHidden?: () => boolean
  /** 停止时回调（到期 / 主动 stop 都会触发一次） */
  onStop?: () => void
}

export interface FollowWindowHandle {
  stop: () => void
  readonly stopped: boolean
}

/** 间隔下限：防止调用方传 0 造成同步递归 */
const MIN_STEP_MS = 250

export function startFollowWindow(options: FollowWindowOptions): FollowWindowHandle {
  const { durationMs, stepMs, now, schedule, cancel, onTick, isActive, onStop } = options
  const isHidden = options.isHidden ?? (() => false)
  const deadline = now() + Math.max(0, durationMs)
  const interval = Math.max(MIN_STEP_MS, stepMs)

  let stopped = false
  let handle: unknown = null

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (handle !== null) {
      cancel(handle)
      handle = null
    }
    onStop?.()
  }

  const tick = (): void => {
    handle = null
    if (stopped) return
    if (!isActive()) { stop(); return }

    const at = now()
    if (at >= deadline) { stop(); return }
    if (!isHidden()) onTick()

    // 最后一拍贴着 deadline 排，既不会越过 60s 窗口，也不会提前停表
    const remaining = deadline - at
    if (remaining <= 0) { stop(); return }
    handle = schedule(tick, Math.min(interval, remaining))
  }

  tick()

  return {
    stop,
    get stopped() { return stopped },
  }
}