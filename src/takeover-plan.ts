/**
 * 「创建需求并接管」的计划逻辑（Issue #40 P2）：节点选择 / 仓库键 / 失败文案。
 *
 * 三个判定都必须是纯函数，因为它们是这条链路上最容易「看起来对」的错：
 *   · 接管目标写死 `coding` → VOD 首节点永远接不了（验收 8）；
 *   · repoKey 缺平台前缀 → Gitee 的 `owner/repo` 打到 GitCode 的同名仓库（验收 9）；
 *   · 失败只说 unknown → 用户不知道是「已被接管」还是「没权限」，反复点（验收 10）。
 *
 * 纯模块：不 import React / DOM / Node 内置，宿主路由与客户端 bundle 都能直接用。
 */

/** 平台名白名单：小写开头，字母数字 / `_` / `-`，总长 ≤ 32 */
const PLATFORM_RE = /^[a-z][a-z0-9_-]{0,31}$/

/**
 * 平台名归一：trim + 小写后必须命中白名单，否则返回 `''`（由调用方按缺省 `gitcode` 处理）。
 *
 * 白名单而不是「原样透传」：平台名会被拼进服务端 `repo_key`，脏值（空格 / 冒号 / 超长）
 * 会造出查不到的仓库键，表现为「接管失败但原因不明」。
 */
export function normalizePlatform(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return PLATFORM_RE.test(s) ? s : ''
}

/**
 * 仓库键：`repo` 已含 `:` 视为完整 repo_key 原样返回（幂等，兼容直接传 `gitee:owner/repo`），
 * 否则拼 `${platform}:${repo}`；平台缺省 / 非法 → `gitcode`（旧客户端不带 platform 也能用）。
 */
export function repoKeyFor(platform: unknown, repo: unknown): string {
  const r = typeof repo === 'string' ? repo.trim() : ''
  if (!r) return ''
  if (r.includes(':')) return r
  return `${normalizePlatform(platform) || 'gitcode'}:${r}`
}

/**
 * 取**实际运行中**节点的 tag（`status === 1`），作为接管用的 `agent_type`。
 *
 * 不按 agent 名过滤：首节点可能是 vod / issue，写死 coding 会直接丢掉这些场景。
 * 无运行节点返回 `''` —— 调用方据此给「启动后手动接管」的降级提示，**不重试**。
 */
export function pickRunningAgent(input: unknown): string {
  const nodes = (input && typeof input === 'object')
    ? (input as { nodes?: unknown }).nodes
    : undefined
  if (!Array.isArray(nodes)) return ''
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue
    const node = raw as { tag?: unknown; status?: unknown }
    const tag = typeof node.tag === 'string' ? node.tag.trim() : ''
    if (!tag) continue
    // 原始事件数据里 status 可能是字符串（'1'），统一按数值判定
    if (Number(node.status) === 1) return tag
  }
  return ''
}

/** 宿主 takeover-list 响应壳（只用到 HTTP 结果，便于单测直接构造） */
export interface TakeoverListResponseLike {
  ok?: boolean
  status?: number
}

/**
 * takeover-list 响应 → 接管列表，或用 `null` 表示「无法判定」。
 *
 * 只有「HTTP 成功 + 响应体未显式 `ok:false` + `sessions` 是数组」才算真列表；
 * 4xx/5xx、`ok:false`、HTML 错误页、畸形体一律 `null`。宿主 takeover-list 在 4xx/5xx
 * 时会原样透传上游状态与响应体（`src/index.ts`），若把失败响应归一成 `[]`，
 * `takeoverStillActive` 会把「查不到」判成「确认没有接管」，recoverNow 随即清掉
 * 待恢复的接管底稿 —— 一次上游 502 / 权限错误就会让用户失去「恢复接管会话」入口。
 */
export function normalizeTakeoverList(
  res: TakeoverListResponseLike | null | undefined,
  body: unknown,
): Array<{ id?: string; [k: string]: unknown }> | null {
  if (!res || res.ok !== true) return null
  if (!body || typeof body !== 'object') return null
  const envelope = body as { ok?: unknown; sessions?: unknown }
  if (envelope.ok === false) return null
  if (!Array.isArray(envelope.sessions)) return null
  return envelope.sessions as Array<{ id?: string; [k: string]: unknown }>
}

/**
 * 某条接管是否仍然有效（「恢复接管会话」前的确认）。
 *
 * 三态必须分开：查到 → true；确认查不到（空数组 / 不含目标）→ false；
 * **查不到结果（null / 非数组，即一次性取数失败）→ true**。若把后者当 false，
 * 一次网络抖动就会清掉本地待恢复的接管底稿，用户失去「恢复接管会话」入口。
 */
export function takeoverStillActive(sessions: unknown, takeoverId: string): boolean {
  const tid = String(takeoverId ?? '')
  if (!tid) return false
  if (!Array.isArray(sessions)) return true
  return sessions.some((s) => String((s as { id?: unknown } | null)?.id ?? '') === tid)
}

/** 接管失败信息（宿主回包或客户端捕获） */
export interface TakeoverFailureInput {
  /** 平台业务码（`taken_by_other` 等） */
  code?: string | number | null
  /** HTTP 状态（0 = 网络层失败） */
  status?: number | null
  /** 平台可读 message */
  message?: string
  /** 显式标记的网络错误（fetch 抛错 / 超时） */
  network?: boolean
}

/**
 * 失败 → 可读中文，四类分开：
 *   · `taken_by_other`：已被别人接管，别重复点；
 *   · `no_running_node`：流水线还没走到可接管的节点；
 *   · 401 / 403：凭据 / 权限问题；
 *   · 网络：连不上服务。
 * 其余保留平台 message（可读、不吞信息），全无信息时给兜底文案。
 */
export function takeoverFailureText(input: TakeoverFailureInput): string {
  const code = input?.code == null ? '' : String(input.code)
  const status = typeof input?.status === 'number' && Number.isFinite(input.status) ? input.status : 0

  if (code === 'taken_by_other') {
    return '该节点已有进行中的接管，请刷新后在接管条里点「完成 / 放弃」，不要重复点接管'
  }
  if (code === 'no_running_node') {
    return '暂无可接管的运行节点（流水线还没启动到该节点），可稍后手动接管'
  }
  if (input?.network === true || status === 0 && !code) {
    return '网络异常：无法连接 Grape 服务，请检查网络或服务地址后重试'
  }
  if (status === 401) {
    return '凭据已失效或未登录，请重新接入本机 worker 后再接管'
  }
  if (status === 403) {
    return '没有接管权限（需要该仓库的操作权限），请联系管理员'
  }
  const message = typeof input?.message === 'string' ? input.message.trim() : ''
  // 不带「接管失败：」前缀：由调用方统一加，两处都加会显示成「接管失败：接管失败：…」
  return message || '未知原因'
}