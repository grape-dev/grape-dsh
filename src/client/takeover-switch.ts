/**
 * 接管后的前端切换逻辑。
 *
 * 独立成文件而不是挂在 index.tsx：入口要用它，GrapeFocusPanel 也要用它，
 * 挂在入口里会让两边互相 import 形成循环依赖。
 *
 * 为什么走 DOM 而不是宿主 API：dsh 的 session 只有经前端「New session in <workspace>」创建才规范
 * （session-<uuid>、绑定 workspace、落盘）。宿主侧 sessions.create 产出的是内部序号 id，打不开。
 *
 * 为什么要点完 reload 一次：`workspaceRegistry.create()` 只写服务端注册表，dsh 前端只在页面
 * 加载时拉一次 workspace 列表，新注册的 workspace 不在 DOM 里，找不到「New session in X」。
 *
 * 2026-11-10 修复（真机踩坑）：
 *   ① 冷启动时侧栏 4 秒可能还没渲染完 → 旧实现静默放弃，表现为"工作区有了、没有新会话"。
 *      现在窗口拉到 30 秒，失败会 setNotice 出来，并把 pending 留在 localStorage。
 *   ② reload 后 sessionStorage 若丢失（新标签/宿主重开）就走 localStorage 兜底。
 *   ③ 发送后要验证 composer 真的清空（= 消息已发出）；没清空就重试一次，再失败转剪贴板。
 *   ④ 面板提供「继续接管」按钮（pending 存在时），不用重新调服务端。
 */

import { setNotice } from './pins-store.js'
import {
  DEFAULT_EXTERNAL_CREATE_TTL_MS,
  TakeoverSessionCoordinator,
  takeoverSessionKey,
} from '../takeover-session.js'
import type { SessionIdentity } from '../takeover-session.js'
import { stopLocalSession } from './session-ctl.js'

/**
 * 把接管流程的落点回传到插件 host（console.log → journalctl -u dsh-web）。
 *
 * 为什么需要：浏览器 console 在 SSH/远端的场景不好取，而"卡在哪一步"必须可观测。
 * fire-and-forget，绝不能影响主流程。
 */
export function tkLog(step: string, extra: Record<string, unknown> = {}): void {
  try {
    fetch(new URL('grape-worker-api/takeover-log', document.baseURI).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step, ...extra }),
    }).catch(() => { /* ignore */ })
  } catch { /* ignore */ }
}

const PROMPT_KEY = 'grape.takeover.prompt'
const WS_KEY = 'grape.takeover.workspace'
const WS_NAME_KEY = 'grape.takeover.workspaceName'
const RELOADED_KEY = 'grape.takeover.reloaded'
const TK_KEY = 'grape.takeover.id'
/**
 * UI（DOM 点击）与 API 两条建会话路径共用的持久化创建态：`<source>|<协调器 key>|<开始时间戳>`。
 *
 * 为什么落 stash 而不是只放内存：API 创建与 DOM 阶梯都可能跨页面 reload，in-flight
 * 与 10s 窗口都是内存态会全丢；reload 后若看不到创建态，会把「正在创建」误判成
 * 「半截接管」再调一次 apiSessionCreator，建出第二条会话。
 * 键名沿用 `grape.takeover.uiCreating`（旧页写下的标记升级后仍可识别）。
 */
const CREATING_KEY = 'grape.takeover.uiCreating'
/**
 * 「阶梯续做」意图标记：DOM 阶梯**自己**发起 reload 时写（`<协调器 key>|<时间戳>`）。
 *
 * 与 CREATING_KEY 语义相反：创建态表示「可能已经建出会话，别再建一条」；本标记表示
 * 「一个会话都还没建，这次 reload 是阶梯为了拿到新的 workspace 列表自己刷的，新页
 * 应当继续做」。新页 `resumeTakeoverAfterReload` 读到它就不再判为「创建仍在进行」。
 */
const LADDER_RELOAD_KEY = 'grape.takeover.ladderReload'

const ROW_WAIT_TRIES = 120      // 120 × 250ms = 30s（冷启动足够）
const ROW_WAIT_TRIES_MANUAL = 60
const COMPOSER_WAIT_TRIES = 120  // 30s
const SEND_ENABLE_TRIES = 60     // 12s
const SEND_CONFIRM_TRIES = 20    // 5s

// ── 暂存：sessionStorage 优先，localStorage 兜底（跨 reload / 跨标签） ──

function _stashSet(key: string, val: string): void {
  try { sessionStorage.setItem(key, val) } catch { /* ignore */ }
  try { localStorage.setItem(key, val) } catch { /* ignore */ }
}

function _stashGet(key: string): string {
  let v = ''
  try { v = sessionStorage.getItem(key) || '' } catch { /* ignore */ }
  if (!v) {
    try { v = localStorage.getItem(key) || '' } catch { /* ignore */ }
  }
  return v
}

function _stashClear(): void {
  // TK_KEY 一并清：否则下次接管无 takeoverId 时会沿用旧 id，create 与面板 reconcile
  // 算出的去重 key 不一致（takeover:… vs workspace:…），R1/R4 在该路径失效。
  for (const k of [PROMPT_KEY, WS_KEY, WS_NAME_KEY, RELOADED_KEY, TK_KEY, CREATING_KEY, LADDER_RELOAD_KEY]) {
    try { sessionStorage.removeItem(k) } catch { /* ignore */ }
    try { localStorage.removeItem(k) } catch { /* ignore */ }
  }
  _creatingForget()
}

// ── 建会话创建态（API + UI 回退）：纳入协调器门禁 + stash 持久化（Issue #43 R2） ──

