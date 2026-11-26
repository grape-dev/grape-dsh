/**
 * 接管建会话的并发协调器（与 DOM 无关，node 可直接单测）。
 *
 * 背景（Issue #43）：`switchToTakeoverWorkspace` 与面板的「半截接管自动恢复」
 * 会在「创建完成、attach 回写之前」的时间窗内各调一次 `apiSessionCreator`，
 * 由于两处都没有 in-flight 去重，偶发建出两个本地会话（孤儿会话继续跑同一任务）。
 *
 * 本模块把「建会话」收敛为单一幂等入口：
 *   · R1 in-flight 去重：同 key 并发调用共享同一 Promise，只调用一次 create；
 *   · R2 创建态门禁：`isCreating` 供面板 load() 判定「正在创建 ≠ 待恢复」；
 *   · R3 时间兜底：创建成功后 N 秒内不允许自动恢复；
 *   · R4 重复兜底：同一 key 下出现多个会话时取消多余项并留痕。
 *
 * 不依赖 localStorage / document / window，浏览器侧由 takeover-switch 注入 stash
 * 读写与 tkLog；测试可注入 now / release / log。
 */

/** 建会话实现（浏览器侧 = ctx.sessions.create + prompt）。 */
export type SessionCreator = (workspaceId: string, prompt: string) => Promise<string>

/** 取消会话实现（浏览器侧 = Session.cancel()）。返回 true 表示取消成功。 */
export type SessionReleaser = (sessionId: string) => Promise<boolean> | boolean

/** 留痕实现（浏览器侧 = tkLog → /grape-worker-api/takeover-log）。 */
export type TakeoverLog = (step: string, extra?: Record<string, unknown>) => void

/** 接管创建成功后，默认的「不自动恢复」时间窗（R3）。 */
export const DEFAULT_RECOVERY_WINDOW_MS = 10_000

/**
 * 外部（DOM 点击「New session in X」）建会话的默认创建态 TTL。
 *
 * DOM 阶梯自身最长约 30s 等待 + 一次 reload；reload 时内存态会丢，靠 stash 标记 + 该 TTL
 * 兜底。超过 TTL 仍没走到结束分支（页面崩溃/被切走）不能让门禁永久关闭。
 */
export const DEFAULT_EXTERNAL_CREATE_TTL_MS = 180_000

export interface SessionIdentity {
  /** 服务端接管会话 id（tkos_…）；存在时优先作为去重 key。 */
  takeoverId?: string
  workspaceId?: string
  prompt?: string
}

export interface CreateSessionInput extends SessionIdentity {
  workspaceId: string
  prompt: string
  /** 平台已登记的 client_session：唯一保留策略下「已登记优先」，创建新会话时不得取消它（R4）。 */
  registeredSessionId?: string
  create: SessionCreator
}

export interface CreateSessionResult {
  sessionId: string
  /** true = 本次调用真正创建；false = 命中了同 key 的 in-flight 并共享结果。 */
  created: boolean
  /** 本次创建成功后取消掉的旧会话 id（R4）。 */
  cancelled: string[]
}

export interface ReconcileInput extends SessionIdentity {
  workspaceId?: string
  prompt?: string
  /** 服务端已登记的 client_session：优先保留它，取消其它已跟踪会话。 */
  registeredSessionId?: string
}

export interface ReconcileResult {
  kept: string
  cancelled: string[]
}

export interface CoordinatorOptions {
  now?: () => number
  recoveryWindowMs?: number
  /** 外部（DOM 回退）创建态 TTL，缺省 180s。 */
  externalCreateTtlMs?: number
  log?: TakeoverLog
  release?: SessionReleaser
}

