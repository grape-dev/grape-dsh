/**
 * 「观察列表」（pin）—— 用户主动钉住、在实时界面并行观察的 issue（client 侧）。
 *
 * 与 `store.ts`（AI 焦点）的分工，是本设计的地基：
 *   store.ts  = **被动**槽位：AI 调工具 → 工具结果里的标记 → 单张焦点卡
 *   pins      = **主动**槽位：用户点「跟随此 issue」→ 加入列表 → 多张可展开卡
 * 两者语义不同（"AI 在做什么" vs "我要盯什么"），所以同屏并列而不合并。
 *
 * ## 数据
 * 每张卡只拉 `/pipeline`（实测 280ms，最便宜且信息足够：状态 + 节点链 + 摘要）。
 * 事件明细（`/events`）留在浏览面板里按需看，不进轮询 —— 否则每卡每轮都是两倍开销。
 *
 * ## 轮询
 * · 20s 一轮；宿主侧 30s TTL 缓存会吃掉一半请求 → 上游实际调用 ≤ 2 次/分/卡。
 * · **接管动作后**额外开 60s 加速窗口（`followPin`）：首拍立即、之后 4s 一拍，到期自动回落。
 * · `document.hidden` 时**停表**：后台标签页不该持续 spawn 子进程。恢复可见立刻补一次。
 * · 上限 8 张：约束子进程总量（单次 280ms，8 张 × 3 次/分 ≈ 每分钟 7 秒 CPU）。
 *
 * ## 渲染复用
 * `pinToFocus()` 把 pin 的数据组装成 `GrapeFocus`，直接交给实时面板现有的
 * `FocusBody` 渲染 —— **一条渲染路径**（与 P3「跟随用宿主构建器」同一个原则：
 * 同一种东西只维护一套渲染口径）。
 */

import { useEffect, useState } from 'react'
import type { GrapeFocus, GrapeFocusNode, GrapeStatusNum } from '../focus.js'
import { grapeAppUrl } from '../focus.js'
import { derivePipelineViewFromData } from '../pipeline-model.js'
import { startFollowWindow, type FollowWindowHandle } from '../follow-window.js'
import { getBaseUrl, panelGet } from './browse-store.js'
import { isValidIssueNumber } from '../issue-number.js'
import {
  PINS_STORAGE_KEY,
  loadPersistedPins,
  type PersistedPin,
  type StorageLike,
} from '../pins-persist.js'

/** 同时观察的上限（约束轮询成本） */
export const MAX_PINS = 8
/** 轮询间隔 */
export const POLL_MS = 20_000

/** 接管动作后的加速窗口时长 */
export const FOLLOW_MS = 60_000
/** 加速窗口内的取数间隔 */
export const FOLLOW_STEP_MS = 4_000

/**
 * 多张卡的取数错峰间隔。
 *
 * 每个 `/pipeline` 请求都会 spawn 一个 `grape` 子进程；N 张卡同时发起就是 N 个进程同时起。
 * 150ms 的间隔把它们串开，同时保持"每卡每 20s 一轮"的语义（整轮摊开 ≤ N×150ms）。
 */
const FETCH_STAGGER_MS = 150

export interface Pin {
  /** 'owner/repo#number' —— 天然去重键 */
  id: string
  owner: string
  repo: string
  /** Issue 编号（字符串：GitCode 整数与 Gitee 字母数字统一承载，Issue #39） */
  number: string
  /** 点击「跟随」时那一行已知的标题（省一次请求，也让收起态立刻有内容） */
  title: string
  platform?: string
  expanded: boolean
  /** `/pipeline` 的最新结果 */
  data: unknown | null
  loading: boolean
  error: string | null
  /** 数据时间戳（用于组装 GrapeFocus.ts 与陈旧判断） */
  updatedAt: number
  pinnedAt: number
}

// ── 极小取值器（与面板侧同形；放这里避免 import 面板组件）──
const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''

type Listener = () => void

/** 浏览器侧的 localStorage；非浏览器环境（Node 单测）返回 null，读存档直接早退 */
function browserStorage(): StorageLike | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

