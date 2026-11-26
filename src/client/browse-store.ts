/**
 * 右栏「资源浏览」的状态（client 侧，模块级单例）。
 *
 * 与 `store.ts`（实时观察窗的焦点）分开存放：两者数据来源完全不同 ——
 * 焦点是**被动**（工具结果里的标记），浏览是**主动**（用户点击 → 宿主代理取数）。
 *
 * 导航用**栈**：每层钻取压栈，面包屑/返回就是弹栈。
 *   仓库列表 → issue 列表 → 流水线详情
 *
 * 视图类型与数据都以 `unknown` 收口：宿主原样透传 CLI 的 JSON，
 * 面板在渲染时按已知字段**窄化**读取（缺字段就显示占位，不抛错）。
 */

import { useEffect, useState } from 'react'
import {
  loadLatestBrowseSnapshot,
  saveBrowseSnapshot,
  type StorageLike,
} from '../browse-snapshot.js'
import { issueSearchKeySuffix, normalizeIssueSearchQ } from '../issue-search.js'

/** 视图（导航栈的一层） */
export type BrowseView =
  | { kind: 'repos' }
  /** `platform` 取自 repo_key 前缀（gitcode / github / gitlab），随钻取带下去 */
  | {
    kind: 'issues'
    owner: string
    repo: string
    platform?: string
    /** 服务端搜索词（Issue #41）；空 / 缺省 = 默认列表（键形态与旧版一致） */
    q?: string
    /** 搜索结果页码（第 1 页可省略，仅 q 非空时有意义） */
    page?: number
  }
  | { kind: 'pipeline'; owner: string; repo: string; number: string; title?: string; platform?: string }

/** 单次取数的 timing（宿主 `/repos` 等响应携带，用于排障与回归对比） */
export interface ApiTiming {
  hostMs: number | null
  cache: 'hit' | 'miss'
  source: 'host' | 'cli'
  totalMs: number
}

/** 宿主代理返回的信封 */
export interface ApiEnvelope {
  ok: boolean
  data?: unknown
  baseUrl?: string
  code?: string
  message?: string
  timing?: ApiTiming
}

/** Grape 站点 baseUrl（由宿主随响应带下，用于拼官网逃生舱链接） */
let baseUrl = ''

/** 读取 Grape 站点 baseUrl（未取到时为空串） */
export function getBaseUrl(): string {
  return baseUrl
}

type Listener = () => void

/** 每层视图状态。`savedAt` = 数据时间（持久化快照 / 最近一次成功取数），供 UI 标注。 */
interface ViewState {
  loading: boolean
  error: string | null
  data: unknown
  savedAt?: number
}

/** 导航栈（栈顶 = 当前视图） */
let stack: BrowseView[] = [{ kind: 'repos' }]
/** 每层视图的加载状态（key = 视图指纹） */
const state = new Map<string, ViewState>()
const listeners = new Set<Listener>()

/** 浏览器 localStorage（Node/SSR 或隐私模式禁用时返回 null，持久化静默降级） */
function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const storage = browserStorage()

/** 当前账号（仅用于快照分键；由空仓库诊断里的账号名得到，未知时用 `-`） */
let account = ''

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** 从 /repos 的 diagnostics.viewer 取当前账号（宿主仅在空列表时下发） */
function viewerAccount(data: unknown): string {
  const viewer = asObj(asObj(asObj(data).diagnostics).viewer)
  return typeof viewer.username === 'string' ? viewer.username : ''
}

/** 是否由持久化快照 hydrate 出来的根数据（决定是否要 SWR 一次） */
let hydratedRoot = false
let rootRevalidated = false
/** hydrate 出来的快照属于哪个 baseUrl（用于识别环境切换，Issue #27 R2） */
let hydratedBaseUrl = ''

/**
 * 模块加载时还原根视图快照：先出旧数据（首字节 ≤50ms），后台再 revalidate。
 * 指针损坏 / schema 不符 → 静默忽略（`loadLatestBrowseSnapshot` 已兜底）。
 */