/** 本页建会话进行中的协调器 key（API 或 DOM；页面 reload 后为空，靠 stash 标记恢复）。 */
let creatingKey = ''

/**
 * 创建态标记因 TTL 到期被解除的协调器 key：表示「上一页建会话结果未知」——
 * 可能已经建出会话（attach/底稿丢了），也可能根本没建。恢复前提示用户，别默默再建一条。
 */
const unknownOutcomeKeys = new Set<string>()

type CreatingSource = 'api' | 'ui'

/**
 * 解析创建态标记。格式 `<source>|<key>|<at>`；旧版只写过 `<key>|<at>`
 * （当时只有 UI 回退路径），按 ui 兼容解析。key 自身可能含 `|`（workspace+prompt 指纹），
 * 所以只用首个 `|` 切来源、最后一个 `|` 切时间戳。
 */
function _creatingMarker(): { source: CreatingSource; key: string; at: number } | null {
  const raw = _stashGet(CREATING_KEY)
  if (!raw) return null
  const sep = raw.lastIndexOf('|')
  if (sep <= 0) return null
  const head = raw.slice(0, sep)
  const at = Number(raw.slice(sep + 1))
  if (!head || !Number.isFinite(at) || at <= 0) return null
  const tag = head.indexOf('|')
  const maybeSource = tag > 0 ? head.slice(0, tag) : ''
  if (maybeSource === 'api' || maybeSource === 'ui') {
    const key = head.slice(tag + 1)
    if (!key) return null
    return { source: maybeSource, key, at }
  }
  return { source: 'ui', key: head, at }
}

/** 解除创建态（内存 + stash）。创建成功/最终失败、以及底稿清理时调用。 */
function _creatingForget(): void {
  const marker = _creatingMarker()
  for (const k of new Set([creatingKey, marker?.key || ''])) {
    if (k) sessionCoordinator.endExternalCreate(k)
  }
  creatingKey = ''
  try { sessionStorage.removeItem(CREATING_KEY) } catch { /* ignore */ }
  try { localStorage.removeItem(CREATING_KEY) } catch { /* ignore */ }
}

function _creatingBegin(identity: SessionIdentity, source: CreatingSource = 'ui'): void {
  const key = sessionCoordinator.beginExternalCreate(identity)
  if (!key) return
  creatingKey = key
  _stashSet(CREATING_KEY, `${source}|${key}|${Date.now()}`)
}

/**
 * 建会话（API 或 DOM）是否仍未结束：本页内存态优先；页面 reload 后按 stash 标记恢复登记
 * （沿用标记时间，不刷新 TTL，避免长时间停留把门禁永久关掉）。
 */
function _creatingActive(identity: SessionIdentity, source?: CreatingSource): boolean {
  const marker = _creatingMarker()
  if (!marker) return false
  const key = takeoverSessionKey(identity)
  if (!key || marker.key !== key) {
    _creatingForget()
    return false
  }
  if (Date.now() - marker.at >= DEFAULT_EXTERNAL_CREATE_TTL_MS) {
    // TTL 到期 = 上一页的建会话结果未知（create 可能已在服务端建成，只是 attach/底稿丢了）。
    // 记一次性信号，恢复前提示用户先看侧栏，避免不声不响再建一条（复审 Optional）。
    unknownOutcomeKeys.add(key)
    tkLog('creating_state_expired', { key, ageMs: Date.now() - marker.at })
    _creatingForget()
    return false
  }
  // 只关心某一条路径来源时（如 API 恢复要 join API in-flight），不匹配也不清标记 —— 另一条
  // 路径仍在创建中，标记必须保留给 reload / 面板门禁使用。
  if (source && marker.source !== source) return false
  if (!sessionCoordinator.isExternalCreating(identity)) {
    sessionCoordinator.beginExternalCreate(identity, marker.at)
  }
  return true
}

// ── 阶梯自发起 reload 的「续做」意图（Issue #43 复审回归修复） ──

/**
 * 阶梯在 `location.reload()` 前调用：清掉创建态（此刻一个会话都没建，标记已无意义）
 * 并写「本次 reload 由阶梯续做」的意图，新页据此继续接管而不是静默跳过。
 */
function _reloadForLadder(identity: SessionIdentity): void {
  _creatingForget()
  const key = takeoverSessionKey(identity)
  if (key) _stashSet(LADDER_RELOAD_KEY, `${key}|${Date.now()}`)
  try { sessionStorage.setItem(RELOADED_KEY, '1') } catch { /* ignore */ }
  tkLog('ladder_reload_for_workspace_list', { key, workspaceId: identity.workspaceId })
}

/**
 * 取并消费「阶梯续做」意图（一次性）：key 需与本页的接管一致，且未超过创建态 TTL
 * （否则是上一次遗留，不能当成本次 reload 的依据）。无论命中与否都清掉，避免跨接管复用。
 */
function _consumeLadderReload(identity: SessionIdentity): boolean {
  const raw = _stashGet(LADDER_RELOAD_KEY)
  if (!raw) return false
  try { sessionStorage.removeItem(LADDER_RELOAD_KEY) } catch { /* ignore */ }
  try { localStorage.removeItem(LADDER_RELOAD_KEY) } catch { /* ignore */ }
  const sep = raw.lastIndexOf('|')
  if (sep <= 0) return false
  const key = raw.slice(0, sep)
  const at = Number(raw.slice(sep + 1))
  if (!key || !Number.isFinite(at) || at <= 0) return false
  if (Date.now() - at >= DEFAULT_EXTERNAL_CREATE_TTL_MS) return false
  return key === takeoverSessionKey(identity)
}