/**
 * 读存档（含旧 key 一次性迁移）。**任何异常都退化成空列表** —— 存档坏了不该把整个面板拖垮。
 *
 * 只存**身份**，不存拉到的数据：数据（流水线状态）会过期，存进去刷新后先展示一份过期状态；
 * 只留 owner/repo/number/title/platform，恢复后重新拉一次即可。
 * key 常量、解析与迁移都在 `pins-persist.ts`（纯逻辑，可单测）。
 */
function loadPersisted(): Pin[] {
  return loadPersistedPins(browserStorage())
    .map((v) => ({
      id: pinId(v.owner, v.repo, v.number),
      owner: v.owner,
      repo: v.repo,
      number: v.number,
      title: v.title,
      platform: v.platform,
      expanded: false,          // 展开态不持久化：恢复后一律收起，避免刷新后一屏卡片
      data: null,
      loading: false,           // 由下面的 bootstrap 立刻补拉
      error: null,
      updatedAt: 0,
      pinnedAt: v.pinnedAt,
    }))
    .slice(0, MAX_PINS)
}

/** 写存档。写失败（配额满 / 隐私模式）不影响本次会话，静默降级 */
function persist(): void {
  try {
    const storage = browserStorage()
    if (!storage) return
    const list: PersistedPin[] = pins.map((p) => ({
      owner: p.owner, repo: p.repo, number: p.number,
      title: p.title, platform: p.platform, pinnedAt: p.pinnedAt,
    }))
    storage.setItem(PINS_STORAGE_KEY, JSON.stringify(list))
  } catch { /* 见上 */ }
}

let pins: Pin[] = loadPersisted()
let seq = 0                       // 每次变更自增，供 useSyncExternalStore 判断"变了"
const listeners = new Set<Listener>()
let timer: number | null = null

/** 每张卡的加速窗口句柄（key = pin id）；移除/清空时统一清理，避免定时器泄漏 */
const followWindows = new Map<string, FollowWindowHandle>()

