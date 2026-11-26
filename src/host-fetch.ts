/**
 * 浏览页签的宿主 fetch 快路径（Issue #27）。
 *
 * 为什么需要它：面板的只读 GET 原先每次都 spawn 一个 `grape` Python CLI
 * （解释器 ~0.3s + 契约解析 ~30ms + 新建 httpx.Client / 加载 certifi 0.2–0.55s），
 * 而服务端直连只要 19–48ms。这里用 Node 内置 `fetch` 在宿主进程内直连 Grape HTTP API：
 * - 全局 dispatcher 自带连接池与 TLS 会话复用（同源多次请求不再重建证书上下文）；
 * - 无子进程、无解释器启动；
 * - 任一环节不可用（无 token / 无 fetch / baseUrl 非法 / 非 2xx / 结构不符 / 超时 / 网络错误）
 *   都抛 `HostFetchError`，由 `panel-api.ts` 原样回退到现有 CLI 路径。
 *
 * 安全：
 * - token 只进 `Authorization` 头，**不进日志、不进错误消息**；
 * - 不构造任意 URL：路径由固定模板 + 已白名单校验的 owner/repo/number 组成。
 */

/** 快路径失败码（供上层决定回退；不对外暴露细节） */
export type HostFetchCode =
  | 'no-token'
  | 'no-fetch'
  | 'bad-base-url'
  | 'http'
  | 'schema'
  | 'timeout'
  | 'network'

/** 快路径错误：可安全回退 CLI 的信号 */
export class HostFetchError extends Error {
  readonly code: HostFetchCode

  constructor(code: HostFetchCode, message: string) {
    super(message)
    this.name = 'HostFetchError'
    this.code = code
  }
}

/** 取数目标（与 `GrapeCliConfig` 的同名子集对齐，避免循环依赖） */
export interface HostFetchTarget {
  baseUrl: string
  token: string
  /** 与 CLI 配置一致；快路径会再夹到上限内，避免一次请求拖住首屏 */
  timeoutSec?: number
  /** `GrapeCliConfig.timeout`（秒）的兼容入口：panel-api 直接传 getConfig() 时只有这个字段 */
  timeout?: number
}

export interface HostFetchOptions {
  /** 注入用（单测）；缺省用全局 `fetch` */
  fetchImpl?: typeof fetch | null
  /** 超时毫秒（缺省由 target.timeoutSec 推导，夹在 [500, 8000]） */
  timeoutMs?: number
}

export interface HostFetchResult {
  data: unknown
  /** 宿主快路径耗时（毫秒）——/repos 的 timing.hostMs 来源 */
  hostMs: number
}

/** 快路径默认超时：面板首屏不值得为一个请求等 30s */
const DEFAULT_TIMEOUT_MS = 5_000
const MIN_TIMEOUT_MS = 10
const MAX_TIMEOUT_MS = 8_000

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** baseUrl 归一：去尾斜杠、无协议补 `http://`。空串视为非法 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

/** 是否具备宿主 fetch 能力（缺省用全局 fetch） */
export function isHostFetchSupported(fetchImpl?: typeof fetch | null): boolean {
  const impl = fetchImpl === undefined ? (globalThis as { fetch?: typeof fetch }).fetch : fetchImpl
  return typeof impl === 'function'
}

/** `GET /api/repos/managed` */
export function buildReposManagedUrl(target: HostFetchTarget): string {
  return `${normalizeBaseUrl(target.baseUrl)}/api/repos/managed`
}

export interface IssuesListQuery {
  owner: string
  repo: string
  status?: string
  sort_order?: string
  mode?: string
  assignees?: string
  /** 搜索词（Issue #41）：平台按**标题 + 编号**匹配，不搜正文/评论 */
  q?: string
  /** 搜索结果翻页（第 1 页可省略；仅 q 非空时有意义） */
  page?: number | string
  /** 每页条数（搜索用 50；缺省保持平台默认，普通列表行为不变） */
  per_page?: number | string
}

