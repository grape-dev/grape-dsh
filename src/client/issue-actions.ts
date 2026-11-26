/**
 * 需求卡 4 个动作的**客户端接线**（Issue #42）。
 *
 * 分工（与 #40 的 `create-issue-flow.ts` 一致）：
 *   · 判定（要不要预检 / 按钮能不能点 / 深链 / 复制预填 / 文案）全部 import 自
 *     `../issue-actions.ts`（编译进 `lib/`，可 `node:test` 直接覆盖）；
 *   · 本文件只做 `fetch` / 外链（系统浏览器）/ notice 这类 DOM 副作用，**不写判定**。
 *
 * 所有请求走同源相对路径（`document.baseURI`）：dsh 支持子路径挂载，
 * 相对解析在「根挂载」与「/dsh/ 前缀」两种部署下都对。
 */

import { chatDeepLink, needsPreflightStart } from '../issue-actions.js'
import type { HandoffTarget, SceneView, TaskView } from '../task-view.js'
import { panelGet } from './browse-store.js'

/** 动作目标（owner/repo/number 均为归一后的字符串；platform 用于平台消歧） */
export interface ActionTarget {
  owner: string
  repo: string
  number: string
  platform?: string
}

/** 写路由的统一回包（失败也带回可读文案，不抛给组件） */
export interface ActionReply {
  ok: boolean
  /** 业务跳过码（目前只有 handoff 的 duplicate_handoff / target_scene_missing_node） */
  skipped?: string
  /** 可读原因 / 提示 */
  message?: string
  /** 平台业务码（invalid_id / upstream_unavailable / forbidden …） */
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

/** 宿主 `/grape-worker-api` 的同源 JSON GET */
async function getJson<T>(path: string, query: URLSearchParams): Promise<T> {
  const url = new URL(`grape-worker-api/${path}?${query.toString()}`, document.baseURI).toString()
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  return (await res.json().catch(() => ({}))) as T
}

/** 不抛错的结果归一：网络异常也变成可读文案（面板直接展示） */
function toReply(body: { ok?: boolean; skipped?: string; message?: string; code?: string; error?: string }): ActionReply {
  return {
    ok: body.ok === true,
    skipped: body.skipped || '',
    message: body.message || body.error || '',
    code: body.code || '',
  }
}

/**
 * 拉取需求卡任务视图（懒加载；`force` 用于动作成功后精确刷新）。
 *
 * 失败**不抛**：返回 `{ task: null, message }`，面板据此禁用需要内部 id 的按钮并提示刷新。
 */
export async function loadTask(
  target: ActionTarget,
  opts: { force?: boolean } = {},
): Promise<{ task: TaskView | null; baseUrl: string; message: string }> {
  const qs = new URLSearchParams({ owner: target.owner, repo: target.repo, number: target.number })
  if (target.platform) qs.set('platform', target.platform)
  if (opts.force) qs.set('force', '1')
  try {
    const { data, message, baseUrl } = await panelGet('task', qs)
    const base = baseUrl || ''
    if (message) return { task: null, baseUrl: base, message }
    return { task: (data as TaskView) ?? null, baseUrl: base, message: '' }
  } catch (err) {
    return { task: null, baseUrl: '', message: `任务信息加载失败：${String(err)}` }
  }
}

/**
 * 拉取仓库场景列表（复制需求 / 移交目标）。
 *
 * 带上 `scene_id` 是为了让宿主在 user_only 快路径 403 时能降级成「当前场景单条」，
 * 而不是回空列表 —— 复制表单至少还能提交到源场景。
 */
export async function loadScenes(
  target: ActionTarget,
  sceneId?: string,
): Promise<{ scenes: SceneView[]; degraded: boolean; message: string }> {
  const qs = new URLSearchParams({ owner: target.owner, repo: target.repo })
  if (sceneId) qs.set('scene_id', sceneId)
  try {
    const { data, message } = await panelGet('scenes', qs)
    if (message) return { scenes: [], degraded: true, message }
    const scenes = Array.isArray(data) ? (data as SceneView[]) : []
    return { scenes, degraded: scenes.some((s) => s.degraded === true), message: '' }
  } catch (err) {
    return { scenes: [], degraded: true, message: `场景加载失败：${String(err)}` }
  }
}

/**
 * 「进入对话」：运行中先预检 `/start`（**失败不阻断**），再打开 Grape Web 聊天深链。
 *
 * 打开目标是**系统浏览器（Grape 官网）**，与「在官网打开」按钮一致（0.5.4 用户要求）：
 * 侧栏内嵌浏览器交互受限（登录态、窄宽度、与官网页面抢空间），不再使用。
 * 成功不返回提示语（0.5.4 用户要求：打开即打开，不再弹「已在浏览器打开…」）。
 */
export async function enterChat(
  target: ActionTarget,
  task: TaskView | null,
  baseUrl: string,
): Promise<ActionReply> {
  const link = chatDeepLink(baseUrl, {
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    platform: target.platform,
    repoKey: task?.repo_key || '',
  })
  if (!link) return { ok: false, message: '无法生成聊天链接（请刷新后重试）' }

  if (task && needsPreflightStart(task)) {
    // 409（已启动）在路由层已折算成 ok；这里连失败都不阻断打开
    await startIssue(Number(task.id)).catch(() => null)
  }
  // 与「在官网打开」同一打开方式：交给系统浏览器，保持单一外链口径
  window.open(link, '_blank', 'noopener,noreferrer')
  return { ok: true }
}

/** 预检 `POST /api/issues/{id}/start`（内部 id） */
export async function startIssue(id: number): Promise<ActionReply> {
  try {
    return toReply(await postJson('issue-start', { id }))
  } catch (err) {
    return { ok: false, message: `启动会话失败：${String(err)}` }
  }
}

/** 确认需求完成（内部 id；`confirmation` 由宿主补 `user_confirmed`） */
export async function confirmDone(id: number): Promise<ActionReply> {
  try {
    return toReply(await postJson('issue-confirm-done', { id }))
  } catch (err) {
    return { ok: false, message: `确认完成失败：${String(err)}` }
  }
}

/** 移交目标（内部 id；拿编号打会 404） */
export async function loadHandoffTargets(
  id: number,
): Promise<{ scenes: HandoffTarget[]; message: string }> {
  if (!(id > 0)) return { scenes: [], message: '缺少需求内部 id，请刷新后重试' }
  try {
    const body = await getJson<{ ok?: boolean; scenes?: HandoffTarget[]; message?: string; error?: string }>(
      'issue-handoff-targets',
      new URLSearchParams({ id: String(id) }),
    )
    if (!body.ok) return { scenes: [], message: body.message || body.error || '移交目标加载失败' }
    return { scenes: Array.isArray(body.scenes) ? body.scenes : [], message: '' }
  } catch (err) {
    return { scenes: [], message: `移交目标加载失败：${String(err)}` }
  }
}

/** 移交到目标流水线（内部 id + 场景 id） */
export async function submitHandoff(id: number, targetSceneId: string): Promise<ActionReply> {
  try {
    return toReply(await postJson('issue-handoff', { id, target_scene_id: targetSceneId }))
  } catch (err) {
    return { ok: false, message: `移交失败：${String(err)}` }
  }
}