function emit(): void {
  seq += 1
  for (const l of listeners) {
    try { l() } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

/**
 * 一次性提示（"已加入观察" / "已在观察中" / "已达上限"）。
 *
 * ⚠️ 为什么提示必须放在这里、由**实时面板**渲染：
 * 点「跟随此 issue」会立刻切到实时模式 → 浏览面板随即卸载，
 * 任何写在浏览面板里的提示文案**用户永远看不到**（这是实测踩到的坑）。
 * 放在 list 里 + 实时面板渲染，无论落到哪一屏都能看见。
 */
let notice: string | null = null
let noticeTimer: number | null = null

/** 清掉提示 */
export function clearNotice(): void {
  if (notice === null) return
  notice = null
  if (noticeTimer !== null) { window.clearTimeout(noticeTimer); noticeTimer = null }
  emit()
}

/** 展示一条一次性提示（默认 3.5s 后自动消失） */
export function setNotice(text: string, ms = 3500): void {
  notice = text
  if (noticeTimer !== null) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => { notice = null; noticeTimer = null; emit() }, ms)
  emit()
}

/** 当前提示（无则 null） */
export function getNotice(): string | null {
  return notice
}

/** 用 patch 更新某张卡（找不到就返回原数组） */
function patch(id: string, next: Partial<Pin>): void {
  let hit = false
  pins = pins.map((p) => {
    if (p.id !== id) return p
    hit = true
    return { ...p, ...next }
  })
  if (hit) emit()
}

export function pinId(owner: string, repo: string, number: string): string {
  return `${owner}/${repo}#${number}`
}

/** 当前观察列表（引用稳定：仅变更时换新数组） */
export function getPins(): Pin[] {
  return pins
}

export function subscribePins(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** useSyncExternalStore 的快照（变更计数，天然稳定） */
export function pinsSnapshot(): number {
  return seq
}

export function hasPin(owner: string, repo: string, number: string): boolean {
  const id = pinId(owner, repo, number)
  return pins.some((p) => p.id === id)
}

/**
 * 某条 issue 的已知平台（来自本地 pin；未知返回空串，调用方按缺省 gitcode 处理）。
 *
 * 为什么从 pin 取：焦点卡（GrapeFocus）里没有平台字段，而接管请求必须带对平台
 * （Gitee 的 `owner/repo` 不能落到 GitCode 的同名仓库）。为这点信息扩大 focus 的
 * 跨端契约不划算 —— 用户观察/钻取的仓库平台本来就存在 pin 上。
 */
export function platformFor(owner: string, repo: string, number?: string): string {
  const hit = pins.find((p) => p.owner === owner && p.repo === repo && (!number || p.number === String(number)))
  return hit?.platform || ''
}

export type AddPinResult = 'added' | 'exists' | 'full' | 'invalid'

export type TogglePinForResult = 'pinned' | 'unpinned' | 'full' | 'invalid'

/**
 * 按 issue 身份切换观察状态（浏览列表里那个 pin 图标用它）。
 *
 * 放在 store 里而不是面板里：`pinId` 的拼法是 store 的内部细节，
 * 让面板自己去拼 id 迟早会和 store 拼得不一样（届时表现为"点了没反应"）。
 */
export function togglePinFor(input: {
  owner: string
  repo: string
  number: string
  title?: string
  platform?: string
}): TogglePinForResult {
  const { owner, repo, number } = input
  if (!owner || !repo || !isValidIssueNumber(number)) return 'invalid'
  if (hasPin(owner, repo, number)) {
    removePin(pinId(owner, repo, number))
    return 'unpinned'
  }
  const r = addPin(input)
  if (r === 'added' || r === 'exists') return 'pinned'
  return r === 'full' ? 'full' : 'invalid'
}

/** 加入观察列表（幂等；已存在则返回 'exists'） */
export function addPin(input: {
  owner: string
  repo: string
  number: string
  title?: string
  platform?: string
}): AddPinResult {
  const { owner, repo, number } = input
  if (!owner || !repo || !isValidIssueNumber(number)) return 'invalid'
  if (hasPin(owner, repo, number)) return 'exists'
  if (pins.length >= MAX_PINS) return 'full'

  const id = pinId(owner, repo, number)
  pins = [...pins, {
    id, owner, repo, number,
    title: input.title ?? '',
    platform: input.platform,
    expanded: false,                 // 默认收起：面板竖向空间有限，避免挤掉 AI 焦点卡
    data: null, loading: true, error: null,
    updatedAt: 0,
    pinnedAt: Date.now(),
  }]
  persist()
  emit()
  void fetchPin(id, false)           // 立刻拉一次：收起态也要有状态点与进度
  ensureTimer()
  return 'added'
}

/** 取消跟随 */
export function removePin(id: string): void {
  stopFollow(id)
  const before = pins.length
  pins = pins.filter((p) => p.id !== id)
  if (pins.length !== before) { persist(); emit() }
  if (!pins.length) stopTimer()
}

/** 展开 / 收起某张卡 */
export function togglePin(id: string): void {
  const p = pins.find((x) => x.id === id)
  if (p) patch(id, { expanded: !p.expanded })
}

/** 单卡强制刷新 */
export function refreshPin(id: string): void {
  void fetchPin(id, true)
}

/** 全部强制刷新 */
export function refreshAllPins(): void {
  for (const p of [...pins]) void fetchPin(p.id, true)
}

/**
 * 接管动作后的加速跟随：60s 内每 4s 强制拉一次 `/pipeline`，让下一节点尽快点亮。
 *
 * · 首个 tick 立即执行，调用方每拍都带 `force=1` —— 4s 间隔小于宿主 30s 缓存，
 *   不带 force 会一直读到旧数据，等于没加速（只绕缓存，不改宿主缓存语义）。
 * · 失败静默、下一拍重试；`document.hidden` 跳过该拍，回前台由下一拍补拉。
 * · 入口先 `stopFollow`：连点确认/放弃不会叠加定时器。
 * · 未被 pin 的 issue 直接返回，不受影响。
 */
export function followPin(id: string, durationMs = FOLLOW_MS, stepMs = FOLLOW_STEP_MS): void {
  stopFollow(id)
  if (!pins.some((p) => p.id === id)) return

  const win = startFollowWindow({
    durationMs,
    stepMs,
    now: () => Date.now(),
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    cancel: (handle) => window.clearTimeout(handle as number),
    onTick: () => { void fetchPinSilent(id, true) },
    isActive: () => pins.some((p) => p.id === id),
    isHidden: () => typeof document !== 'undefined' && document.hidden,
    onStop: () => { followWindows.delete(id) },
  })
  followWindows.set(id, win)
}

/** 停止某张卡的加速跟随（幂等；窗口自然到期时也会自动清理） */
export function stopFollow(id: string): void {
  const win = followWindows.get(id)
  if (!win) return
  followWindows.delete(id)
  win.stop()
}

/** 清空（切环境/调试用） */
export function clearPins(): void {
  if (!pins.length) return
  for (const id of [...followWindows.keys()]) stopFollow(id)
  pins = []
  persist()
  emit()
  stopTimer()
}

/**
 * 拖拽排序：把 from 位置的卡移到 to 位置（`to` 用「插到第几个之前」的语义）。
 *
 * 顺序就是用户给的优先级：并列观察时，排在前面的应当是更想盯的。
 */
export function movePin(from: number, to: number): void {
  if (from === to) return
  if (from < 0 || from >= pins.length) return
  const next = [...pins]
  const [moved] = next.splice(from, 1)
  const target = Math.max(0, Math.min(next.length, to > from ? to - 1 : to))
  next.splice(target, 0, moved)
  if (next.every((p, i) => p.id === pins[i]?.id)) return   // 无位移
  pins = next
  persist()
  emit()
}

/** 拉一张卡的数据 */
async function fetchPin(id: string, force: boolean): Promise<void> {
  const pin = pins.find((p) => p.id === id)
  if (!pin) return
  if (!force && pin.data) return          // 已有数据且非强制 → 不重复拉（轮询走 force=false 时靠这条 + 宿主缓存）
  patch(id, { loading: true, error: null })

  const qs = new URLSearchParams({ owner: pin.owner, repo: pin.repo, number: String(pin.number) })
  if (force) qs.set('force', '1')
  try {
    const { data, message } = await panelGet('pipeline', qs)
    if (message) patch(id, { loading: false, error: message, data: null })
    else patch(id, { loading: false, error: null, data, updatedAt: Date.now() })
  } catch (err) {
    patch(id, {
      loading: false,
      error: err instanceof Error ? err.message : String(err),
      data: null,
    })
  }
}

/**
 * 静默取数（常规轮询与加速拍共用）：
 * 不置 `loading`（否则卡片每拍闪一次「加载中」）；请求异常时静默，留给下一拍重试；
 * 上游返回可读 `message` 时仍如实展示（与常规轮询一致）。
 */
async function fetchPinSilent(id: string, force: boolean): Promise<void> {
  const pin = pins.find((p) => p.id === id)
  if (!pin) return
  const qs = new URLSearchParams({ owner: pin.owner, repo: pin.repo, number: String(pin.number) })
  if (force) qs.set('force', '1')
  try {
    const { data, message } = await panelGet('pipeline', qs)
    if (message) patch(id, { error: message })
    else patch(id, { error: null, data, updatedAt: Date.now() })
  } catch { /* 静默：下一拍再试 */ }
}

// ─────────────────────── 轮询（可见性感知）───────────────────────

function startTimer(): void {
  if (timer !== null) return
  timer = window.setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return   // 后台不拉
    // ⚠️ **错峰**：不可让 N 张卡在同一毫秒内一起发起 —— 每个请求都 spawn 一个 `grape`
    //    子进程，同时起 N 个会在页面加载/轮询时刻制造一次 CPU 尖峰。
    //    错峰后语义不变（仍是每卡每 20s 一轮），只是把这一轮摊开约 N×150ms。
    for (const [i, p] of [...pins].entries()) {
      window.setTimeout(() => {
      // 轮询用 force=false：宿主 30s TTL 会吃掉一半请求，上游调用 ≤ 2 次/分/卡。
      // 后台轮询**不置 loading**（否则每 20s 卡片闪一次"加载中"），只静默换数据。
      void fetchPinSilent(p.id, false)
      }, i * FETCH_STAGGER_MS)
    }
  }, POLL_MS)
}

