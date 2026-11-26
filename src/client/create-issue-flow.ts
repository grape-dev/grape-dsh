/**
 * 「创建需求」与「创建需求并接管」流程（Issue #40 P1 + P2）。
 *
 * 为什么单独成模块：面板只负责表单与渲染，建单请求与结果归一放在这里，
 * 「创建并接管」的轮询 / 接管编排也走同一入口，避免两处各写一遍顺序而迟早漂移。
 *
 * 依赖面都是同源相对路径（`document.baseURI`）：dsh 支持子路径挂载，
 * 相对解析在「根挂载」与「/dsh/ 前缀」两种部署下都对。
 */

import { normalizeIssueNumber } from '../issue-number.js'
import { derivePipelineViewFromData } from '../pipeline-model.js'
import { pickRunningAgent } from '../takeover-plan.js'
import { panelGet } from './browse-store.js'
import { requestTakeover, type TakeoverResult } from './takeover-flow.js'

/** 建单入参（仓库来自当前浏览视图，平台一并带下去以区分 Gitee / GitCode 同名仓库） */
export interface CreateIssueRequest {
  owner: string
  repo: string
  platform?: string
  title: string
  description?: string
  assignee?: string
  /** 目标流水线场景（Issue #42：复制需求可指定；不传时行为与 #40 完全一致） */
  sceneId?: string
}

/** 建单结果：`ok:true` 且 `number:''` 表示「已创建但未拿到编号」 */
export interface CreateIssueResult {
  ok: boolean
  number: string
  /** 服务端 warning（目前只有 `no_issue_number`） */
  warning?: string
  /** 可读原因（失败或未拿到编号时均有） */
  message?: string
  /** 失败的业务码（invalid_title / upstream_unavailable / not_configured …） */
  code?: string
}

/** 宿主 `/grape-worker-api` 的同源 JSON POST */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(new URL(`grape-worker-api/${path}`, document.baseURI).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json().catch(() => ({}))) as T
}

/**
 * 建单：POST `/grape-worker-api/create-issue`（宿主再打 `POST /api/issues/{owner}/{repo}`）。
 *
 * 不抛错：网络异常也归一成 `{ok:false, message}`，面板直接展示。
 * 成功但无编号时**不重试 / 不重建**（平台可能已建成功，重试会造重复需求）。
 */
export async function createIssue(req: CreateIssueRequest): Promise<CreateIssueResult> {
  const payload: Record<string, unknown> = { owner: req.owner, repo: req.repo, title: req.title }
  if (req.description) payload.description = req.description
  if (req.assignee) payload.assignee = req.assignee
  if (req.platform) payload.platform = req.platform
  // Issue #42：只在指定场景时才出现（#40 的请求体保持不变）
  if (req.sceneId) payload.scene_id = req.sceneId
  try {
    const body = await postJson<{
      ok?: boolean
      number?: string
      warning?: string
      message?: string
      code?: string
      error?: string
    }>('create-issue', payload)
    if (!body.ok) {
      return {
        ok: false,
        number: '',
        code: body.code || '',
        message: body.message || body.error || '创建需求失败',
      }
    }
    const number = normalizeIssueNumber(body.number)
    if (!number) {
      return {
        ok: true,
        number: '',
        warning: body.warning || 'no_issue_number',
        message: body.message || '已创建但未拿到编号，请刷新列表',
      }
    }
    return { ok: true, number }
  } catch (err) {
    return { ok: false, number: '', message: `创建需求失败：${String(err)}` }
  }
}


/** 轮询首节点的默认参数（Spec：1.5s 一次、最多 60s） */
export const FIRST_NODE_POLL_MS = 1500
export const FIRST_NODE_TIMEOUT_MS = 60_000

export interface WaitFirstNodeOptions {
  /** 取一次 pipeline 数据（默认走宿主代理 `panelGet('pipeline', {force:'1'})`） */
  fetchPipeline?: (args: { owner: string; repo: string; number: string }) => Promise<unknown>
  /** sleep 注入（单测 / 降级时替换，默认真等） */
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  timeoutMs?: number
  /** 取消信号：中途被取消时立即返回空串 */
  cancelled?: () => boolean
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms) })
}

async function defaultFetchPipeline(args: { owner: string; repo: string; number: string }): Promise<unknown> {
  const qs = new URLSearchParams({ owner: args.owner, repo: args.repo, number: args.number, force: '1' })
  const { data, message } = await panelGet('pipeline', qs)
  if (message) throw new Error(message)
  return data
}