/** `GET /api/issues/{owner}/{repo}`（过滤参数与 CLI `--status/--sort_order/--mode/--assignees/--q/--page/--per_page` 同义） */
export function buildIssuesListUrl(target: HostFetchTarget, q: IssuesListQuery): string {
  const base = `${normalizeBaseUrl(target.baseUrl)}/api/issues/${encodeURIComponent(q.owner)}/${encodeURIComponent(q.repo)}`
  const params = new URLSearchParams()
  for (const key of ['status', 'sort_order', 'mode', 'assignees', 'q', 'page', 'per_page'] as const) {
    const v = q[key]
    if (v != null && v !== '') params.set(key, String(v))
  }
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

/**
 * `GET /api/issues/mine?repo_key=<repo_key>&per_page=<n>`（Issue #42 复审 R1）。
 *
 * 为什么 `/task` 不再把 `--per_page` 交给 `issues mine` CLI：该参数在部分 CLI 版本上
 * 不被接受（直接 Usage 报错 exit 1），而 HTTP 端点稳定支持。宿主内直连还省掉一次
 * 解释器启动，并能拿满 100 行 —— mine 默认 20 行时目标 issue 可能落在列表之外，
 * 导致 `conversation_id` / `is_running` 缺失。
 */
export interface IssuesMineQuery {
  /** 平台消歧键：`gitcode:owner/repo` / `gitee:owner/repo` */
  repo_key: string
  /** 每页条数（缺省保持平台默认；`/task` 用 100 覆盖自己的需求） */
  per_page?: number | string
}

/** `GET /api/issues/mine` 的路径 + query（`buildIssuesMineUrl` / 取数函数共用） */
function issuesMinePath(q: IssuesMineQuery): string {
  const params = new URLSearchParams()
  if (q.repo_key) params.set('repo_key', q.repo_key)
  if (q.per_page != null && q.per_page !== '') params.set('per_page', String(q.per_page))
  const qs = params.toString()
  return `/api/issues/mine${qs ? `?${qs}` : ''}`
}

/** `GET /api/issues/mine`（query：repo_key / per_page） */
export function buildIssuesMineUrl(target: HostFetchTarget, q: IssuesMineQuery): string {
  return `${normalizeBaseUrl(target.baseUrl)}${issuesMinePath(q)}`
}

/** `GET /api/auth/profile`（空账号诊断：当前账号 / 托管权限） */
export function buildAuthProfileUrl(target: HostFetchTarget): string {
  return `${normalizeBaseUrl(target.baseUrl)}/api/auth/profile`
}

/** `GET /api/orgs`（空账号诊断：组织角色） */
export function buildOrgsListUrl(target: HostFetchTarget): string {
  return `${normalizeBaseUrl(target.baseUrl)}/api/orgs`
}

export interface PipelineQuery {
  owner: string
  repo: string
  number: number | string
}

/**
 * `GET /api/scenes/with-pipeline?repo=owner/repo`（Issue #42）。
 *
 * 复制需求的场景下拉与「移交流水线」都要**全仓库**场景列表，而这条端点是 user_only：
 * worker 会话 token 403 时由 `panel-api` 降级为「当前场景单条」，不阻塞卡片。
 * `repo` 必须整体 URL 编码（斜杠不编码会被当成路径段）。
 */
export interface ScenesWithPipelineQuery {
  owner: string
  repo: string
}

export function buildScenesWithPipelineUrl(target: HostFetchTarget, q: ScenesWithPipelineQuery): string {
  return `${normalizeBaseUrl(target.baseUrl)}/api/scenes/with-pipeline?repo=${encodeURIComponent(`${q.owner}/${q.repo}`)}`
}

/** `GET /api/issues/{owner}/{repo}/{number}/pipeline` */
export function buildPipelineUrl(target: HostFetchTarget, q: PipelineQuery): string {
  return `${normalizeBaseUrl(target.baseUrl)}/api/issues/${encodeURIComponent(q.owner)}/${encodeURIComponent(q.repo)}/${encodeURIComponent(String(q.number))}/pipeline`
}

function clampTimeout(target: HostFetchTarget, opts: HostFetchOptions): number {
  // timeoutSec / timeout 都按秒处理：前者是本模块的正式字段，后者兼容面板直接传
  // GrapeCliConfig（只有 timeout）。缺省才回落 5s，避免配置里的 30s 被静默忽略。
  const sec = target.timeoutSec ?? target.timeout
  const raw = opts.timeoutMs ?? (typeof sec === 'number' && Number.isFinite(sec) && sec > 0
    ? sec * 1000
    : DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, raw))
}

/**
 * 统一的 JSON GET。所有失败都转成 `HostFetchError`（code 见上），
 * 保证 `panel-api` 只需 `catch` 一个类型即可回退。
 */
async function requestJson(
  target: HostFetchTarget,
  path: string,
  opts: HostFetchOptions,
): Promise<HostFetchResult> {
  if (!target.token) throw new HostFetchError('no-token', '宿主未配置 token')

  const base = normalizeBaseUrl(target.baseUrl)
  if (!base) throw new HostFetchError('bad-base-url', '宿主 baseUrl 为空或非法')

  const impl = opts.fetchImpl === undefined
    ? (globalThis as { fetch?: typeof fetch }).fetch
    : (opts.fetchImpl ?? undefined)
  if (typeof impl !== 'function') {
    throw new HostFetchError('no-fetch', '当前运行时没有可用的内置 fetch')
  }

  const timeoutMs = clampTimeout(target, opts)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()

  let res: { ok: boolean; status: number; json(): Promise<unknown> }
  try {
    res = await impl(`${base}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${target.token}`,
        accept: 'application/json',
      },
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (controller.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
      throw new HostFetchError('timeout', `宿主 fetch 超时（> ${timeoutMs}ms）`)
    }
    const detail = err instanceof Error ? err.message : String(err)
    throw new HostFetchError('network', `宿主 fetch 网络错误：${detail}`)
  }

  if (!res.ok) {
    clearTimeout(timer)
    throw new HostFetchError('http', `HTTP ${res.status}（GET ${path}）`)
  }

  let data: unknown
  try {
    data = await res.json()
  } catch (err) {
    // 响应体也受同一个超时约束（Issue #27 C1）：超时 abort 会中断 body 流，
    // 这里必须回成 timeout 而不是 schema，否则上层只会看到「结构不符」看不出是超时。
    if (controller.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
      throw new HostFetchError('timeout', `宿主 fetch 超时（> ${timeoutMs}ms，读取响应体）`)
    }
    throw new HostFetchError('schema', '响应不是合法 JSON')
  } finally {
    clearTimeout(timer)
  }

  return { data, hostMs: Date.now() - started }
}

