/**
 * 接管流程（Issue #40 P2）—— 把 `GrapeFocusPanel` 里内联的 onTakeover 抽成可复用函数。
 *
 * 为什么要抽：节点按钮（点某个节点直接接管）与「创建需求并接管」（等首节点起来再接管）
 * 必须走**同一套**顺序逻辑：乐观 busy → POST takeover → 写 localStorage / 共享态 →
 * 切工作区并发 prompt → 失败给可读原因 + 服务端自检。两处各写一遍迟早漂移，
 * 而这条链路每一步的顺序错了都表现为「接管了却没反应」。
 *
 * 平台透传：仓库来自浏览视图时带 `platform`（Gitee 的 `owner/repo` 不能落到 GitCode 的同名仓库）；
 * 焦点卡没有平台信息时传空串，宿主按缺省 `gitcode` 处理（向后兼容）。
 */

import { setNotice } from './pins-store.js'
import { setMode } from './tab-mode.js'
import { autoOpenOrSwitch } from './panel-control.js'
import { switchToTakeoverWorkspace, tkLog } from './takeover-switch.js'
import { setTakeoverBusy, setTakeoverSession } from './takeover-store.js'
import { takeoverFailureText, normalizeTakeoverList } from '../takeover-plan.js'

/** 一次接管请求 */
export interface TakeoverRequest {
  owner: string
  repo: string
  /** 代码平台（gitcode / gitee / github …）；未知传空串 */
  platform?: string
  /** issue 编号（Gitee 字母数字也按字符串透传） */
  number: string
  /** 实际运行节点的 tag（不是写死的 coding） */
  agentType: string
}

/** 接管结果：`ok=false` 时 message 可直接展示 */
export interface TakeoverResult {
  ok: boolean
  code?: string
  message?: string
  requestId?: string
  takeoverId?: string
  agentType?: string
  workspaceId?: string
  workspaceCwd?: string
  /** 平台降级到旧协议（会在提示里标注） */
  degraded?: boolean
}

/** 宿主 takeover 端点的响应体（只列用到的字段） */
interface TakeoverBody {
  ok?: boolean
  prompt?: string
  error?: string
  takeoverId?: string
  cancelOk?: boolean
  cancelError?: string
  taskId?: string
  workspaceId?: string
  workspaceName?: string
  workspaceError?: string
  workspaceCwd?: string
  workspaceCreated?: boolean
  envFile?: string
  degraded?: boolean
  notice?: string
  /** 平台业务码（如 taken_by_other）与可关联日志的 request_id */
  code?: string | number
  request_id?: string
}

const TAKEOVER_LIST_TIMEOUT_MS = 8000

/**
 * 查某 issue 的 active 接管（服务端为准，localStorage 只是提示优化）。
 *
 * 失败返回 `null`（与「真的没有 active 接管」的 `[]` 区分开）：
 * 调用方既不能把一次性查询失败当成「没有接管」，也不该覆盖原始错误提示。
 * 4xx/5xx / `ok:false` / 错误页由 `normalizeTakeoverList` 统一归 null —— 宿主会把
 * 上游失败状态与响应体原样透传，不能当成「确认没有接管」。
 */
export async function postTakeoverList(input: {
  repo: string
  issue: string
  platform?: string
}, timeoutMs: number = TAKEOVER_LIST_TIMEOUT_MS): Promise<Array<{ id?: string; [k: string]: unknown }> | null> {
  if (!input.repo) return null
  const payload: Record<string, unknown> = { repo: input.repo, issue: input.issue }
  if (input.platform) payload.platform = input.platform
  // 失败自检会 await 这个查询：不设上限时一次服务器挂起会一直阻塞 finally 里的 busy 复位。
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TAKEOVER_LIST_TIMEOUT_MS
  const timer = ctrl ? globalThis.setTimeout(() => ctrl.abort(), limit) : null
  try {
    const res = await fetch(new URL('grape-worker-api/takeover-list', document.baseURI).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl?.signal,
    })
    const data = await res.json().catch(() => null)
    return normalizeTakeoverList(res, data)
  } catch {
    return null
  } finally {
    if (timer != null) globalThis.clearTimeout(timer)
  }
}

/** 把 prompt 填进当前会话的输入框并尽量自动发送（宿主未建出 workspace 时的兜底） */
function injectIntoCurrentSession(prompt: string, okNote: string, failNote: string): void {
  const box = document.querySelector('[role=textbox]') as HTMLElement | null
  if (!box) {
    setNotice(`${okNote}${failNote}prompt 已复制到剪贴板（未找到输入框，请手动粘贴）`)
    return
  }
  box.focus()
  document.execCommand('insertText', false, prompt)
  window.setTimeout(() => {
    const btn = document.querySelector('[aria-label="Send message"]') as HTMLButtonElement | null
    if (btn && !btn.disabled) {
      btn.click()
      setNotice(`${okNote}${failNote}已在当前会话接手`)
    } else {
      setNotice(`已把接管 prompt 填入输入框；${failNote}请手动发送`)
    }
  }, 400)
}

/**
 * 发起接管（节点按钮与「创建并接管」共用）。
 *
 * 顺序与原内联实现一致：先给乐观态（点下去立刻有反馈），成功后写本地/共享态并切工作区；
 * 失败给可读原因，并自检服务端是否其实已落库（半状态时提示「已生效，别重复点」）。
 */