function stopTimer(): void {
  if (timer === null) return
  window.clearInterval(timer)
  timer = null
}

function ensureTimer(): void {
  if (pins.length) startTimer()
}

/**
 * 挂载一次可见性监听：从后台切回前台时**立刻补一次**，避免"切回来还是旧数据"。
 * 由 `usePins()` 在首次有 pin 时调用（幂等）。
 */
let visibilityBound = false
function bindVisibility(): void {
  if (visibilityBound || typeof document === 'undefined') return
  visibilityBound = true
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !pins.length) return
    for (const p of [...pins]) refreshPin(p.id)
  })
}

/** React 钩子：订阅 pin 列表变更（返回当前列表） */
export function usePins(): Pin[] {
  const [, bump] = useState(0)
  useEffect(() => {
    bindVisibility()
    ensureTimer()
    return subscribePins(() => bump((n) => n + 1))
  }, [])
  return pins
}

// ─────────────────────── 组装成 GrapeFocus（复用 FocusBody）───────────────────────

/**
 * 把 pin 的 `/pipeline` 数据组装成 `GrapeFocus`，直接交给现有的 `FocusBody` 渲染。
 *
 * 这样 pin 卡与 AI 焦点卡**共用同一套渲染**（节点链、进度条、逃生舱），
 * 不会出现"同一个 issue 两处长相不同"。数据缺失时返回 null（调用方显示加载/错误态）。
 */
