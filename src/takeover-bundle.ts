export type TakeoverApiCall = (
  cfg: { baseUrl?: string; token?: string },
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs?: number,
) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>

export interface TakeoverBundleDeps {
  cfg: { baseUrl?: string; token?: string }
  apiCall: TakeoverApiCall
  log?: (message: string) => void
  warn?: (message: string) => void
}

export interface TakeoverBundleParams {
  repo: string
  repoKey: string
  issueNumber: string
  agentType: string
  host: string
  hostOs: string
  hostArch: string
  hostShell: string
  clientVersion?: string
}

export interface TakeoverBundleOutcome {
  ok: boolean
  status: number
  code: string
  message: string
  /** 平台回执里的 request_id（仅失败时可能非空）：贴给平台即可定位日志 */
  requestId: string
  degraded: boolean
  notice: string
  takeoverId: string
  bundle: Record<string, unknown>
  cancelOk: boolean
  cancelError: string
}

const LEGACY_NOTICE = '服务端版本较旧，已降级到旧协议'
const SERVER_TOO_OLD_MESSAGE = '服务端不支持接管接口，请联系管理员升级'
const LEGACY_PATH = '/api/runtime/issues/takeover-context'
const LEGACY_PREFIX = 'legacy:'

interface LegacyMessage {
  seq?: number
  type?: string
  tool?: string
  content?: string
  output?: string
}

/**
 * legacy 消息 → 可读日志行。
 *
 * 平台归一化后的真实类型是 tool_use / tool_result / text / reasoning / step_start /
 * step_finish / error / log；tool_use 的工具名在 tool 字段、content 常为空，
 * 必须单独处理，否则日志里只剩空的 "[tool_use] "。
 */
function formatLegacyLog(messages: LegacyMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const type = String(m.type ?? '')
    const tool = String(m.tool ?? '')
    const content = String(m.content ?? '').slice(0, 500)
    const output = String(m.output ?? '').slice(0, 500)
    if (type === 'step_start') lines.push(`\n--- ${content} ---`)
    else if (type === 'reasoning') lines.push(`[思考] ${content}`)
    else if (type === 'text') lines.push(`[回复] ${content}`)
    else if (type === 'tool_use') lines.push(`[工具调用] ${tool}${content ? ': ' + content : ''}`)
    else if (type === 'tool_result') lines.push(`[工具结果] ${content || output}`)
    else if (type === 'error') lines.push(`[错误] ${content}`)
    else if (type === 'log') lines.push(`[日志] ${content}`)
  }
  return lines.join('\n')
}

/**
 * 拼装接管 prompt：任务头 + 最近 8000 字执行日志 + 原始 prompt 最近 4000 字。
 *
 * 与旧版 takeover-context 流程（0a5a73185 + b12586d）保持一致，保证
 * "新插件 + 旧服务端"下 agent 拿到的上下文与历史版本等价。
 */
export function buildLegacyPrompt(input: {
  repo: string
  issueNumber: string
  agentType: string
  skill: string
  taskId: string
  messages: LegacyMessage[]
  originalPrompt?: string
}): string {
  const { repo, issueNumber, agentType, skill, taskId, messages, originalPrompt } = input
  const taskLog = formatLegacyLog(messages)
  const parts: string[] = [
    '## 任务接管',
    `你接管了 Issue #${issueNumber} 的 ${agentType} 任务。`,
    `仓库: ${repo}`,
    `技能: ${skill}`,
    `原任务: ${taskId}`,
    '',
  ]
  if (taskLog) {
    parts.push(`## 原任务执行日志（最近 ${messages.length} 条）`, '', taskLog.slice(-8000), '')
  }
  if (originalPrompt && originalPrompt.length > 0) {
    parts.push('## 原始任务 Prompt', '', originalPrompt.slice(-4000), '')
  }
  parts.push(`请基于以上上下文继续处理 Issue #${issueNumber}。`)
  return parts.join('\n')
}

