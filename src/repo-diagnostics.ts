/**
 * 「已托管仓库」空态诊断（宿主与客户端共用的纯函数）。
 *
 * 背景（Issue #6）：面板列表为空时，用户无法区分
 *   ① 真未托管 / ② 组织归属未设置（`org_id=0` 被组织过滤）/ ③ 当前角色无读取权限。
 *
 * 这里只做三件事，全部可独立单测：
 *   · 明确空态类型（非空列表必须返回 `none`，保证原 UI 行为不变）；
 *   · 从 `repos managed` 原始响应构建**白名单**诊断字段（缺失元数据显示「未知」）；
 *   · 生成可复制文本，并对 token / key / Authorization / Cookie 等键值兜底脱敏。
 *
 * 安全边界：诊断文本不组装仓库对象、不读取 CLI 配置，因此天然不含凭据；
 * `redactSensitiveText` 只作为未知来源文本的最后一道兜底。
 */

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
const numOrNull = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim())
  return null
}

/** 空态三类可能原因（顺序即展示顺序）。 */
export const REPO_EMPTY_REASONS: readonly string[] = [
  '仓库未托管到本组织',
  '组织归属未设置（org_id=0 被组织过滤）',
  '当前角色无读取权限',
]

/** 空态类型：`none` = 列表非空（保持原渲染）；`search` = 搜索无命中；`list` = 真无仓库。 */
export type ReposEmptyKind = 'none' | 'search' | 'list'

/**
 * 判定空态类型。
 *
 * `repoCount === 0` 优先（此时搜索框根本不会展示），
 * 非空列表一律返回 `none` —— 这是「非空 UI 与行为不变」的单一判定点。
 */
export function reposEmptyKind(repoCount: number, searching: boolean, hitCount: number): ReposEmptyKind {
  if (repoCount <= 0) return 'list'
  if (searching && hitCount === 0) return 'search'
  return 'none'
}

/** 宿主侧 `/repos` 响应里 `diagnostics` 的结构（客户端直接复用）。 */
export interface RepoDiagnostics {
  generatedAt: string
  endpoint: string
  proxy: string
  cli: string
  params: Record<string, string>
  paramsText: string
  rawCount: number
  total: number | null
  totalText: string
  roles: Record<string, number>
  rolesText: string
  orgId: string
  orgIdKnown: boolean
  orgIdText: string
  reasons: string[]
  viewer: RepoViewer | null
  viewerText: string
  viewerOrgsText: string
  viewerReposText: string
}

/** 当前账号（O10）：用户名 + 组织角色 + 托管仓库权限，来自 `auth profile` / `orgs list`。 */
export interface RepoViewerOrg {
  name: string
  role: string
  personal: boolean
}

export interface RepoViewer {
  username: string
  orgs: RepoViewerOrg[]
  managedRepoCount: number
  adminRepoCount: number
}

export interface BuildReposDiagnosticsOptions {
  /** 插件侧实际附加的查询参数（如 `force=1`） */
  params?: Record<string, string>
  /** 当前账号信息（仅空态时由宿主补取；缺失则显示「未知」） */
  viewer?: RepoViewer | null
  /** 生成时间（测试可注入固定值） */
  now?: Date
}

const ENDPOINT = 'GET /api/repos/managed'
const PROXY = 'GET /grape-panel-api/repos'
const CLI = 'grape repos managed --json-out'

function isDiagnostics(v: unknown): v is RepoDiagnostics {
  const o = rec(v)
  return !!o
    && typeof o.generatedAt === 'string'
    && typeof o.rawCount === 'number'
    && typeof o.totalText === 'string'
    && typeof o.orgIdText === 'string'
    && Array.isArray(o.reasons)
    && (o.viewer === null || rec(o.viewer) !== null)
    && typeof o.viewerText === 'string'
    && typeof o.viewerOrgsText === 'string'
    && typeof o.viewerReposText === 'string'
}

function countRoles(repos: unknown[]): Record<string, number> {
  const roles: Record<string, number> = {}
  for (const r of repos) {
    const role = str(rec(r)?.role).trim() || '未知'
    roles[role] = (roles[role] ?? 0) + 1
  }
  return roles
}

/**
 * 把 `grape auth profile --json-out` 与 `grape orgs list --json-out` 的原始返回
 * 收敛成白名单 `RepoViewer`；两个接口都缺失时返回 null（诊断显示「未知」）。
 *
 * 只取 username / 组织名+角色 / 托管仓库数量与 Admin 数量，不携带任何 token 或邮箱。
 */
export function summarizeViewer(profile: unknown, orgs: unknown): RepoViewer | null {
  const p = rec(profile)
  const orgSource = Array.isArray(orgs) ? orgs : arr(rec(orgs)?.orgs)
  const orgList = orgSource.map(rec).filter((o): o is Record<string, unknown> => !!o)
  const managed = arr(p?.managed_repos).map(rec).filter((o): o is Record<string, unknown> => !!o)
  if (!p && orgList.length === 0) return null

  return {
    username: str(p?.username).trim(),
    orgs: orgList.map((o) => ({
      name: str(o.name).trim() || str(o.slug).trim() || '未命名组织',
      role: str(o.role).trim() || '未知',
      personal: o.is_personal === true,
    })),
    managedRepoCount: managed.length,
    adminRepoCount: managed.filter((o) => o.is_admin === true).length,
  }
}

/**
 * 从 `repos managed` 原始响应构建诊断。
 *
 * 若响应已带宿主生成的合法 `diagnostics` 则直接复用，避免客户端重复计算口径漂移。
 * 缺失 `total` / `org_id` 时显示「未知」并给出推断说明，**不伪造数据**。
 */