function restoreRootFromStorage(): void {
  const latest = loadLatestBrowseSnapshot(storage)
  if (!latest) return
  baseUrl = latest.baseUrl
  hydratedBaseUrl = latest.baseUrl
  account = latest.account
  state.set('repos', { loading: false, error: null, data: latest.data, savedAt: latest.savedAt })
  hydratedRoot = true
}

restoreRootFromStorage()

/** 根数据成功后落快照（写失败静默降级，不影响本次会话） */
function persistRoot(data: unknown): void {
  if (!baseUrl) return
  // 非空列表拿不到账号（viewer 只在空列表时下发）：此时用空账号键，
  // 绝不沿用上一个账号的名字 —— 否则会把 A 的账号写到 B 的数据上（Issue #27 R2）
  account = viewerAccount(data) || ''
  saveBrowseSnapshot(storage, { baseUrl, account, data })
}

function emit(): void {
  for (const l of listeners) {
    try { l() } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

/** 视图指纹（做缓存键 / 状态键）。
 *
 * 带上 platform：同一 owner/repo 可能同时存在于 GitCode 与 GitHub，
 * 只用 owner/repo 会让两者的数据互相覆盖。 */
export function viewKey(v: BrowseView): string {
  switch (v.kind) {
    case 'repos': return 'repos'
    case 'issues': return `issues:${v.platform || ''}:${v.owner}/${v.repo}${issueSearchKeySuffix(v.q ?? '', v.page ?? 1)}`
    case 'pipeline': return `pipeline:${v.platform || ''}:${v.owner}/${v.repo}#${v.number}`
  }
}

/**
 * 走宿主代理取 JSON（同源相对路径）。
 *
 * 用 `document.baseURI` 解析：dsh 支持子路径挂载（nginx /dsh/ 会剥前缀），
 * 相对解析在「根挂载」和「子路径挂载」两种情况下都对。
 */
export async function panelGet(path: string, qs: URLSearchParams): Promise<{ data?: unknown; message?: string; baseUrl?: string }> {
  const url = new URL(`grape-panel-api/${path}?${qs.toString()}`, document.baseURI).toString()
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  const body = (await res.json()) as ApiEnvelope
  if (body.baseUrl) baseUrl = body.baseUrl
  if (!body.ok) return { message: body.message || `HTTP ${res.status}`, baseUrl: body.baseUrl }
  return { data: body.data, baseUrl: body.baseUrl }
}

/**
 * 拉取该视图的数据（走宿主代理，同源相对路径）。
 *
 * @param silent - 后台 revalidate：不置 loading（避免旧数据闪成「加载中」），
 *                 失败时保留旧数据不打扰用户（stale-while-revalidate）。
 */
async function fetchView(v: BrowseView, force: boolean, opts: { silent?: boolean } = {}): Promise<void> {
  const key = viewKey(v)
  const prev = state.get(key)
  if (!opts.silent) {
    state.set(key, { loading: true, error: null, data: prev?.data ?? null, savedAt: prev?.savedAt })
    emit()
  }

  const qs = new URLSearchParams()
  if (v.kind === 'issues') {
    qs.set('owner', v.owner); qs.set('repo', v.repo)
    // 搜索词与页码只在搜索视图出现：默认列表请求参数与旧版完全一致
    if (v.q) {
      qs.set('q', v.q)
      if (v.page && v.page > 1) qs.set('page', String(v.page))
    }
  }
  if (v.kind === 'pipeline') {
    qs.set('owner', v.owner); qs.set('repo', v.repo); qs.set('number', String(v.number))
  }
  if (force) qs.set('force', '1')

  const path = v.kind === 'repos' ? 'repos' : v.kind === 'issues' ? 'issues' : 'pipeline'

  try {
    const { data, message, baseUrl: respBase } = await panelGet(path, qs)
    // 环境切换校验（Issue #27 R2）：hydrate 的根快照属于另一个 baseUrl 时不能继续展示，
    // 否则用户切环境后看到的是上一环境的仓库列表（revalidate 失败就一直错下去）。
    if (v.kind === 'repos' && hydratedBaseUrl && respBase && respBase !== hydratedBaseUrl) {
      hydratedRoot = false
      hydratedBaseUrl = ''
      state.delete(key)
    }
    if (message) {
      // 后台刷新失败：保留旧数据，但必须允许下次重试（Issue #27 R3：
      // 原来一次性 revalidate 失败后再也不刷，旧数据会一直显示且无提示）
      if (opts.silent) {
        if (key === 'repos') rootRevalidated = false
        return
      }
      state.set(key, { loading: false, error: message, data: null })
    } else {
      state.set(key, { loading: false, error: null, data, savedAt: Date.now() })
      if (v.kind === 'repos') persistRoot(data)
    }
  } catch (err) {
    if (opts.silent) {
      if (key === 'repos') rootRevalidated = false
      return
    }
    state.set(key, {
      loading: false,
      error: err instanceof Error ? err.message : String(err),
      data: null,
    })
  }
  emit()
}

/** 当前视图 */
export function currentView(): BrowseView {
  return stack[stack.length - 1]
}

/** 导航栈快照（面包屑用） */
export function viewStack(): BrowseView[] {
  return stack
}

/** 钻取到下一层 */
export function pushView(v: BrowseView): void {
  stack = [...stack, v]
  emit()
  void fetchView(v, false)
}

/** 返回上一层（到根则不动） */
export function popView(): void {
  if (stack.length <= 1) return
  stack = stack.slice(0, -1)
  emit()
}

/** 回到根 */
export function resetToRoot(): void {
  stack = [{ kind: 'repos' }]
  emit()
}

/** 强制刷新当前视图（流水线视图连带刷事件明细，否则「刷新」不会更新事件） */
export function refresh(): void {
  const v = currentView()
  void fetchView(v, true)
  if (v.kind === 'pipeline') ensureEvents(v.owner, v.repo, v.number, true)
}

/** 该视图的加载状态 */
export function viewState(v: BrowseView): ViewState {
  return state.get(viewKey(v)) ?? { loading: false, error: null, data: null }
}

/** 侧栏「当前仓库」—— 只读选择器（Issue #28） */
export interface CurrentRepo {
  owner: string
  repo: string
  platform?: string
}

/**
 * 取侧栏当前正在看的仓库（**只读，不发请求**）。
 *
 * 从视图栈顶往下找最近一层 `issues` / `pipeline`：用户可能在流水线详情里，
 * 此时仓库上下文仍是那一层。全程没进过仓库（只有 repos 根视图）→ null，
 * 由实时面板的「未选仓库」空态提示去浏览选一个。
 */
export function currentRepo(): CurrentRepo | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const v = stack[i]
    if (v.kind === 'issues' || v.kind === 'pipeline') {
      return { owner: v.owner, repo: v.repo, platform: v.platform }
    }
  }
  return null
}