/** prompt 指纹：长度 + FNV-1a 32bit（稳定、跨浏览器、无依赖）。 */
export function fingerprintPrompt(prompt: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < prompt.length; i += 1) {
    hash ^= prompt.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${prompt.length}:${hash.toString(16)}`
}

/**
 * 去重 key：takeoverId 优先，否则 workspaceId + prompt 指纹（R1）。
 * 两者都不足 → 空串（调用方应跳过协调，避免把无关会话并到一起）。
 */
export function takeoverSessionKey(input: SessionIdentity): string {
  const takeoverId = String(input.takeoverId || '').trim()
  if (takeoverId) return `takeover:${takeoverId}`
  const workspaceId = String(input.workspaceId || '').trim()
  const prompt = String(input.prompt || '')
  if (!workspaceId || !prompt) return ''
  return `workspace:${workspaceId}|prompt:${fingerprintPrompt(prompt)}`
}

export class TakeoverSessionCoordinator {
  private readonly inflight = new Map<string, Promise<CreateSessionResult>>()
  /** 外部（DOM 回退）创建态：key → 开始时间。与 inflight 共用门禁语义。 */
  private readonly external = new Map<string, number>()
  private readonly lastCreatedAt = new Map<string, number>()
  private readonly ids = new Map<string, string[]>()
  /** 已被释放（取消）的会话：reconcile / runCreate 不得复活它们（R4 唯一保留策略）。 */
  private readonly released = new Map<string, Set<string>>()
  private readonly now: () => number
  private readonly recoveryWindowMs: number
  private readonly externalCreateTtlMs: number
  private readonly log: TakeoverLog
  private readonly release: SessionReleaser | null

  constructor(options: CoordinatorOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.recoveryWindowMs = options.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS
    this.externalCreateTtlMs = options.externalCreateTtlMs ?? DEFAULT_EXTERNAL_CREATE_TTL_MS
    this.log = options.log ?? (() => { /* 无 log 注入时静默 */ })
    this.release = options.release ?? null
  }

  /**
   * 登记「外部正在建会话」（DOM 点击路径，R2）：门禁把它也算作创建中，
   * 避免面板在 DOM 阶梯等待期间把「正在创建」误判成「半截接管」再建一条。
   * `startedAt` 用于页面 reload 后按原时间恢复（不刷新 TTL）。
   */
  beginExternalCreate(input: SessionIdentity, startedAt: number = this.now()): string {
    const key = takeoverSessionKey(input)
    if (!key) return ''
    this.external.set(key, startedAt)
    return key
  }

  /** 外部建会话结束（成功/失败/已被清理）：解除创建态。 */
  endExternalCreate(key: string): void {
    if (key) this.external.delete(key)
  }

  /** 外部建会话是否仍在进行（超过 TTL 视为异常遗留，自动解除）。 */
  isExternalCreating(input: SessionIdentity): boolean {
    const key = takeoverSessionKey(input)
    if (!key) return false
    const at = this.external.get(key)
    if (at === undefined) return false
    if (this.now() - at >= this.externalCreateTtlMs) {
      this.external.delete(key)
      this.log('external_create_expired', { key, startedAt: at })
      return false
    }
    return true
  }

  /** 该接管是否正在创建（R2 门禁事实源）：API 创建中 或 外部（DOM 回退）创建中。 */
  isCreating(input: SessionIdentity): boolean {
    const key = takeoverSessionKey(input)
    if (!key) return false
    return this.inflight.has(key) || this.isExternalCreating(input)
  }

  /** 创建成功后是否仍在「不自动恢复」时间窗内（R3）。 */
  createdRecently(input: SessionIdentity): boolean {
    const key = takeoverSessionKey(input)
    if (!key) return false
    const at = this.lastCreatedAt.get(key) || 0
    if (!at) return false
    if (this.now() - at < this.recoveryWindowMs) return true
    // 窗口已过：顺手清理，避免长生命周期页面按 takeover 持续增长（Nit）
    this.lastCreatedAt.delete(key)
    return false
  }

  /** 面板自动恢复门禁：既不在创建中，也不在创建后的时间窗内（R2 + R3）。 */
  canAutoRecover(input: SessionIdentity): boolean {
    return !this.isCreating(input) && !this.createdRecently(input)
  }

  /**
   * 幂等建会话：同 key 的并发调用共享同一 Promise（R1）。
   * 只有真正创建的那次调用返回 `created:true`，负责 attach + clearPending。
   */
  createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const key = takeoverSessionKey(input)
    if (!key) return Promise.reject(new Error('takeover session key unavailable'))

    const running = this.inflight.get(key)
    if (running) {
      this.log('session_create_dedup_hit', {
        key,
        takeoverId: input.takeoverId || '',
        workspaceId: input.workspaceId,
      })
      return running.then((r) => ({
        sessionId: r.sessionId,
        created: false,
        cancelled: r.cancelled,
      }))
    }

    const promise = this.runCreate(key, input)
    this.inflight.set(key, promise)
    const cleanup = (): void => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key)
    }
    void promise.then(cleanup, cleanup)
    return promise
  }

  /**
   * 以服务端已登记会话为准对账（R4）：保留 registeredSessionId（或最新创建的），
   * 取消同一 key 下其它已跟踪会话。
   *
   * 唯一保留策略 = 「已登记优先」，但**不复活已释放会话**：
   * 若平台登记项其实已被本端取消（陈旧登记），退回保留最新跟踪项并留痕，
   * 避免同一 key 的 A/B 先后都被取消、最后谁也不留。
   */
  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const key = takeoverSessionKey(input)
    const registeredInput = String(input.registeredSessionId || '').trim()
    if (!key) return { kept: registeredInput, cancelled: [] }

    const tracked = (this.ids.get(key) || []).filter((id) => id && !this.isReleased(key, id))
    let registered = registeredInput
    if (registered && this.isReleased(key, registered)) {
      this.log('registered_session_released', { key, registeredSessionId: registered })
      registered = ''
    }
    const keep = registered || tracked[tracked.length - 1] || ''
    const extras = tracked.filter((id) => id !== keep)
    const cancelled: string[] = []
    for (const id of extras) {
      if (await this.cancelDuplicate(key, id, registered ? 'registered_session' : 'newest_session')) {
        cancelled.push(id)
      }
    }
    if (keep) this.ids.set(key, [keep])
    else this.ids.delete(key)
    if (cancelled.length) {
      this.log('duplicate_session_reconciled', { key, kept: keep, cancelled })
    }
    return { kept: keep, cancelled }
  }

  /** 仅供测试/诊断：当前跟踪的会话 id（不含已释放项）。 */
  trackedSessionIds(input: SessionIdentity): string[] {
    const key = takeoverSessionKey(input)
    return key ? [...(this.ids.get(key) || [])].filter((id) => !this.isReleased(key, id)) : []
  }

  private isReleased(key: string, sessionId: string): boolean {
    return Boolean(this.released.get(key)?.has(sessionId))
  }

  private markReleased(key: string, sessionId: string): void {
    let set = this.released.get(key)
    if (!set) {
      set = new Set()
      this.released.set(key, set)
    }
    set.add(sessionId)
    const tracked = this.ids.get(key) || []
    const left = tracked.filter((id) => id !== sessionId)
    if (left.length) this.ids.set(key, left)
    else this.ids.delete(key)
  }

  private async runCreate(key: string, input: CreateSessionInput): Promise<CreateSessionResult> {
    const sessionId = await input.create(input.workspaceId, input.prompt)
    this.lastCreatedAt.set(key, this.now())

    // 唯一保留策略：平台已登记的会话不取消（由 reconcile 决定最终保留项），已释放的不再跟踪
    const registered = String(input.registeredSessionId || '').trim()
    const previous = (this.ids.get(key) || []).filter(
      (id) => id && id !== sessionId && id !== registered && !this.isReleased(key, id),
    )
    const cancelled: string[] = []
    for (const id of previous) {
      if (await this.cancelDuplicate(key, id, 'newest_session')) cancelled.push(id)
    }
    const remaining = previous.filter((id) => !cancelled.includes(id))
    if (registered && !remaining.includes(registered) && !this.isReleased(key, registered)) {
      remaining.push(registered)
    }
    const next = [...new Set([...remaining, sessionId])]
    this.ids.set(key, next)

    this.log('takeover_session_created', {
      key,
      sessionId,
      takeoverId: input.takeoverId || '',
      workspaceId: input.workspaceId,
      cancelled,
    })
    return { sessionId, created: true, cancelled }
  }

  private async cancelDuplicate(key: string, sessionId: string, reason: string): Promise<boolean> {
    if (!this.release) {
      this.log('duplicate_session_cancel_skipped', { key, sessionId, reason: 'no_release_hook' })
      return false
    }
    try {
      const ok = await this.release(sessionId)
      if (ok) {
        this.markReleased(key, sessionId)
        this.log('duplicate_session_cancelled', { key, sessionId, reason })
        return true
      }
      this.log('duplicate_session_cancel_failed', { key, sessionId, reason: 'release_returned_false' })
      return false
    } catch (err) {
      this.log('duplicate_session_cancel_failed', {
        key,
        sessionId,
        reason: 'release_threw',
        error: String(err),
      })
      return false
    }
  }
}