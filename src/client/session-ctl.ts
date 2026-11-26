/**
 * 接管结束（「确认完成」/「放弃接管」）后停掉本次接管新建的本地会话。
 *
 * 为什么放在 client half，而不是宿主（src/index.ts）：
 *   · 会话对象只存在**前端** `ctx.sessions` 里（dsh-api-session-controller 的 client 侧），
 *     `Session.cancel()` 就是「停止当前这一轮」，宿主侧拿到的是另一套句柄，语义不同；
 *   · 前端这套 API 插件本来就在用（建会话 + 发 prompt，见 index.tsx `setApiSessionCreator`），
 *     复用同一条链路，行为与宿主版本无关；
 *   · 宿主侧不需要注入任何服务 → 不会影响 dsh 自己的会话能力。
 *
 * 失败一律**不抛**：停止只是收尾动作，绝不能因为停不掉就把「已确认完成 / 已放弃」变成报错。
 */

/** 一次停止尝试的结果（面板据此拼提示，不抛异常） */
export interface StopSessionResult {
  ok: boolean
  /** 面板展示用的一句话（成功也要给，用户要看到「会话已停」） */
  message: string
}

const OK_MESSAGE = '接管会话已停止'
const NO_ID_MESSAGE = '没有记录本地会话 id，未停止会话（可在会话列表里手动停）'
const NO_API_MESSAGE = '当前 DSH 前端不支持停止会话，请手动停止（不影响流水线推进）'

/** 由 index.tsx 在 apply() 时注入（拿得到 client ctx 的 sessions 服务） */
let stopper: ((sessionId: string) => Promise<StopSessionResult>) | null = null

/** 注入「停会话」实现（apply 时调用一次；重复注入以后者为准） */
export function setApiSessionStopper(fn: (sessionId: string) => Promise<StopSessionResult>): void {
  stopper = fn
}

/**
 * 停掉指定会话。
 *
 * 语义是「暂停」而不是删除：`cancel()` 打断当前这一轮，会话与上下文仍留在列表里，
 * 用户之后还能打开回看（避免接管刚结束就把人锁在门外）。
 */
export async function stopLocalSession(sessionId: string): Promise<StopSessionResult> {
  const id = String(sessionId || '').trim()
  if (!id) return { ok: false, message: NO_ID_MESSAGE }
  if (!stopper) return { ok: false, message: NO_API_MESSAGE }
  try {
    return await stopper(id)
  } catch (err) {
    return { ok: false, message: `停止会话失败：${String(err instanceof Error ? err.message : err).slice(0, 120)}` }
  }
}