/**
 * 读某仓库 `/issues` 的缓存状态（**只读，不发请求**）。
 *
 * 「自动预览」复用浏览面板已经拉过的同一份缓存；没拉过就返回空状态（loading=false、
 * data=null），由选择器给出 `no-issue` / 引导用户先去浏览。这样首次打开实时面板
 * 不会凭空 spawn 子进程，也不与 #27 的 fetch 路径冲突。
 */
export function cachedIssues(
  owner: string,
  repo: string,
  platform?: string,
): { loading: boolean; error: string | null; data: unknown; savedAt?: number } {
  const s = viewState({ kind: 'issues', owner, repo, platform })
  return { loading: s.loading, error: s.error, data: s.data, savedAt: s.savedAt }
}

/** 订阅 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 预览兜底：按仓库加载 `/issues`，**不改导航栈**。
 *
 * 为什么需要：实时页的「自动预览」是从浏览页的 `/issues` 缓存派生的。页面上一次刷新后
 * 导航栈回到根、缓存清空，预览卡就"消失"了（2026-11-20 实测）。这里提供只读加载入口，
 * 让实时页在"没有浏览上下文"时也能按（观察中的）仓库拉一次数据，把预览恢复出来。
 *
 * 语义约束：已有数据 / 正在加载 / 同 key 已有在飞请求 → 直接跳过，绝不重复打。
 */
