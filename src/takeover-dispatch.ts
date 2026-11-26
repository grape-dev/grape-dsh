/**
 * 接管期间禁止自动派发 —— 插件侧守门（纯逻辑，无 DOM / DSH / 网络依赖）。
 *
 * 为什么插件也要拦一次：
 *   - 平台侧的规则是「该 issue 有 active 接管时，webhook / A2A 不再派发」（P1-6），
 *     但面板上的「重新派发」是**用户手动动作**，不走 webhook 链路；
 *   - 服务端已部署守门时，用户点下去只会看到 `already_taken_over` 这种机读 code；
 *   - 服务端尚未部署时，用户真会把另一个节点拉起来，与接管会话双写同一 worktree。
 *
 * 所以这里在**调用平台之前**先用接管列表拦一次，并给出一句能照着做的中文原因。
 * 探测失败一律放行 —— 这是排障入口，不能因为探测本身出问题就不可用。
 */

export interface TakeoverSessionLite {
  id?: string
  username?: string
  agent_type?: string
  /** 形如 `#3201`（服务端原样返回） */
  issue_id?: string
}

export interface RedispatchGuardInput {
  /** `GET /api/events/{seq}` 的返回主体（拿不到时传 `null` → 放行，交给平台判定） */
  event: { repo_key?: string; issue_id?: string } | null
  /** `GET /api/takeover/sessions?repo_key=..&issue_id=..&status=active` 的 `sessions` */
  sessions?: TakeoverSessionLite[] | null
}

export interface RedispatchGuardResult {
  blocked: boolean
  status: number
  body: Record<string, unknown>
}

/** 把「谁、在哪个节点、哪条接管」拼成一句可执行的话。 */
export function takeoverBlockMessage(sessions: TakeoverSessionLite[]): string {
  const list = Array.isArray(sessions) ? sessions : []
  const first = list[0] || {}
  const agent = String(first.agent_type || '')
  const who = String(first.username || '')
  const id = String(first.id || '')
  const head = list.length > 1 ? `该 issue 有 ${list.length} 条接管进行中` : '该 issue 正被接管'
  const tail = [agent ? `${agent} 节点` : '', who ? `@${who}` : '', id ? `takeover=${id}` : '']
    .filter(Boolean)
    .join(' · ')
  return `${head}${tail ? `（${tail}）` : ''}：接管期间平台暂停自动派发，`
    + '先「确认完成」或「放弃接管」，再重新派发。'
}

/** 裸号（去掉 `#` 与前导零），事件与会话两边口径不一致时用它对齐。 */
function bareIssueId(v: unknown): string {
  return String(v ?? '').replace(/^#/, '').trim().replace(/^0+(?=\d)/, '')
}

/**
 * 这条接管是不是同一个 issue 的。
 *
 * 服务端 `list_takeovers` 已按 `issue_id` 过滤，这里再筛一道是**防服务端口径变化**：
 * 万一参数没生效，repo 下任意 issue 的接管都会把重派挡掉（误伤面从"一个 issue"扩到"整个仓库"）。
 * 会话没带 `issue_id` 时不能判否 —— 宁可拦，也不要放过真正的双写。
 */
export function sameIssue(session: TakeoverSessionLite, issueId: string): boolean {
  const raw = bareIssueId(session?.issue_id)
  if (!raw) return true
  return raw === bareIssueId(issueId)
}

/**
 * 事件详情路径。
 *
 * 平台是 `/api/events/detail/{seq}`，**不是** `/api/events/{seq}` ——
 * 后者在 beta:9443 与 www 上都是 404；写成后者守门永远放行（实测踩过）。
 * 单独抽出来是为了让单测能钉住它，不用起宿主。
 */
export function eventDetailPath(seq: number): string {
  return `/api/events/detail/${seq}`
}

/**
 * active 接管列表路径。`issue_id` 用裸号（服务端会补 `#`），
 * 没有 issue 维度时不要带该参数，否则会退化成"整仓 active 接管"。
 */
export function takeoverListPath(input: { repoKey: string; issueId?: string }): string {
  const qs = new URLSearchParams({ repo_key: input.repoKey, status: 'active' })
  const issueId = bareIssueId(input.issueId)
  if (!issueId) return ''
  qs.set('issue_id', issueId)
  return `/api/takeover/sessions?${qs.toString()}`
}

/** 有事件、且该 issue 确实有 active 接管 → 拒绝重派。 */
export function evaluateRedispatchGuard(input: RedispatchGuardInput): RedispatchGuardResult {
  const allow = { blocked: false, status: 200, body: {} as Record<string, unknown> }
  // 没有 issue 维度的事件（PR 订阅、纯仓库事件）不拦：repo 级 active 接管与它无关，
  // 拦了就是「别人接管 A 单，B 单的 PR 事件也不能重派」。
  const issueId = bareIssueId(input.event?.issue_id)
  if (!input.event || !issueId) return allow
  const sessions = (Array.isArray(input.sessions) ? input.sessions : []).filter((s) => sameIssue(s, issueId))
  if (!sessions.length) return allow
  const message = takeoverBlockMessage(sessions)
  return {
    blocked: true,
    status: 409,
    body: {
      ok: false,
      error: 'takeover_active',
      detail: { code: 409, error: 'takeover_active', message },
    },
  }
}

/**
 * 平台返回值翻译成面板能直接显示的形状。
 *
 * 服务端守门回的是 `409 already_taken_over`（detail 可能是 `{code,message}`，
 * 也可能被拍平成字符串），面板不认 code —— 这里统一翻成同一句话。
 */
export function mapRedispatchReply(api: {
  ok: boolean
  status: number
  data: Record<string, unknown>
}): { status: number; body: Record<string, unknown> } {
  if (api.ok) return { status: api.status, body: api.data || {} }
  const text = JSON.stringify(api.data || {})
  if (api.status === 409 && /already_taken_over|正被.{0,12}接管/.test(text)) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'takeover_active',
        detail: {
          code: 409,
          error: 'takeover_active',
          message: '该 issue 正被接管：平台不会派发新任务；先「确认完成」或「放弃接管」，再重新派发。',
        },
      },
    }
  }
  return { status: api.status, body: api.data || {} }
}