export function buildReposDiagnostics(data: unknown, opts: BuildReposDiagnosticsOptions = {}): RepoDiagnostics {
  const o = rec(data)
  if (o && isDiagnostics(o.diagnostics)) return o.diagnostics

  const repos = arr(o?.repos ?? data)
  const rawCount = repos.length

  const total = numOrNull(o?.total) ?? numOrNull(o?.total_count)
  const totalText = total === null ? '未知（接口未返回 total）' : String(total)

  const roles = countRoles(repos)
  const roleEntries = Object.entries(roles)
  const rolesText = roleEntries.length
    ? roleEntries.map(([k, n]) => `${k}=${n}`).join(' · ')
    : '无'

  const orgRaw = o?.org_id ?? o?.orgId ?? o?.organization_id
  const orgId = str(orgRaw).trim()
  const orgIdKnown = orgId !== ''
  const orgIdText = orgIdKnown
    ? `${orgId}（接口返回${orgId === '0' ? '；0 表示组织归属未设置，可能被组织过滤' : ''}）`
    : `未知（接口未返回 org_id；${rawCount > 0
      ? '列表非空，组织过滤未生效'
      : '空列表且平台确有托管时，通常意味着 org_id=0 被组织过滤'}）`

  const params = { ...(opts.params ?? {}) }
  const paramsText = Object.keys(params).length
    ? Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&')
    : '无（未附加 org_id / 角色过滤）'

  // 当前账号角色（O10）：由宿主在空列表时通过 auth profile / orgs list 补取；
  // 客户端单独调用 buildReposDiagnostics 时缺省为「未知」，不臆测。
  const viewer = opts.viewer ?? null
  const viewerText = viewer
    ? viewer.username || '未知（账号信息缺少 username）'
    : '未知（宿主未返回账号信息）'
  const viewerOrgsText = !viewer
    ? '未知（宿主未返回账号信息）'
    : viewer.orgs.length
      ? viewer.orgs
        .map((o) => `${o.name}=${o.role}${o.personal ? '（个人空间）' : ''}`)
        .join(' · ')
      : '未知（接口未返回组织列表）'
  const viewerReposText = !viewer
    ? '未知（宿主未返回账号信息）'
    : viewer.managedRepoCount > 0
      ? `${viewer.managedRepoCount} 个（Admin ${viewer.adminRepoCount} / 其他 ${viewer.managedRepoCount - viewer.adminRepoCount}）`
      : '0 个（当前账号没有任何托管仓库权限）'

  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    endpoint: ENDPOINT,
    proxy: PROXY,
    cli: CLI,
    params,
    paramsText,
    rawCount,
    total,
    totalText,
    roles,
    rolesText,
    orgId,
    orgIdKnown,
    orgIdText,
    reasons: [...REPO_EMPTY_REASONS],
    viewer,
    viewerText,
    viewerOrgsText,
    viewerReposText,
  }
}

/**
 * 敏感键值兜底脱敏（白名单组装之外的最后一道防线）。
 *
 * 覆盖：token/key/secret/authorization/cookie/password/credential 等键，
 * `tk_`/`grape_`/`grp_`/`rta_` 前缀的 token 形态，以及 `Bearer xxx`。
 */
export function redactSensitiveText(text: string): string {
  const sensitiveKey = 'token|key|secret|authorization|cookie|password|passwd|credential|api[_-]?key'
  const kv = new RegExp(`((?:${sensitiveKey}))(["']?)\\s*[:=]\\s*["']?[^\\s,;&"'}\\]]+`, 'gi')
  return String(text ?? '')
    .replace(/\b(?:tk_|tko_|grape_|grp_|rta_)[A-Za-z0-9_-]{4,}\b/g, '[已脱敏]')
    .replace(/\b(authorization|cookie)\s*:\s*[^\n]+/gi, '$1: [已脱敏]')
    .replace(/\b(bearer)\s+[^\s]+/gi, '$1 [已脱敏]')
    .replace(kv, '$1$2=[已脱敏]')
}

/** 生成「一键复制」的诊断文本（末尾统一过脱敏）。 */
export function renderReposDiagnostics(d: RepoDiagnostics): string {
  const lines = [
    'Grape 面板「已托管仓库」诊断',
    `生成时间: ${d.generatedAt}`,
    `查询端点: ${d.endpoint}`,
    `插件代理: ${d.proxy}`,
    `CLI 查询: ${d.cli}`,
    `查询参数: ${d.paramsText}`,
    `原始返回条数: ${d.rawCount}`,
    `total: ${d.totalText}`,
    `角色分布: ${d.rolesText}`,
    `org_id 推断: ${d.orgIdText}`,
    `当前账号: ${d.viewerText}`,
    `账号组织角色: ${d.viewerOrgsText}`,
    `账号托管权限: ${d.viewerReposText}`,
    '可能原因:',
    ...d.reasons.map((r, i) => `  ${i + 1}) ${r}`),
  ]
  return redactSensitiveText(lines.join('\n'))
}

/**
 * 宿主侧 `/repos` 响应包裹：保留原始字段（`repos` 及未来 `total/org_id`），
 * 追加 `diagnostics` 供客户端空态直接复用。
 */
export function withReposDiagnostics(
  data: unknown,
  opts: BuildReposDiagnosticsOptions = {},
): Record<string, unknown> {
  const o = rec(data)
  // CLI 正常返回 `{ repos: [...] }`；这里额外兼容「直接返回数组」的形态，避免包装时丢数据。
  const base: Record<string, unknown> = o
    ? { ...o }
    : Array.isArray(data)
      ? { repos: data }
      : { repos: [] }
  base.diagnostics = buildReposDiagnostics(base, opts)
  return base
}