export function pinToFocus(pin: Pin): GrapeFocus | null {
  const root = asObj(pin.data)
  if (!pin.data) return null

  // 节点链 / 整体状态 / 进度统一由视图模型给出（场景节点优先，场景缺失退化为事件段）
  const view = derivePipelineViewFromData(pin.data)
  const nodes: GrapeFocusNode[] = view.nodes.map((n) => {
    const node: GrapeFocusNode = { tag: n.tag, status: n.status as GrapeStatusNum, retries: n.retries }
    if (n.seq !== undefined) node.seq = n.seq
    if (n.dur !== undefined) node.dur = n.dur
    if (n.ev) node.ev = n.ev
    if (n.actor) node.actor = n.actor
    if (n.outsideScene) node.outsideScene = true
    return node
  })

  const base = getBaseUrl()
  const focus: GrapeFocus = {
    kind: 'pipeline',
    owner: pin.owner,
    repo: pin.repo,
    number: String(pin.number),
    url: base ? grapeAppUrl(base, { view: 'pipe', owner: pin.owner, repo: pin.repo, number: pin.number }) : '',
    ts: pin.updatedAt || Date.now(),
    nodes,
    summary: str(root.summary),
    executing: view.executing,
    overall: view.overallLabel,
    overallCode: view.overallCode,
    overallDetail: view.overallDetail,
    sceneUnknown: view.sceneUnknown,
  }
  if (view.stage) focus.stage = view.stage
  if (view.scene) focus.scene = view.scene
  if (view.reviewTag) focus.reviewTag = view.reviewTag
  return focus
}

/** 收起态一行摘要要的统计：已完成 / 总格数 / 整体业务状态 */
export function pinSummary(pin: Pin): {
  done: number
  total: number
  status: string
  statusCode: GrapeStatusNum
  failed: boolean
  sceneUnknown: boolean
} {
  if (!pin.data) return { done: 0, total: 0, status: '', statusCode: 0, failed: false, sceneUnknown: false }
  const view = derivePipelineViewFromData(pin.data)
  return {
    done: view.done,
    total: view.total,
    status: view.overallLabel,
    statusCode: view.overallCode,
    failed: view.nodes.some((n) => n.status === 3 || n.status === 4),
    sceneUnknown: view.sceneUnknown,
  }
}

// ─────────────────────── 启动自举（模块加载时执行一次）───────────────────────

/**
 * 从 localStorage 恢复出来的 pin 需要补两件事：**数据**和**轮询**。
 *
 * 放在文件末尾是刻意的：`pins` 在上面已由 `loadPersisted()` 填好，
 * 而这些函数是提升的函数声明，此处调用不会踩 TDZ。
 * `loading` 交给 `fetchPin` 去置（存档里一律存 false，避免刷新后闪一片"加载中"）。
 */
if (pins.length) {
  // 错峰（理由同上）：恢复出来的卡不是紧急内容，没必要在页面加载瞬间
  // 与浏览面板的首次取数抢 CPU
  pins.forEach((pin, i) => {
    window.setTimeout(() => { void fetchPin(pin.id, false) }, i * FETCH_STAGGER_MS)
  })
  ensureTimer()
}