/** 取出「上一页建会话结果未知」的一次性信号（Optional：TTL 到期后再建一条前先提醒）。 */
function _takeUnknownOutcome(identity: SessionIdentity): boolean {
  const key = takeoverSessionKey(identity)
  if (!key || !unknownOutcomeKeys.has(key)) return false
  unknownOutcomeKeys.delete(key)
  tkLog('creating_outcome_unknown', { key })
  return true
}

/** 建会话结果未知时给用户看的提示：无法确认上一页是否已建出会话，先让用户看一眼侧栏。 */
function _noticeUnknownOutcome(): void {
  setNotice(
    '上一次建会话的结果无法确认（上一页可能已经建出了会话）。已继续恢复；' +
    '若侧栏出现两条同任务会话，保留一条，另一条请手动停掉（平台已登记的会话会尝试自动停）。',
    25000,
  )
}

/** 是否有"服务端已接管、本地会话还没开起来"的待办（供面板显示「继续接管」）。 */
/**
 * 接管结束（finish / abort）后清掉本地暂存的 prompt / workspace / takeoverId。
 *
 * 不清的后果（实测）：放弃接管后 TakeoverBar 会一直显示"接管 prompt 已暂存…继续接管"，
 * 但那条接管已经 aborted、token 也吊销了 —— 点"继续接管"只会建出一个空会话。
 */
export function clearPendingTakeover(): void {
  _stashClear()
  try { sessionStorage.removeItem(RELOADED_KEY) } catch { /* ignore */ }
  try { localStorage.removeItem(RELOADED_KEY) } catch { /* ignore */ }
}

/** 把会话 id 回写 Grape（面板据此显示"本地会话"与"打开本地会话"）。 */
export function attachSessionToGrape(takeoverId: string, sessionId: string): void {
  if (!takeoverId || !sessionId) return
  fetch(new URL('grape-worker-api/takeover-attach', document.baseURI).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ takeover_id: takeoverId, client_session: sessionId, host: location.hostname }),
  }).catch(() => { /* attach 失败不影响会话本身 */ })
}

/** 底稿里记录的 takeoverId（校验"这条接管是否还活着"用）。 */
export function getPendingTakeoverId(): string {
  return _stashGet(TK_KEY)
}

/**
 * 建会话的单一入口（Issue #43 R1）：switch / recover / retry 都走这里，
 * 由协调器按 takeoverId（优先）或 workspaceId+prompt 指纹做 in-flight 去重。
 *
 * 只有真正创建（created=true）的调用方负责 attach + clearPending，
 * 命中 in-flight 的调用方只共享 sessionId，避免重复 attach。
 */
async function createTakeoverSession(
  workspaceId: string,
  prompt: string,
  takeoverId: string,
): Promise<{ sessionId: string; created: boolean; cancelled: string[] }> {
  if (!apiSessionCreator) throw new Error('dsh sessions API unavailable')
  return sessionCoordinator.createSession({
    workspaceId,
    prompt,
    takeoverId,
    create: apiSessionCreator,
  })
}

/**
 * 自动恢复：用 dsh API 照着底稿把会话建出来 + 发 prompt。**只返回成功/失败，不做 UI 兜底**。
 * 面板挂载时先自动跑一次；失败才把「恢复接管会话」按钮给用户。
 */
export async function tryRecoverPendingTakeover(): Promise<boolean> {
  if (!hasPendingTakeover()) return false
  const wsId = _stashGet(WS_KEY)
  const prompt = _stashGet(PROMPT_KEY)
  const tid = _stashGet(TK_KEY)
  if (!apiSessionCreator || !wsId || !prompt) return false
  // UI 回退（DOM 点击）正在建会话：它已经占用了这次创建，不能再并行走 API 建一条（R2）。
  // API 路径创建中则继续往下走 createTakeoverSession，由协调器 join in-flight（R1/R5）。
  if (_creatingActive({ takeoverId: tid, workspaceId: wsId, prompt }, 'ui')) {
    tkLog('recover_skipped_ui_creating', { workspaceId: wsId, takeoverId: tid })
    return false
  }
  // 上一页建会话结果未知（创建态标记已 TTL 到期）→ 先提示用户看侧栏再继续恢复（Optional）
  if (_takeUnknownOutcome({ takeoverId: tid, workspaceId: wsId, prompt })) _noticeUnknownOutcome()
  try {
    const r = await createTakeoverSession(wsId, prompt, tid)
    if (!r.created) {
      // 另一个入口正在创建 / 已创建：共享它的结果，不重复 attach。
      tkLog('recover_joined_inflight', { sessionId: r.sessionId, workspaceId: wsId, takeoverId: tid })
      return true
    }
    tkLog('recover_session_created', { sessionId: r.sessionId, workspaceId: wsId, takeoverId: tid })
    attachSessionToGrape(tid, r.sessionId)
    clearPendingTakeover()
    setNotice(`接管会话已恢复：${r.sessionId.slice(0, 18)}…，prompt 已发进去。`, 20000)
    return true
  } catch (e) {
    tkLog('recover_failed', { workspaceId: wsId, takeoverId: tid, error: String(e) })
    return false
  }
}

export function hasPendingTakeover(): boolean {
  return Boolean(_stashGet(PROMPT_KEY)) && Boolean(_stashGet(WS_KEY))
}