const previewLoadInflight = new Set<string>()

/**
 * 读某个视图的状态（Issue #41：搜索视图不是导航栈顶，需要按视图键单独订阅）。
 *
 * 与 `useBrowse` 一样用「全局订阅 + 本地计数」触发重渲染，避免 `useSyncExternalStore`
 * 对可变对象的比较问题。
 */
export function useViewState(v: BrowseView): ViewState {
  const [, bump] = useState(0)
  useEffect(() => subscribe(() => bump((n) => n + 1)), [])
  return viewState(v)
}

/**
 * 搜索视图缓存新鲜期（毫秒，Issue #41 复审 Optional）。
 *
 * 默认列表的缓存由进入/刷新页签驱动，搜索视图则在会话内被反复命中：不设 TTL 时
 * 同一检索词在本次会话内永远拿旧数据。超过该时长再进入同一搜索视图 → 强制重取
 * （绕过宿主 5min 缓存）；面板另有手动「刷新」按钮。
 */
export const ISSUE_SEARCH_TTL_MS = 60_000

/**
 * 按仓库加载 `/issues`（**不改导航栈**）；`q` 非空时即服务端搜索取数入口（Issue #41）。
 *
 * 语义约束：已有数据 / 正在加载 / 同 key 已有在飞请求 → 直接跳过，绝不重复打；
 * 搜索视图数据超过 `ISSUE_SEARCH_TTL_MS` 则视为过期并强制重取。
 * `q` / `page` 进入视图键：搜 A 与搜 B、第 1 页与第 2 页各自独立缓存，互不覆盖。
 * `force` 只给「重试 / 刷新」用：跳过缓存与在途去重，重新取一次。
 */
export function ensureIssuesLoaded(
  owner: string,
  repo: string,
  platform?: string,
  q?: string,
  page = 1,
  force = false,
): void {
  if (!owner || !repo) return
  const term = normalizeIssueSearchQ(q)
  const v: BrowseView = {
    kind: 'issues', owner, repo, platform,
    q: term || undefined,
    page: term && page > 1 ? Math.trunc(page) : undefined,
  }
  const key = viewKey(v)
  let forceFetch = force
  if (!force) {
    const s = state.get(key)
    if (s?.loading || previewLoadInflight.has(key)) return
    if (s?.data) {
      // 默认列表保持旧语义（有数据即跳过）；搜索视图按 savedAt 判过期
      const stale = term !== '' && s.savedAt != null && Date.now() - s.savedAt >= ISSUE_SEARCH_TTL_MS
      if (!stale) return
      forceFetch = true
    }
  }
  previewLoadInflight.add(key)
  void fetchView(v, forceFetch).finally(() => { previewLoadInflight.delete(key) })
}

/**
 * React 订阅钩子：任意状态变化触发重渲染，返回当前视图 + 其状态 + 导航栈。
 *
 * 这里不用 `useSyncExternalStore`：栈与状态是两个独立可变对象，
 * 用一次订阅 + 本地 version 计数最简单可靠。
 */
export function useBrowse(): {
  view: BrowseView
  state: ViewState
  stack: BrowseView[]
} {
  const [, bump] = useState(0)
  useEffect(() => subscribe(() => bump((n) => n + 1)), [])
  const view = currentView()
  return { view, state: viewState(view), stack: viewStack() }
}

/**
 * 首次挂载时若根视图还没数据则拉一次。
 * 面板切到「浏览」模式时调用（懒加载：不切就不发请求）。
 *
 * 若数据来自持久化快照：先渲染旧数据，再**静默** revalidate 一次（SWR）。
 * 每次会话只 revalidate 一次，避免面板重渲染时反复触发。
 */