/** 结构白名单：与 CLI `--json-out` 的返回形态对齐，不符即回退 */
function assertReposShape(data: unknown): void {
  const o = rec(data)
  if (Array.isArray(data) || (o && Array.isArray(o.repos))) return
  throw new HostFetchError('schema', 'repos 响应结构不符（缺 repos 数组）')
}

function assertIssuesShape(data: unknown): void {
  const o = rec(data)
  if (o && Array.isArray(o.issues)) return
  throw new HostFetchError('schema', 'issues 响应结构不符（缺 issues 数组）')
}

function assertPipelineShape(data: unknown): void {
  const o = rec(data)
  if (o && Array.isArray(o.segments)) return
  throw new HostFetchError('schema', 'pipeline 响应结构不符（缺 segments 数组）')
}

function assertAuthProfileShape(data: unknown): void {
  if (rec(data)) return
  throw new HostFetchError('schema', 'auth profile 响应结构不符（不是对象）')
}

function assertOrgsShape(data: unknown): void {
  const o = rec(data)
  if (Array.isArray(data) || (o && Array.isArray(o.orgs))) return
  throw new HostFetchError('schema', 'orgs 响应结构不符（缺数组）')
}

/** 场景列表：`{ scenes: [...] }` 或裸数组（实测两种形态都出现过） */
function assertScenesShape(data: unknown): void {
  const o = rec(data)
  if (Array.isArray(data) || (o && Array.isArray(o.scenes))) return
  throw new HostFetchError('schema', 'scenes 响应结构不符（缺 scenes 数组）')
}

/** ① 托管仓库 */
export async function hostFetchReposManaged(
  target: HostFetchTarget,
  opts: HostFetchOptions = {},
): Promise<HostFetchResult> {
  const out = await requestJson(target, '/api/repos/managed', opts)
  assertReposShape(out.data)
  return out
}

/** ② issue 列表 */
export async function hostFetchIssuesList(
  target: HostFetchTarget,
  q: IssuesListQuery,
  opts: HostFetchOptions = {},
): Promise<HostFetchResult> {
  const path = `/api/issues/${encodeURIComponent(q.owner)}/${encodeURIComponent(q.repo)}`
  const params = new URLSearchParams()
  for (const key of ['status', 'sort_order', 'mode', 'assignees', 'q', 'page', 'per_page'] as const) {
    const v = q[key]
    if (v != null && v !== '') params.set(key, String(v))
  }
  const qs = params.toString()
  const out = await requestJson(target, qs ? `${path}?${qs}` : path, opts)
  assertIssuesShape(out.data)
  return out
}

/** ③ 流水线详情 */
export async function hostFetchPipeline(
  target: HostFetchTarget,
  q: PipelineQuery,
  opts: HostFetchOptions = {},
): Promise<HostFetchResult> {
  const path = `/api/issues/${encodeURIComponent(q.owner)}/${encodeURIComponent(q.repo)}/${encodeURIComponent(String(q.number))}/pipeline`
  const out = await requestJson(target, path, opts)
  assertPipelineShape(out.data)
  return out
}
/** ④ 当前账号 profile（仅空仓库诊断用） */
export async function hostFetchAuthProfile(
  target: HostFetchTarget,
  opts: HostFetchOptions = {},
): Promise<HostFetchResult> {
  const out = await requestJson(target, '/api/auth/profile', opts)
  assertAuthProfileShape(out.data)
  return out
}

/** ⑤ 组织列表（仅空仓库诊断用） */
export async function hostFetchOrgsList(
  target: HostFetchTarget,
  opts: HostFetchOptions = {},
): Promise<HostFetchResult> {
  const out = await requestJson(target, '/api/orgs', opts)
  assertOrgsShape(out.data)
  return out
}

/** ⑦ mine 列表（Issue #42 复审 R1：/task 的 mine 行改走 HTTP，per_page 由端点承载） */
export async function hostFetchIssuesMine(
  target: HostFetchTarget,
  q: IssuesMineQuery,
  opts: HostFetchOptions = {},
): Promise<HostFetchResult> {
  const out = await requestJson(target, issuesMinePath(q), opts)
  assertIssuesShape(out.data)
  return out
}

/** ⑥ 场景列表（含流水线配置；Issue #42：复制需求 / 移交目标） */
export async function hostFetchScenesWithPipeline(
  target: HostFetchTarget,
  q: ScenesWithPipelineQuery,
  opts: HostFetchOptions = {},
): Promise<HostFetchResult> {
  const path = `/api/scenes/with-pipeline?repo=${encodeURIComponent(`${q.owner}/${q.repo}`)}`
  const out = await requestJson(target, path, opts)
  assertScenesShape(out.data)
  return out
}