/** 面板「继续接管」：手工再跑一次打开会话 + 发 prompt（不重新调服务端）。 */
export function retryPendingTakeover(): boolean {
  if (!hasPendingTakeover()) return false
  const wsId = _stashGet(WS_KEY)
  const wsName = _stashGet(WS_NAME_KEY)
  const prompt = _stashGet(PROMPT_KEY)
  const tid = _stashGet(TK_KEY)
  // 用户显式点「继续接管」= 主动放弃上一页遗留的创建态（否则 TTL 内会被门禁挡住）。
  _creatingForget()
  if (apiSessionCreator && wsId && prompt) {
    switchToTakeoverWorkspace(prompt, wsId, wsName, tid)
    return true
  }
  openSessionInWorkspace(wsId, wsName, false, ROW_WAIT_TRIES_MANUAL)
  return true
}

/**
 * 本地会话是否仍在磁盘上（宿主侧只读检查）。
 *
 * 为什么不用 DOM 判断：DSH 删掉会话后侧栏可能残留旧行/分组，点上去就会跳到「未分组」，
 * 让用户以为会话还在。磁盘目录才是唯一事实。
 *
 * **只有宿主明确回 `exists:false` 才判"已删除"**：旧宿主没有这个路由（404）、
 * 宿主异常、响应缺字段，都按"还在"处理 —— 否则会把好好的会话误标成「可恢复」。
 */
export async function localSessionExists(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  try {
    const r = await fetch(new URL('grape-worker-api/session-exists', document.baseURI).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    })
    if (!r.ok) return true
    const d = (await r.json().catch(() => ({}))) as { exists?: boolean }
    return d?.exists !== false
  } catch { return true }
}

/**
 * 切到任务 workspace 并开新会话，然后自动发送接管 prompt。
 */
export function switchToTakeoverWorkspace(
  prompt: string,
  workspaceId: string,
  workspaceName = '',
  takeoverId = '',
  sessionId = '',
): void {
  tkLog('switch_start', { workspaceId, workspaceName, promptLen: prompt.length, takeoverId, sessionId })
  // 宿主 API 已经建好会话并把 prompt 发进去了 → 只负责选中它（零点击派 生）
  if (sessionId) {
    openExistingSession(sessionId, workspaceId, workspaceName)
    return
  }
  // 单一事实源：始终覆盖写 TK_KEY（允许空串），create/recover/reconcile 都从 stash 取；
  // 仅在非空时写会让旧 stash 的 id 混进来，两边算出不同的去重 key。
  _stashSet(TK_KEY, takeoverId)
  _stashSet(PROMPT_KEY, prompt)
  _stashSet(WS_KEY, workspaceId)
  _stashSet(WS_NAME_KEY, workspaceName)
  try { sessionStorage.removeItem(RELOADED_KEY) } catch { /* ignore */ }

  const identity = { takeoverId, workspaceId, prompt }
  // 同一接管的 UI 回退还在建：它负责这次创建，别并行走 API 建第二条
  if (_creatingActive(identity)) {
    tkLog('switch_skipped_ui_creating', { workspaceId, takeoverId, promptLen: prompt.length })
    return
  }

  const runUiFallback = (): void => openSessionInWorkspace(workspaceId, workspaceName, true)

  if (!apiSessionCreator || !workspaceId) {
    runUiFallback()
    return
  }
  // Issue #43 R2：API 创建也纳入同一创建态标记（与 UI 回退共用 stash 键）。
  // in-flight 与 10s 窗口是内存态，reload 会全丢；标记落 stash 后，新页
  // resumeTakeoverAfterReload 在 TTL 内不会再次调用 apiSessionCreator。
  // 成败都由真正创建的一方解除（成功 attach 后 clearPendingTakeover；失败转 UI 回退时覆盖）。
  _creatingBegin(identity, 'api')
  void (async () => {
    try {
      const r = await createTakeoverSession(workspaceId, prompt, takeoverId)
      if (!r.created) {
        // 面板恢复先一步创建：共享它的结果，不重复 attach / clear。
        tkLog('session_created_shared', {
          sessionId: r.sessionId, workspaceId, promptLen: prompt.length, takeoverId,
        })
        return
      }
      tkLog('session_created_via_api', {
        sessionId: r.sessionId, workspaceId, promptLen: prompt.length, cancelled: r.cancelled,
      })
      setNotice(
        `已接管：会话 ${r.sessionId.slice(0, 18)}… 已创建在「${workspaceName || workspaceId}」，prompt 已发进去（侧栏可见）。`,
        20000,
      )
      attachSessionToGrape(takeoverId, r.sessionId)
      // 成功即清底稿：否则"接管中"面板会一直多出一个「恢复接管会话」按钮，
      // 再点一次就会建出第二条会话（同 prompt 重复跑）。
      clearPendingTakeover()
      return
    } catch (e) {
      tkLog('api_session_failed', { workspaceId, error: String(e) })
      setNotice(`dsh 接口建会话失败（${String(e).slice(0, 80)}），回退到 UI 方式…`, 15000)
    }
    runUiFallback()
  })()
}