export function ensureRootLoaded(): void {
  const current = state.get('repos')
  // 没有状态、或上次失败且没有可展示数据 → 都重新取（Issue #27 R3：
  // 原来 state 存在就再也不取，一次失败/预热失败会把错误态永久钉死）
  if (!current || (current.error && current.data == null)) {
    void fetchView({ kind: 'repos' }, false)
    return
  }
  if (hydratedRoot && !rootRevalidated) {
    rootRevalidated = true
    void fetchView({ kind: 'repos' }, false, { silent: true })
  }
}

/** 根视图数据超过这个时长（毫秒）再打开「浏览」就静默重取一次 */
export const ROOT_STALE_MS = 60_000

/**
 * 切回「浏览」时若根数据已过期就静默 revalidate（SWR）。
 *
 * 为什么需要：浏览视图没有轮询，`ensureRootLoaded` 有数据就直接 return，
 * 所以「在别处取消了需求 / 新建了 issue」之后，页签会一直显示打开时那一刻的快照
 * （实测：#1/#2 已在平台取消，面板仍显示「活跃」）。
 *
 * 只按「打开页签」这个真实意图触发一次，不做定时轮询 —— 每次取数都要 spawn
 * 一个 grape CLI（~0.7s），定时刷新会白白烧进程。
 */
export function ensureFreshRoot(maxAgeMs = ROOT_STALE_MS): void {
  const cur = state.get('repos')
  if (!cur?.data || cur.loading) return
  if (cur.savedAt && Date.now() - cur.savedAt < maxAgeMs) return
  void fetchView({ kind: 'repos' }, false, { silent: true })
}

/** 根数据的时间戳（用于面板标注「数据 HH:MM」；尚无数据时为 null） */
export function rootSavedAt(): number | null {
  return state.get('repos')?.savedAt ?? null
}

/** 预热延迟：给 pins 恢复轮询（0/150/300ms 错峰）留出 CPU，不与首屏抢 */
export const PREWARM_DELAY_MS = 400

let prewarmScheduled = false

/**
 * 空闲预热根视图 `/repos`。
 *
 * 「悬浮浏览 Tab 预热」在不改 `GrapeTab.tsx`（文件边界）的前提下用等价实现：
 * 模块加载后等一次 idle + 400ms，再走与面板挂载相同的 `ensureRootLoaded`（含去重）。
 * 后台标签页不预热。重复调用幂等。
 */
export function prewarmRoot(): void {
  if (prewarmScheduled) return
  prewarmScheduled = true
  if (typeof window === 'undefined') return

  const start = (): void => {
    if (typeof document !== 'undefined' && document.hidden) return
    ensureRootLoaded()
  }
  const idle = (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  }).requestIdleCallback
  if (typeof idle === 'function') idle(() => { window.setTimeout(start, PREWARM_DELAY_MS) }, { timeout: 1_500 })
  else window.setTimeout(start, PREWARM_DELAY_MS)
}

// 模块加载时不再自动预热（Issue #27 R4）：应用启动就对 /repos 发请求，会让从不打开
// 浏览页签的用户也 spawn 一次 CLI，且配置未就绪时打到默认 localhost 并写进失败缓存。
// 现在由 GrapeTab 的鼠标进入（真实意图）触发。
// ─────────────────── 仓库概览（P4，`dashboard repo`）───────────────────
//
// 与视图数据**分开缓存**：概览是**仓库级**的（进 issue 列表和进流水线详情都算同一个仓库），
// 用 owner/repo 做键而不是视图指纹，来回钻取不会重复拉。

interface DashEntry { loading: boolean; error: string | null; data: unknown }

const dashState = new Map<string, DashEntry>()
const dashInflight = new Set<string>()

function dashKey(owner: string, repo: string): string {
  return `${owner}/${repo}`
}

/** 该仓库的概览状态（没拉过则返回未加载态） */
export function dashboardState(owner: string, repo: string): DashEntry {
  return dashState.get(dashKey(owner, repo)) ?? { loading: false, error: null, data: null }
}