function parseEnvExtra(raw: unknown): Record<string, string> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, string>
  try {
    const parsed = JSON.parse(String(raw)) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** legacy 响应 → 与新路径同构的 bundle（字段差异只停留在取数层）。 */
export function normalizeLegacyBundle(
  ctx: Record<string, unknown>,
  params: Pick<TakeoverBundleParams, 'repo' | 'issueNumber' | 'agentType'>,
): Record<string, unknown> {
  const taskId = String(ctx.task_id || '')
  const agentType = String(ctx.agent_type || params.agentType)
  const skill = String(ctx.skill || agentType)
  const messages = Array.isArray(ctx.messages) ? (ctx.messages as LegacyMessage[]) : []
  const takeoverId = `legacy:${taskId}`
  const cwd = String(ctx.cwd || '')
  return {
    takeover_id: takeoverId,
    workspace: { cwd_hint: cwd },
    env: parseEnvExtra(ctx.env_extra),
    instructions: {
      prompt: buildLegacyPrompt({
        repo: params.repo,
        issueNumber: params.issueNumber,
        agentType,
        skill,
        taskId,
        messages,
        originalPrompt: String(ctx.prompt || ''),
      }),
    },
    history: { messages },
    task: { id: taskId, agent_type: agentType, skill },
    warnings: ['legacy server: assets unavailable, reused worker-materialized skills'],
    meta: { protocol: 'legacy' },
  }
}

/** legacy 接管的 takeover_id 前缀（旧服务端没有 attach/finish/abort 端点，必须本地短路）。 */
export function isLegacyTakeoverId(takeoverId: string): boolean {
  return takeoverId.startsWith(LEGACY_PREFIX)
}

function codeIsRouteNotFound(code: string): boolean {
  const c = code.trim().toLowerCase()
  if (!c) return true
  return c.startsWith('route') || c.startsWith('not_found') || c.startsWith('endpoint') || c === 'no_route'
}

/**
 * 404 是否代表「旧服务端没有这个路由」。
 *
 * 新服务端也可能用 404 表达业务态（如 no_running_task）；只看 status 就把后者
 * 判成旧服务端，会让回退也 404，最终返回 501 server_too_old 误导用户。
 * 因此仅在响应体无业务 code（路由层裸 404）或 code 属 route/not_found_* 时才回退。
 */
export function isLegacyFallbackStatus(status: number, data: Record<string, unknown> | undefined): boolean {
  if (status === 405) return true
  if (status !== 404) return false
  return codeIsRouteNotFound(String((data || {}).code || ''))
}

export type LegacyLocalEndpoint = 'progress' | 'request-finish' | 'finish' | 'abort'

export interface LegacyLocalReply {
  status: number
  body: Record<string, unknown>
}

/**
 * legacy 接管的本地短路响应：旧服务端既没有这些端点，也不认得 `legacy:<task_id>`，
 * 打新端点必然 404。progress / request-finish 属尽力而为，标记 skipped 后放行；
 * finish / abort 是用户可见动作，旧协议只能到平台手动完成，必须明确告知而非伪报成功。
 */
export function legacyEndpointReply(
  endpoint: LegacyLocalEndpoint,
  takeoverId: string,
): LegacyLocalReply | null {
  if (!isLegacyTakeoverId(takeoverId)) return null
  switch (endpoint) {
    case 'progress':
      return {
        status: 200,
        body: {
          ok: true, local_only: true, skipped: true, protocol: 'legacy', takeover_id: takeoverId,
          message: '旧协议无进展上报接口，已跳过',
        },
      }
    case 'request-finish':
      return {
        status: 200,
        body: {
          ok: true, local_only: true, skipped: true, protocol: 'legacy', takeover_id: takeoverId,
          message: '旧协议无完成申请接口，请到平台手动完成该节点',
        },
      }
    case 'finish':
      return {
        status: 200,
        body: {
          ok: false, local_only: true, protocol: 'legacy', takeover_id: takeoverId,
          message: '旧协议不支持在此完成节点，请到平台手动完成/推进该任务',
        },
      }
    case 'abort':
      return {
        status: 200,
        body: {
          ok: false, local_only: true, protocol: 'legacy', takeover_id: takeoverId,
          message: '旧协议无放弃接口，请到平台手动处理该任务',
        },
      }
  }
}

/** legacy 接管的 attach 本地短路：旧服务端无 attach 端点，直接回已登记的 workspace。 */
export function legacyAttachReply(
  takeoverId: string,
  clientSession: string,
  workspace: { id: string; name: string } | undefined,
): LegacyLocalReply | null {
  if (!isLegacyTakeoverId(takeoverId)) return null
  return {
    status: 200,
    body: {
      ok: true,
      local_only: true,
      takeover_id: takeoverId,
      client_session: clientSession,
      workspace_id: workspace?.id || '',
      workspace_name: workspace?.name || '',
    },
  }
}

function failure(status: number, code: string, message: string, requestId = ''): TakeoverBundleOutcome {
  return {
    ok: false,
    status,
    code,
    message,
    requestId,
    degraded: false,
    notice: '',
    takeoverId: '',
    bundle: {},
    cancelOk: false,
    cancelError: '',
  }
}

/**
 * 取接管 bundle：主路径 POST /api/takeover/sessions，仅在 404/405 时回退旧接口。
 *
 * 非 404/405 的非 2xx 都是真实业务错误（400 参数 / 401 鉴权 / 409 冲突 / 5xx 故障），
 * 原样透传 status/code/message —— 回退会掩盖问题。
 */
export async function fetchTakeoverBundle(
  deps: TakeoverBundleDeps,
  params: TakeoverBundleParams,
): Promise<TakeoverBundleOutcome> {
  const log = deps.log ?? ((): void => {})
  const warn = deps.warn ?? ((): void => {})

  const main = await deps.apiCall(deps.cfg, 'POST', '/api/takeover/sessions', {
    repo_key: params.repoKey,
    issue_number: String(params.issueNumber),
    agent_type: params.agentType,
    platform: 'dsh',
    host: params.host,
    client_version: String(params.clientVersion || ''),
    host_os: params.hostOs,
    host_arch: params.hostArch,
    host_shell: params.hostShell,
    supports: { workspace: true, progress: true, finish: true, abort: true },
  }, 60000)

  if (main.ok) {
    const bundle = (main.data.bundle || {}) as Record<string, unknown>
    return {
      ok: true,
      status: main.status,
      code: '',
      message: '',
      requestId: '',
      degraded: false,
      notice: '',
      takeoverId: String(main.data.takeover_id || bundle.takeover_id || ''),
      bundle,
      cancelOk: main.data.cancel_ok !== false,
      cancelError: String(main.data.cancel_error || ''),
    }
  }

  if (!isLegacyFallbackStatus(main.status, main.data)) {
    const d = main.data || {}
    return failure(
      main.status || 502,
      String(d.code || ''),
      String(d.message || d.error || `takeover failed (HTTP ${main.status})`),
      // 平台 500 的统一回执里带 request_id（服务端日志同值），原样透传给面板
      String(d.request_id || ''),
    )
  }

  const qs = new URLSearchParams({
    repo_key: params.repoKey,
    issue_number: String(params.issueNumber),
    agent_type: params.agentType,
  })
  const legacy = await deps.apiCall(deps.cfg, 'GET', `${LEGACY_PATH}?${qs.toString()}`)

  // 网关把 404 改写成 200 + HTML 时 data.raw 会带上原文 —— 不能当成功 bundle 用
  if (!legacy.ok || !legacy.data || legacy.data.raw !== undefined) {
    warn(`[grape-dsh] takeover: fallback failed repo=${params.repo} issue=${params.issueNumber} ` +
      `code=server_too_old legacy_status=${legacy.status}`)
    return failure(501, 'server_too_old', SERVER_TOO_OLD_MESSAGE)
  }

  const taskId = String(legacy.data.task_id || '')
  if (!taskId) {
    return failure(404, 'no_running_task', `没有找到 Issue #${params.issueNumber} 正在运行的任务`)
  }

  const bundle = normalizeLegacyBundle(legacy.data, params)
  log(`[grape-dsh] takeover: fallback to legacy takeover-context repo=${params.repo} ` +
    `issue=${params.issueNumber} agent=${params.agentType} task=${taskId}`)

  return {
    ok: true,
    status: 200,
    code: '',
    message: '',
    requestId: '',
    degraded: true,
    notice: LEGACY_NOTICE,
    takeoverId: String(bundle.takeover_id),
    bundle,
    // 旧服务端没有取消端点，插件不自作主张停任务 —— 如实告诉用户原任务可能仍在运行
    cancelOk: false,
    cancelError: '旧协议无取消接口，原任务可能仍在运行',
  }
}