/** 页面加载后接着做：reload 兜底路径。 */
export function resumeTakeoverAfterReload(
  logger?: { info?: (m: string) => void; warn?: (m: string) => void },
): void {
  const wsId = _stashGet(WS_KEY)
  const wsName = _stashGet(WS_NAME_KEY)
  const prompt = _stashGet(PROMPT_KEY)
  const takeoverId = _stashGet(TK_KEY)
  tkLog('resume_after_reload', { wsId, wsName, hasPrompt: Boolean(prompt) })
  if (!prompt) {
    // 没有底稿：上一页的创建态已失去意义，清掉避免 TTL 内误关门禁（阶梯续做意图同理）。
    _creatingForget()
    _consumeLadderReload({ takeoverId, workspaceId: wsId, prompt })
    return
  }
  const identity = { takeoverId, workspaceId: wsId, prompt }
  // 阶梯自发起 reload 的续做意图：reload 前一个会话都没建，标记已清，这里按「续做」处理，
  // 不再判为「创建仍在进行」（否则接管会静默悬空到 TTL 到期）。
  const ladderReload = _consumeLadderReload(identity)
  // Issue #43 R2：创建态标记在 TTL 内说明上一页可能已经建出会话（API 或 UI 回退），
  // 只是还没 attach / 发完 prompt。此时**不得**无条件清标记再建一条 —— 先不自动恢复，
  // 等 TTL 到期由面板重新判定，或用户点「继续接管」手动重试。
  if (!ladderReload && _creatingActive(identity)) {
    tkLog('resume_skipped_creating', { wsId, takeoverId })
    logger?.info?.(`[grape-dsh] takeover resume: create still in progress (${takeoverId || wsId}), skip auto create`)
    // 保守兜底：跳过时不能静默，否则用户看到的是「接管没了」。
    setNotice(
      '接管仍在创建中（上一页可能已经建出了会话），本次已暂缓自动恢复。' +
      '面板会在约 3 分钟内自动重试；若侧栏一直没出现会话，请重新点「接管」或手动 New session。',
      30000,
    )
    return
  }
  if (ladderReload) {
    tkLog('resume_ladder_continue', { wsId, takeoverId })
    logger?.info?.('[grape-dsh] takeover resume: continuing after ladder-initiated reload')
  } else if (_takeUnknownOutcome(identity)) {
    _noticeUnknownOutcome()
  }
  _creatingForget()
  // 同一个 workspace 只自动重试一次：它可能已经被 prune 掉了，
  // 每页刷新都干等 30 秒既没用又让人以为"接管卡住了"。用户仍可点「继续接管」手动重试。
  // 注意：这里**不**提前打"已尝试"标记 —— API 路径很快，失败一次也值得再试；
  // 只有慢速 DOM 阶梯彻底失败时才写标记（见 openSessionInWorkspace 的失败分支），
  // 避免工作区已被 prune 时每次刷新都白等 30 秒。
  if (wsId) {
    logger?.info?.(`[grape-dsh] takeover resume: opening session in workspace ${wsId}`)
    if (apiSessionCreator && wsId) {
      switchToTakeoverWorkspace(prompt, wsId, wsName, _stashGet(TK_KEY))
      return
    }
    openSessionInWorkspace(wsId, wsName, false)   // 已经 reload 过一次，别再 reload
    return
  }
  // 没有 workspaceId：旧路径，直接发到当前会话
  sendStashedPromptWhenReady(logger)
}

/**
 * 找到 workspace 行 → 点「New session in X」→ 发 prompt。
 */
/**
 * 会话已经由宿主 API 建好、prompt 也已发进去 → 前端只负责"把它选中显示出来"。
 * 只用一个与语言无关的选择器（data-row-key 是 session id），点不到就重试/提示刷新。
 */
export function openExistingSession(
  sessionId: string,
  workspaceId = '',
  workspaceName = '',
  onFail?: () => void,
): void {
  let n = 0
  /** 会话可能落在**别的 workspace 分组**里（分组默认折叠）→ 展开所有未展开的 workspace 行。 */
  const expandAll = (): void => {
    try {
      // 只点「明确处于折叠状态」的分组：没有 aria-expanded 属性的行不去碰 ——
      // 否则 !aria-expanded=='true' 会把已经展开的分组点成折叠，反而藏起目标会话。
      const rows = Array.from(
        document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]'),
      ) as HTMLElement[]
      for (const row of rows) row.click()
    } catch { /* DOM 结构变化时忽略 */ }
  }
  const tick = (): void => {
    n += 1
    const row = document.querySelector(`[data-row-key="session:${sessionId}"]`) as HTMLElement | null
    if (row) {
      row.click()
      tkLog('session_selected', { sessionId, tries: n })
      setNotice(`已接管：会话 ${sessionId.slice(0, 18)}… 已在侧栏打开，prompt 已发进去。`, 20000)
      return
    }
    // 第一次找不到就先展开分组（比原来"只展览指定 workspace"更通用：接管会话可能建在
    // 别的 workspace 下，例如连续接管 #18/#16/#15 时各自一个 workspace）
    if (n === 1 || n === 6) expandAll()
    if ((n === 2 || n === 10) && workspaceId) {
      const wsRow = document.querySelector(`[data-row-key="workspace:${workspaceId}"]`) as HTMLElement | null
      if (wsRow) {
        if (wsRow.getAttribute('aria-expanded') !== 'true') wsRow.click()
        tkLog('session_select_expand', { tries: n, workspaceName })
      }
    }
    // 40 × 150ms ≈ 6s（原来 80 × 250ms ≈ 20s，用户体感就是「点了没反应」）
    if (n < 40) {
      setTimeout(tick, 150)
      return
    }
    tkLog('session_select_failed', { sessionId, workspaceId, workspaceName })
    if (onFail) { onFail(); return }
    setNotice('接管已完成，但侧栏没定位到该会话（可能被折叠在其他分组里）。刷新一次页面或展开侧栏分组即可看到。', 25000)
  }
  setTimeout(tick, 120)
}

/**
 * 用 dsh 客户端会话服务建会话并把 prompt 发进去（不再模拟点击）。
 * 由 index.tsx 在 apply() 里注入（用到了 ctx.sessions）。
 */