/**
 * 拉一次仓库概览（已有数据或在途则跳过）。
 *
 * 概览卡默认**收起**只显示一行摘要，所以必须在进入仓库时就拉 ——
 * 否则摘要行会一直空着。宿主侧对该接口做了投影（原始 64KB → 几 KB）。
 */
export function ensureDashboard(owner: string, repo: string, force = false): void {
  const key = dashKey(owner, repo)
  if (!force && (dashState.get(key)?.data || dashInflight.has(key))) return
  dashInflight.add(key)
  dashState.set(key, { loading: true, error: null, data: dashState.get(key)?.data ?? null })
  emit()

  const qs = new URLSearchParams({ owner, repo })
  if (force) qs.set('force', '1')
  void (async () => {
    try {
      const { data, message } = await panelGet('dashboard', qs)
      if (message) dashState.set(key, { loading: false, error: message, data: null })
      else dashState.set(key, { loading: false, error: null, data })
    } catch (err) {
      dashState.set(key, { loading: false, error: err instanceof Error ? err.message : String(err), data: null })
    } finally {
      dashInflight.delete(key)
      emit()
    }
  })()
}

// ─────────────────── issue 事件明细（P5，`issues events`）───────────────────
//
// 与视图数据分开缓存：pipeline 视图给的是**阶段节点**，events 给的是**每个事件**
// （实测 #11：5 个节点 vs 17 条事件）。两者同键范围，但生命周期不同 ——
// 刷新时要各刷各的。

interface EventsEntry { loading: boolean; error: string | null; data: unknown }

const eventsState = new Map<string, EventsEntry>()
const eventsInflight = new Set<string>()

function eventsKey(owner: string, repo: string, number: string): string {
  return `${owner}/${repo}#${number}`
}

/** 该 issue 的事件明细状态 */
export function eventsFor(owner: string, repo: string, number: string): EventsEntry {
  return eventsState.get(eventsKey(owner, repo, number)) ?? { loading: false, error: null, data: null }
}

/** 拉一次事件明细（已有数据或在途则跳过） */
export function ensureEvents(owner: string, repo: string, number: string, force = false): void {
  const key = eventsKey(owner, repo, number)
  if (!force && (eventsState.get(key)?.data || eventsInflight.has(key))) return
  eventsInflight.add(key)
  eventsState.set(key, { loading: true, error: null, data: eventsState.get(key)?.data ?? null })
  emit()

  const qs = new URLSearchParams({ owner, repo, number: String(number) })
  if (force) qs.set('force', '1')
  void (async () => {
    try {
      const { data, message } = await panelGet('events', qs)
      if (message) eventsState.set(key, { loading: false, error: message, data: null })
      else eventsState.set(key, { loading: false, error: null, data })
    } catch (err) {
      eventsState.set(key, { loading: false, error: err instanceof Error ? err.message : String(err), data: null })
    } finally {
      eventsInflight.delete(key)
      emit()
    }
  })()
}

// ─────────────────── 取焦点（P3「跟随此 issue」）───────────────────

/**
 * 向宿主要一个 pipeline 焦点（宿主用 `pipelineFocus` + `extractPipelineSummary` 构造，
 * 与 AI 调工具产生的焦点**同形** —— 详见 panel-api.ts 该路由的注释）。
 *
 * 不在前端自己拼焦点对象：那样两边字段迟早会漂移，实时面板就得维护两套渲染口径。
 *
 * @returns 焦点对象；失败时返回错误消息
 */
export async function fetchPipelineFocus(
  owner: string,
  repo: string,
  number: string,
): Promise<{ focus?: unknown; message?: string }> {
  const qs = new URLSearchParams({ owner, repo, number: String(number) })
  try {
    const { data, message } = await panelGet('focus', qs)
    if (message) return { message }
    return { focus: data }
  } catch (err) {
    return { message: err instanceof Error ? err.message : String(err) }
  }
}