export async function requestTakeover(req: TakeoverRequest): Promise<TakeoverResult> {
  const repoStr = `${req.owner}/${req.repo}`
  const issueNum = String(req.number)
  const agent = String(req.agentType || '')
  if (!repoStr || !issueNum) {
    return { ok: false, message: '缺少仓库或 issue 编号，无法接管' }
  }
  if (!agent) {
    return { ok: false, code: 'no_running_node', message: takeoverFailureText({ code: 'no_running_node' }) }
  }

  // 乐观态：按钮立刻变「接管中…」，不等网络往返（否则点下去 1s 内像没反应）
  setTakeoverBusy(repoStr, issueNum, agent)
  setNotice(`正在接管 #${issueNum} 的 ${agent} 节点…`, 8000)
  // 切到本机 tab 让用户看到接管结果
  setMode('live')
  autoOpenOrSwitch()

  const payload: Record<string, unknown> = { issue_number: issueNum, repo: repoStr, agent_type: agent }
  if (req.platform) payload.platform = req.platform

  try {
    // 自己发请求（而不是走 postJson）是为了拿到 HTTP 状态：失败文案要按 401/403/5xx 分流
    const res = await fetch(new URL('grape-worker-api/takeover', document.baseURI).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    const status = res.status
    const body = (await res.json().catch(() => ({}))) as TakeoverBody
    tkLog('panel_response', {
      ok: Boolean(body.ok), hasPrompt: Boolean(body.prompt),
      workspaceId: body.workspaceId || '', takeoverId: body.takeoverId || '',
      keys: Object.keys(body).join(','),
    })

    if (body.ok && body.prompt) {
      try { await navigator.clipboard.writeText(body.prompt) } catch { /* 剪贴板不可用不影响接管 */ }
      const tkKey = `grape.takeover.${repoStr}#${issueNum}`
      if (body.takeoverId) {
        try {
          localStorage.setItem(tkKey, JSON.stringify({ id: body.takeoverId, agent, issue: issueNum }))
        } catch { /* 隐私模式 / 配额满：不影响主流程 */ }
        // 立即把「接管中」写进共享态：节点按钮不必等 15s 轮询才变
        setTakeoverSession(repoStr, issueNum, {
          id: String(body.takeoverId), agent, local: '', ready: false,
        })
      }

      // 旧服务端回退：如实提示「已降级到旧协议」，不让用户以为走的是新协议
      const degradedNote = body.degraded && body.notice ? `；⚠ ${body.notice}` : ''
      if (body.workspaceId) {
        // 真正的「拉到本地」：插件已把任务目录登记成 workspace，
        // 这里让 dsh 前端在它下面开新会话并自动发送接管 prompt（前端入口才落盘绑 workspace）。
        switchToTakeoverWorkspace(body.prompt, body.workspaceId, body.workspaceName, String(body.takeoverId || ''))
        const cancelNote = body.cancelOk
          ? `原任务 ${body.taskId} 已取消`
          : `⚠ 原任务取消失败（${body.cancelError || 'unknown'}）`
        const wsNote = body.workspaceCreated ? '已新建工作区' : '复用已有工作区'
        setNotice(`已接管 #${issueNum} ${agent}，${cancelNote}；${wsNote} ${body.workspaceCwd}${degradedNote}，正在开新会话…`)
        return {
          ok: true,
          takeoverId: String(body.takeoverId || ''),
          agentType: agent,
          workspaceId: body.workspaceId,
          workspaceCwd: body.workspaceCwd || '',
          degraded: Boolean(body.degraded),
        }
      }

      // 兜底：没建出 workspace（宿主未能登记本机目录）→ 在当前会话发送，
      // 但必须说清「为什么没建工作区」，否则用户只会看到「接管了却没反应」。
      const wsFailNote = body.workspaceError ? `⚠ 未建工作区（${body.workspaceError}）；` : ''
      const cancelNote = body.cancelOk
        ? `原任务 ${body.taskId} 已取消`
        : `⚠ 原任务取消失败（${body.cancelError || 'unknown'}）`
      injectIntoCurrentSession(
        body.prompt,
        `已接管 #${issueNum} ${agent}，${cancelNote}；`,
        `${wsFailNote}${degradedNote}`,
      )
      return {
        ok: true,
        takeoverId: String(body.takeoverId || ''),
        agentType: agent,
        degraded: Boolean(body.degraded),
      }
    }

    // 失败：taken_by_other 最常见（多半是上一次 500 其实已建成功，用户以为失败又点一次）
    const code = body.code == null ? '' : String(body.code)
    const rid = String(body.request_id || '')
    const reason = takeoverFailureText({ code, status, message: body.error })
    const ridNote = rid ? `；request_id=${rid}（发给平台可定位日志）` : ''
    const codeNote = code && !reason.includes(code) ? `（${code}）` : ''
    setNotice(`接管失败：${reason}${codeNote}${ridNote}`, 30000)

    // 失败自检：服务端可能在落库之后才报错（半状态），查一次是否已有 active 接管，
    // 有就明确告诉用户「已生效」，不要反复点。
    const sessions = await postTakeoverList({ repo: repoStr, issue: issueNum, platform: req.platform })
    const one = sessions?.[0]
    if (one?.id) {
      setNotice(`接管已创建（takeover_id=${String(one.id)}），但本次请求报了错：参数已落库。` +
        `请在接管条里点「完成/放弃」，不要重复点接管。${ridNote}`, 30000)
    }
    return {
      ok: false,
      code,
      message: reason,
      requestId: rid,
      takeoverId: body.takeoverId ? String(body.takeoverId) : '',
    }
  } catch (err) {
    tkLog('panel_error', { error: String(err) })
    const message = takeoverFailureText({ network: true })
    setNotice(`接管失败：${message}`, 30000)
    return { ok: false, code: 'network_error', message }
  } finally {
    setTakeoverBusy(repoStr, issueNum, '')
  }
}