type ApiSessionCreator = (workspaceId: string, prompt: string) => Promise<string>
let apiSessionCreator: ApiSessionCreator | null = null
export function setApiSessionCreator(fn: ApiSessionCreator | null): void {
  apiSessionCreator = fn
}

/**
 * 建会话并发协调器（Issue #43）。release 复用「停会话」链路：取消多余会话只打断
 * 当前这一轮，会话与上下文仍留在列表可回看。
 */
const sessionCoordinator = new TakeoverSessionCoordinator({
  log: (step, extra) => tkLog(step, extra),
  release: async (sessionId) => {
    const r = await stopLocalSession(sessionId)
    return r.ok
  },
})

/**
 * 面板自动恢复门禁（R2/R3）：API 创建中、UI（DOM 回退）创建中、或创建成功后 10s 内返回 false。
 * UI 回退的创建态会落 stash，页面 reload 后仍生效。
 */
export function canAutoRecoverPendingTakeover(): boolean {
  if (!hasPendingTakeover()) return false
  const workspaceId = _stashGet(WS_KEY)
  const prompt = _stashGet(PROMPT_KEY)
  if (!workspaceId || !prompt) return false
  const identity = { takeoverId: _stashGet(TK_KEY), workspaceId, prompt }
  if (_creatingActive(identity)) return false
  return sessionCoordinator.canAutoRecover(identity)
}

/**
 * 以服务端已登记会话为准对账（R4）：取消同一 takeover 下其它已跟踪会话，
 * 保留平台已登记的 client_session。幂等，可在面板轮询里重复调用。
 */
export function reconcileTakeoverSessions(takeoverId: string, registeredSessionId: string): void {
  if (!registeredSessionId) return
  // 去重 key 与 create/recover 同源：都从 stash 取 takeoverId（stash 为空才退回服务端 id），
  // 否则 create 用 `takeover:`、reconcile 用 `workspace:`，同一接管的会话永远对不上账。
  const stashTakeoverId = _stashGet(TK_KEY)
  const workspaceId = _stashGet(WS_KEY)
  const prompt = _stashGet(PROMPT_KEY)
  const identity = {
    takeoverId: stashTakeoverId || takeoverId,
    workspaceId,
    prompt,
  }
  if (!takeoverSessionKey(identity)) return
  void sessionCoordinator
    .reconcile({ ...identity, registeredSessionId })
    .then((r) => {
      if (r.cancelled.length) {
        tkLog('duplicate_session_reconciled', {
          takeoverId,
          kept: r.kept,
          cancelled: r.cancelled,
        })
      }
    })
    .catch(() => { /* 对账失败不影响主流程 */ })
}

/** 所有「New session in …」按钮（不依赖行内结构：dsh 的行渲染随状态变，行里可能暂时没有按钮）。 */
function _newSessionButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button[aria-label^="New session in "]')) as HTMLButtonElement[]
}

function _findNewSessionButton(workspaceName: string): HTMLButtonElement | null {
  const all = _newSessionButtons()
  if (!all.length) return null
  const want = workspaceName.trim()
  const exact = all.find((b) => (b.getAttribute('aria-label') || '').trim() === `New session in ${want}`)
  if (exact) return exact
  // 名字里可能混入省略/不可见字符 → 退化为包含匹配
  return all.find((b) => {
    const label = (b.getAttribute('aria-label') || '').trim()
    return want ? label.includes(want) : false
  }) || null
}

/** 顶栏的「New session」：对**当前 workspace** 生效（选中行之后的兜底入口）。 */
function _headerNewSessionButton(): HTMLButtonElement | null {
  return document.querySelector('button[aria-label="New session"]') as HTMLButtonElement | null
}

/**
 * 在目标 workspace 里开一个新会话并把 prompt 发进去。
 *
 * 为什么要"阶梯"而不是直接点行内按钮：实测 dsh 的 workspace 行**有时不渲染**
 * 「New session in …」按钮（同一行 60 次轮询 hasNewSessionBtn 全 false，见 takeover-log），
 * 只依赖它就会"工作区建好但永远不开会话"。现在依次尝试：
 *   ① 行内按钮 → ② 全文档按 aria-label 找 → ③ 点行选中该 workspace（草稿即目标）
 *   → ④ 顶栏 New session → ⑤ 刷新一次 → ⑥ 明确失败提示
 */