/**
 * 等首个运行中的节点出现（`status === 1`），返回它的 `tag`（作 `agent_type`）。
 *
 * 超时返回空串 —— 由调用方提示「已创建并加入观察，启动后手动接管」，**不重试**、
 * 不撤销 pin（需求确实建好了，只是这一轮没赶上节点启动）。
 */
export async function waitForFirstRunningNode(
  req: { owner: string; repo: string; number: string },
  opts: WaitFirstNodeOptions = {},
): Promise<string> {
  const fetchPipeline = opts.fetchPipeline ?? defaultFetchPipeline
  const sleep = opts.sleep ?? defaultSleep
  const pollMs = opts.pollMs ?? FIRST_NODE_POLL_MS
  const timeoutMs = opts.timeoutMs ?? FIRST_NODE_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    if (opts.cancelled?.()) return ''
    try {
      const data = await fetchPipeline(req)
      const agent = pickRunningAgent(derivePipelineViewFromData(data))
      if (agent) return agent
    } catch {
      // 取数失败按「还没起来」处理：下一轮再试，不把偶发 5xx 变成终态错误
    }
    // 先查再等：立刻取一次（刚建完通常还是 pending，但能早发现已运行），没等到再 sleep
    if (Date.now() + pollMs > deadline) break
    await sleep(pollMs)
  }
  return ''
}

/** 创建并接管的结果（面板据此给提示） */
export interface CreateAndTakeoverResult {
  /** 建单是否成功 */
  created: boolean
  /** 建出来的编号（空串 = 未拿到编号） */
  number: string
  /** 可读提示（成功失败都有：面板直接 setNotice / 表单内展示） */
  message: string
  /** 建单失败的业务码 */
  code?: string
  /** 首节点是否赶上了 */
  tookOver: boolean
  /** 接管结果（赶上节点时才有） */
  takeover?: TakeoverResult
}

/**
 * 单飞去重：同一仓库 + 同一标题在跑时不重复建单（验收 11 —— 双击不会造出两条需求）。
 * 代价是「同一个标题并发两次」被合并成一次，这比重复建单安全得多。
 */
const inFlight = new Set<string>()

/**
 * 「创建需求并接管」编排：createIssue → addPin → setMode('live') →
 * 等首节点运行 → requestTakeover。
 *
 * 超时 / 无运行节点：返回 `created:true, tookOver:false` + 「已创建并加入观察，启动后手动接管」，
 * 保留 pin、不重试。
 */
export async function createIssueAndTakeover(
  req: CreateIssueRequest,
  hooks: {
    /** 加入观察（面板传 addPin） */
    addPin: (input: { owner: string; repo: string; number: string; title: string; platform?: string }) => void
    /** 切到「实时」模式 */
    setMode: (mode: 'live') => void
    /** 提示（面板传 setNotice） */
    setNotice: (text: string, ms?: number) => void
    /** 取消检查（组件卸载 / 用户点取消） */
    cancelled?: () => boolean
  },
  opts: WaitFirstNodeOptions = {},
): Promise<CreateAndTakeoverResult> {
  const key = `${req.owner}/${req.repo}#${req.title}`
  if (inFlight.has(key)) {
    return { created: false, number: '', message: '正在创建中，请稍候…', tookOver: false }
  }
  inFlight.add(key)
  try {
    const created = await createIssue(req)
    if (!created.ok) {
      return { created: false, number: '', message: created.message || '创建需求失败', code: created.code, tookOver: false }
    }
    if (!created.number) {
      // 已创建但没编号：无法加 pin 也不能接管；提示刷新，不重建
      return { created: true, number: '', message: created.message || '已创建但未拿到编号，请刷新列表', tookOver: false }
    }

    const number = created.number
    hooks.addPin({ owner: req.owner, repo: req.repo, number, title: req.title, platform: req.platform })
    hooks.setMode('live')

    const agent = await waitForFirstRunningNode(
      { owner: req.owner, repo: req.repo, number },
      { ...opts, cancelled: opts.cancelled ?? hooks.cancelled },
    )
    if (!agent) {
      const message = `已创建 #${number} 并加入观察，启动后手动接管`
      hooks.setNotice(message, 20000)
      return { created: true, number, message, tookOver: false }
    }

    const takeover = await requestTakeover({
      owner: req.owner,
      repo: req.repo,
      platform: req.platform,
      number,
      agentType: agent,
    })
    return {
      created: true,
      number,
      message: takeover.ok
        ? `已创建 #${number}，正在接管 ${agent} 节点`
        : `已创建 #${number}，但接管 ${agent} 失败：${takeover.message || '未知原因'}`,
      tookOver: takeover.ok,
      takeover,
    }
  } finally {
    inFlight.delete(key)
  }
}
