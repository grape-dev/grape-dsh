/**
 * 「自动预览」选哪条 issue —— 纯选择规则（Issue #28）。
 *
 * 输入是**侧栏当前仓库的 `/issues` 缓存**（不自己发请求），输出是预览卡片要展示的
 * 单条 issue 或「无预览」原因。把规则抽成无 React / DOM / 网络依赖的纯函数，是为了
 * 像 `pins-persist.ts` 一样用 Node 单测直接覆盖三态与优先级排序。
 *
 * 规则（与 Issue #28 Spec 一致）：
 *   1. 未选仓库 → `no-repo`
 *   2. 拉取失败 → `error`（失败不等于「没有 issue」）
 *   3. 缓存还没有数据 → `loading`（加载中）/ `not-loaded`（从未加载）；
 *      二者都不等于「仓库没有 issue」，空态文案据此引导而不是误报空仓库
 *   4. 无合法 issue → `no-issue`
 *   5. pin 数达上限 → `full`（预览让位给正式 pin）
 *   6. 有候选 → **processing 优先**；同优先级按 `latest_event.created_at` 最近优先，
 *      缺失/非法时按 `latest_event.seq`、issue 号兜底（绝不因脏字段抛错）。
 */

import { normalizeIssueNumber } from './issue-number.js'

/** 侧栏当前仓库（`browse-store.currentRepo()` 的返回形状） */
export interface PreviewRepo {
  owner: string
  repo: string
  platform?: string
}

/** 预览卡片要展示的一条 issue（已窄化，字段缺失一律给安全默认） */
export interface PreviewIssue extends PreviewRepo {
  /** Issue 编号（字符串：兼容 GitCode 整数与 Gitee 字母数字，Issue #39） */
  number: string
  title: string
  status: string
  /** 最近事件时间（毫秒；无法解析为 0），供需要时展示/比较 */
  updatedAt: number
}

/** 没有可预览项的原因（空态文案据此分流） */
export type PreviewNoneReason =
  | 'no-repo'
  | 'loading'
  | 'not-loaded'
  | 'no-issue'
  | 'error'
  | 'full'

export type PreviewPick =
  | { kind: 'none'; reason: PreviewNoneReason; message?: string }
  | { kind: 'ready'; issue: PreviewIssue }

export interface PreviewInput {
  repo: PreviewRepo | null | undefined
  /** `/issues` 缓存数据（未加载/失败时为 null） */
  data: unknown
  /** 缓存是否正在加载（`data` 为 null 时用于区分「加载中」与「从未加载」） */
  loading?: boolean
  /** 拉取失败信息；非空优先于「没有 issue」 */
  error: string | null | undefined
  /** 当前正式 pin 数（预览要给正式 pin 让位） */
  pinCount: number
  /** pins 上限（由调用方传 `MAX_PINS`，本模块不反向依赖 client） */
  maxPins: number
}

// ── 极小取值器（与面板侧同形；纯模块不引入 client 依赖）──
const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

function issueNumber(row: Record<string, unknown>): string {
  return normalizeIssueNumber(row.issue_number) || normalizeIssueNumber(row.number)
}

/** `status` 与 `task_status` 都可能出现（CLI 原始字段 / 面板投影字段），任一为 processing 即算 */
function isProcessing(row: Record<string, unknown>): boolean {
  const status = (str(row.status) || str(row.task_status)).toLowerCase()
  return status === 'processing' || row.is_running === true || str(row.is_running) === 'true'
}

/** 最近活跃度：优先可解析的 `latest_event.created_at`，其次 seq */
function recency(row: Record<string, unknown>): { at: number; seq: number } {
  const latest = asObj(row.latest_event)
  const parsed = Date.parse(str(latest.created_at))
  return {
    at: Number.isFinite(parsed) ? parsed : 0,
    seq: num(latest.seq) ?? 0,
  }
}

/** 排序：processing 先；再看时间、seq、issue 号（全部降序，越大越近） */
function compare(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const pa = isProcessing(a) ? 1 : 0
  const pb = isProcessing(b) ? 1 : 0
  if (pa !== pb) return pb - pa
  const ra = recency(a)
  const rb = recency(b)
  if (ra.at !== rb.at) return rb.at - ra.at
  if (ra.seq !== rb.seq) return rb.seq - ra.seq
  // 编号只是最后的稳定兜底：数字编号按数值、字母数字编号按字典序（倒序 = 更近）
  const na = issueNumber(a)
  const nb = issueNumber(b)
  if (na !== nb && /^\d+$/.test(na) && /^\d+$/.test(nb)) return Number(nb) - Number(na)
  return nb.localeCompare(na)
}

/**
 * 从 `/issues` 缓存里挑一条最活跃的 issue。
 *
 * 纯函数：不改任何状态、不发请求；相同输入恒返回相同结果。
 */
export function pickPreviewIssue(input: PreviewInput): PreviewPick {
  const { repo, data, loading = false, error, pinCount, maxPins } = input

  if (!repo || !repo.owner || !repo.repo) return { kind: 'none', reason: 'no-repo' }
  if (error) return { kind: 'none', reason: 'error', message: error }

  // 还没有任何数据：加载中 / 从未加载都不是「仓库没有 issue」。
  // 已有旧数据时即使 `loading=true`（刷新）也继续用旧数据，避免预览闪回加载态。
  if (data == null) {
    return { kind: 'none', reason: loading ? 'loading' : 'not-loaded' }
  }

  const rows = asArr(asObj(data).issues)
    .map((it) => asObj(it))
    .filter((it) => issueNumber(it) !== '')
  if (!rows.length) return { kind: 'none', reason: 'no-issue' }

  if (pinCount >= maxPins) return { kind: 'none', reason: 'full' }

  const best = [...rows].sort(compare)[0]
  const status = str(best.status) || str(best.task_status)
  return {
    kind: 'ready',
    issue: {
      owner: repo.owner,
      repo: repo.repo,
      platform: repo.platform,
      number: issueNumber(best),
      title: str(best.title),
      status,
      updatedAt: recency(best).at,
    },
  }
}

/**
 * 预览卡是否该显示：只在**没有正式 pin** 时显示。
 *
 * 于是浏览里点图钉的两种结果都自然成立：
 *   · 原来是空列表（只有预览）→ 点完变成 1 条正式 pin，预览让位（视觉上「替换」）；
 *   · 已有正式 pin → 继续追加，预览始终收起（不与正式卡争位置）。
 */
export function shouldShowPreview(pinCount: number, maxPins = 8): boolean {
  // 满上限才让位（spec 规则 4）；0..maxPins-1 期间预览与正式 pin 共存。
  // 原来写 pinCount === 0，导致 `full` 分支与「满 8 条让位」永远不可达（Issue #28 R1）。
  return pinCount < maxPins
}