function openSessionInWorkspace(
  workspaceId: string,
  workspaceName: string,
  allowReload: boolean,
  maxTries = ROW_WAIT_TRIES,
): void {
  // DOM 点击建会话也纳入协调器创建态（R2）：等待行/发送的整段时间里，
  // 面板 load() 不得把「正在创建」当成「半截接管」再并行走 API 建一条。
  const identity = { takeoverId: _stashGet(TK_KEY), workspaceId, prompt: _stashGet(PROMPT_KEY) }
  _creatingBegin(identity)

  let tries = 0
  let rowClicked = false
  let headerClicked = false

  const finishWithNotice = (reason: string): void => {
    _creatingForget()
    tkLog('session_open_failed', {
      reason, workspaceId, workspaceName,
      workspaceRows: document.querySelectorAll('[data-row-key^="workspace:"]').length,
      newSessionButtons: _newSessionButtons().map((b) => b.getAttribute('aria-label')).slice(0, 5),
    })
    setNotice(
      `接管已在服务端建立，但自动打开会话失败（${reason}）。` +
      `点面板上的「继续接管」重试，或手动 New session in「${workspaceName || workspaceId}」。`,
      30000,
    )
  }

  const tick = (): void => {
    tries += 1

    // ⓪ 已经在目标 workspace 的草稿里（用户上次点过、或壳子已切好）→ 直接发
    if (tries === 1 && workspaceName && _currentWorkspaceLabel().includes(workspaceName.trim())) {
      const box = document.querySelector('[role=textbox]') as HTMLElement | null
      if (box) {
        tkLog('already_in_workspace', { workspaceName })
        sendStashedPrompt(box)
        return
      }
    }

    const row = document.querySelector(
      `[data-row-key="workspace:${workspaceId}"]`,
    ) as HTMLElement | null

    // ① 行内按钮
    const btn = row ? (row.querySelector('button[aria-label^="New session in "]') as HTMLButtonElement | null) : null
    if (btn) {
      btn.click()
      tkLog('new_session_clicked', { via: 'row_button', label: btn.getAttribute('aria-label') })
      waitForComposerThenSend(workspaceName || (btn.getAttribute('aria-label') || '').replace(/^New session in /, ''))
      return
    }

    // ② 全文档按 aria-label 找（行里没有，但按钮可能在别处渲染）
    const globalBtn = _findNewSessionButton(workspaceName)
    if (globalBtn) {
      globalBtn.click()
      tkLog('new_session_clicked', { via: 'global_button', label: globalBtn.getAttribute('aria-label') })
      waitForComposerThenSend(workspaceName || (globalBtn.getAttribute('aria-label') || '').replace(/^New session in /, ''))
      return
    }

    // ③ 点行（展开 + 选中）：草稿态就是该 workspace，之后直接发消息即成为会话
    if (row && !rowClicked) {
      row.click()
      rowClicked = true
      tkLog('row_clicked', { tries, workspaceName })
    }

    // ④ 顶栏 New session（对当前 workspace 生效）
    if (rowClicked && !headerClicked && tries > 4) {
      const hb = _headerNewSessionButton()
      if (hb) {
        headerClicked = true
        hb.click()
        tkLog('new_session_clicked', { via: 'header_button' })
        waitForComposerThenSend(workspaceName)
        return
      }
    }

    if (tries < maxTries) {
      setTimeout(tick, 250)
      return
    }

    // ⑤ 还没有行：workspace 刚注册、前端列表是旧的 → 刷新一次
    // ⚠️ 走到这里**还没有点过任何 New session**（一个会话都没建）：必须先清创建态标记、
    //    再写「阶梯续做」意图，否则新页 `resumeTakeoverAfterReload` 会把标记当成
    //    「创建仍在进行」直接 return，接管静默悬空到 TTL 到期（复审 Required）。
    if (!row && allowReload) {
      let alreadyReloaded = ''
      try { alreadyReloaded = sessionStorage.getItem(RELOADED_KEY) || '' } catch { /* ignore */ }
      if (!alreadyReloaded) {
        _reloadForLadder(identity)
        setNotice('工作区已就绪，正在刷新页面以打开新会话…', 20000)
        location.reload()
        return
      }
    }

    if (!row) {
      try { sessionStorage.setItem(`grape.takeover.resume_tried:${workspaceId}`, '1') } catch { /* ignore */ }
      finishWithNotice('工作区行 30 秒内未出现')
      return
    }
    // 行在、但三种入口都没生效 → 再给一次刷新的机会（列表/按钮渲染异常）
    if (allowReload) {
      let alreadyReloaded = ''
      try { alreadyReloaded = sessionStorage.getItem(RELOADED_KEY) || '' } catch { /* ignore */ }
      if (!alreadyReloaded) {
        _reloadForLadder(identity)
        setNotice('工作区已就绪，正在刷新页面以打开新会话…', 20000)
        location.reload()
        return
      }
    }
    finishWithNotice('没找到可用的 New session 入口')
  }
  setTimeout(tick, 300)
}

/** 顶栏「Choose workspace」的当前文案 = 当前会话所属 workspace 的显示名。 */
function _currentWorkspaceLabel(): string {
  const btn = document.querySelector('button[aria-label="Choose workspace"]')
  return (btn ? btn.textContent || '' : '').trim()
}

function waitForComposerThenSend(workspaceName = ''): void {
  let n = 0
  const want = workspaceName.trim()
  const tick = (): void => {
    n += 1
    const box = document.querySelector('[role=textbox]') as HTMLElement | null
    const label = _currentWorkspaceLabel()
    const switched = !want || label.includes(want)
    if (n % 8 === 1) tkLog('wait_switch', { tries: n, want, label, hasBox: Boolean(box), switched })
    if (box && switched) {
      tkLog('switched', { want, label })
      sendStashedPrompt(box)
      return
    }
    if (n < COMPOSER_WAIT_TRIES) setTimeout(tick, 250)
    else {
      _creatingForget()
      tkLog('session_open_failed', { reason: 'label_mismatch', want, label, hasBox: Boolean(box) })
      setNotice(
        `新会话未能切到「${want || '目标工作区'}」（当前：${label || '未知'}）：` +
        '请手动 New session in 该工作区后粘贴 prompt（已复制到剪贴板）。',
        30000,
      )
    }
  }
  setTimeout(tick, 300)
}

/** 没有 workspaceId 的旧路径：页面就绪后补发。 */
function sendStashedPromptWhenReady(logger?: { warn?: (m: string) => void }): void {
  let tries = 0
  const tick = (): void => {
    tries += 1
    if (document.querySelector('[role=textbox]')) {
      sendStashedPrompt()
      return
    }
    if (tries < 40) setTimeout(tick, 250)
    else logger?.warn?.('[grape-dsh] takeover resume: no composer found')
  }
  setTimeout(tick, 600)
}

function _liveComposer(prefer?: HTMLElement | null): HTMLElement | null {
  if (prefer && document.contains(prefer)) return prefer
  return document.querySelector('[role=textbox]') as HTMLElement | null
}

function _composerText(box: HTMLElement | null): string {
  const live = _liveComposer(box)
  if (!live) return ''
  return (live.innerText || live.textContent || '')
}

function _insert(box: HTMLElement, text: string): void {
  box.focus()
  document.execCommand('insertText', false, text)
}

/** 等到 Send 可用再点（composer 状态更新是异步的），点完确认内容真的清空。 */
function _clickSendWhenReady(
  box: HTMLElement,
  text: string,
  attempt: 1 | 2,
  onDone: () => void,
  onFail: () => void,
): void {
  let n = 0
  const tick = (): void => {
    n += 1
    const btn = document.querySelector('[aria-label="Send message"]') as HTMLButtonElement | null
    const live = _liveComposer(box)
    if (btn && !btn.disabled && live && _composerText(live).length > 0) {
      tkLog('send_clicked', { attempt, waitedTicks: n })
      btn.click()
      let m = 0
      const confirm = (): void => {
        m += 1
        if (_composerText(box).trim().length === 0) { onDone(); return }
        if (m < SEND_CONFIRM_TRIES) { setTimeout(confirm, 250); return }
        if (attempt === 1) {
          // 发送没成功：重新插入再试一次
          _insert(box, text)
          _clickSendWhenReady(box, text, 2, onDone, onFail)
          return
        }
        onFail()
      }
      setTimeout(confirm, 300)
      return
    }
    if (n < SEND_ENABLE_TRIES) { setTimeout(tick, 200); return }
    if (attempt === 1) {
      _insert(box, text)
      _clickSendWhenReady(box, text, 2, onDone, onFail)
      return
    }
    onFail()
  }
  tick()
}

/** 当前选中的会话行 → dsh session id（`data-row-key="session:<uuid>"`）。 */
function _selectedSessionId(): string {
  const el = document.querySelector('[data-row-key^="session:"][aria-selected="true"]')
  const key = el ? String(el.getAttribute('data-row-key') || '') : ''
  return key.replace(/^session:/, '')
}

/**
 * 把本地 session id 回写给服务端：面板据此显示「打开本地会话」，
 * 换标签/重开/多端时能跳回，而不是只剩一个 prompt。
 */
function _attachLocalSession(tid: string): void {
  // tid 由调用方在清底稿前取出（_stashClear 现在会连 TK_KEY 一起清）
  if (!tid) return
  const deadline = Date.now() + 10000
  const tick = (): void => {
    const sid = _selectedSessionId()
    if (sid) {
      fetch(new URL('grape-worker-api/takeover-attach', document.baseURI).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ takeover_id: tid, client_session: sid, host: location.hostname }),
      }).then(() => {
        _stashSet(TK_KEY, '')
        tkLog('session_attached', { client_session: sid })
      }).catch(() => { /* ignore */ })
      return
    }
    if (Date.now() < deadline) window.setTimeout(tick, 500)
    else tkLog('session_attach_skipped', { reason: 'no selected session row' })
  }
  tick()
}

/**
 * 打开已知的本地会话（面板按钮）：会话可能藏在折叠的 workspace 下 → 先展开再点。
 * 找不到 = 这条会话在别的机器上（多端场景），返回 false 让面板提示。
 */
export function openLocalSession(sessionId: string): boolean {
  if (!sessionId) return false
  const key = `session:${sessionId}`
  const hit = (): HTMLElement | null => document.querySelector(`[data-row-key="${key}"]`)
  const row = hit()
  if (row) { row.click(); return true }
  const ws = document.querySelector('[data-row-key^="workspace:"]') as HTMLElement | null
  ws?.click()
  window.setTimeout(() => hit()?.click(), 400)
  return Boolean(row)
}

/** 取出暂存的 prompt，填进 composer 并点发送；确认发出后清掉所有暂存键。 */
function sendStashedPrompt(box?: HTMLElement | null): void {
  const target = box ?? (document.querySelector('[role=textbox]') as HTMLElement | null)
  if (!target) return
  const pending = _stashGet(PROMPT_KEY)
  if (!pending) return

  // 先塞进剪贴板：发送失败时用户可以直接 cmd+v
  try { navigator.clipboard.writeText(pending) } catch { /* ignore */ }

  _insert(target, pending)
  tkLog('insert_done', { len: pending.length, live: document.contains(target) })
  _clickSendWhenReady(
    target,
    pending,
    1,
    () => {
      const tid = _stashGet(TK_KEY)
      _stashClear()
      tkLog('sent_confirmed')
      _attachLocalSession(tid)
      setNotice('接管上下文已发送到新会话，可以开始工作了。', 20000)
      console.info('[grape-dsh] takeover: prompt sent')
    },
    () => {
      tkLog('send_failed')
      setNotice('接管 prompt 已复制到剪贴板；自动发送失败，请在新会话里手动粘贴发送（或点「继续接管」）。', 30000)
      console.warn('[grape-dsh] takeover: auto-send failed, prompt kept in clipboard/storage')
    },
  )
}


// 调试句柄：面板/控制台里可以直接驱动接管切换（不含 secrets，仅路径与 prompt）。
// 面板按钮走的也是这些函数，出问题时能在 console 里单独跑一遍定位是哪一层。
try {
  ;(window as unknown as Record<string, unknown>).__grapeTk = {
    switchToTakeoverWorkspace,
    openExistingSession,
    openLocalSession,
    hasPendingTakeover,
    retryPendingTakeover,
    tkLog,
  }
} catch { /* ignore */ }
