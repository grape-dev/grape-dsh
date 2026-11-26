/**
 * 需求卡 4 个动作的纯判定（Issue #42）。
 *
 * 为什么单独成模块：面板（`src/client/GrapeFocusPanel.tsx`）只负责渲染与调用，
 * 「要不要预检 / 按钮能不能点 / 深链长什么样 / 复制预填什么」全部是可被
 * `node:test` 覆盖的纯函数。客户端文件不产出 `lib/`，任何放在面板里的判定都测不到。
 *
 * 纯模块：不 import React / DOM / Node 内置。
 */

import { normalizeIssueNumber } from './issue-number.js'
import { repoKeyFor } from './takeover-plan.js'

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

/** 动作需要的最小任务视图（`task-view.ts` 的 `TaskView` 是它的超集） */
export interface ActionTask {
  id?: unknown
  issue_number?: unknown
  status?: unknown
  stage?: unknown
  is_running?: unknown
}

/** 终态状态值：这些状态下「确认完成 / 移交」都不可点 */
const TERMINAL_STATUS = new Set(['completed', 'cancelled', 'canceled', 'closed'])

/** 运行中状态值：只有这些状态才需要预检 `/start` */
const RUNNING_STATUS = new Set(['active', 'processing', 'running'])

/** 内部 id 归一：正整数才算（0 / 字符串 / 非法一律 0） */
export function actionIssueId(task: ActionTask | null | undefined): number {
  const v = task?.id
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,20}$/.test(v.trim()) ? Number(v.trim()) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/** 是否处于终态（业务字段 + stage 兼顾：`stage=done` 也视为结束） */
export function isTerminalTask(task: ActionTask | null | undefined): boolean {
  if (!task) return false
  const status = str(task.status).toLowerCase()
  if (TERMINAL_STATUS.has(status)) return true
  return str(task.stage).toLowerCase() === 'done'
}

/**
 * 运行中谓词。
 *
 * 实测 #42 的 `status` 是 `processing`（不是 Spec 里写的 `active`），所以这里覆盖
 * `active / processing / running` 三种取值 **加上** `is_running === true` —— 只认一种
 * 会让预检在真实数据上永远不触发。
 */
export function isRunningStatus(task: ActionTask | null | undefined): boolean {
  if (!task) return false
  if (task.is_running === true) return true
  return RUNNING_STATUS.has(str(task.status).toLowerCase())
}

/**
 * 是否需要先调 `POST /api/issues/{id}/start`。
 *
 * 只有「运行中 + 拿得到内部 id」才调：其余情况（终态、无 id）直接打开深链，
 * 免得为一个纯展示动作引入必失败请求。`409` 由路由视为「已启动」，同样不阻断。
 */
export function needsPreflightStart(task: ActionTask | null | undefined): boolean {
  return isRunningStatus(task) && actionIssueId(task) > 0
}

/** 「确认完成」是否可用：需要内部 id，且不是终态 */
export function canConfirmDone(task: ActionTask | null | undefined): boolean {
  return actionIssueId(task) > 0 && !isTerminalTask(task)
}

/** 「移交流水线」是否可用：与确认完成同一门槛（缺 id 时禁用并提示刷新，不用编号兜底） */
export function canHandoff(task: ActionTask | null | undefined): boolean {
  return actionIssueId(task) > 0 && !isTerminalTask(task)
}

/**
 * Grape Web 聊天深链。
 *
 * `${base}/app/<owner>/<repo>/#chat/<encodeURIComponent(`issue:<number>:<repo_key>`)>`
 *
 * 冒号与 `/` 必须编码（与官网真实地址一致）：
 * `#chat/issue%3A4%3Agitcode%3Adeveloper_ch%2Ftf-infra`。
 * 不编码时部分浏览器/前端路由会把 `issue:4:gitcode:owner/repo` 当成带路径的 hash，
 * 打不开对应需求聊天。
 *
 * 任何一段缺失都返回空串 —— 宁可不打开，也不把坏链接丢给侧栏浏览器。
 */
export function chatDeepLink(
  baseUrl: string,
  input: { owner: string; repo: string; number: unknown; platform?: string; repoKey?: string },
): string {
  const base = str(baseUrl).replace(/\/+$/, '')
  const owner = str(input.owner)
  const repo = str(input.repo)
  const number = normalizeIssueNumber(input.number)
  const repoKey = str(input.repoKey) || repoKeyFor(input.platform, `${owner}/${repo}`)
  if (!base || !owner || !repo || !number || !repoKey) return ''
  const chatTarget = encodeURIComponent(`issue:${number}:${repoKey}`)
  return `${base}/app/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/#chat/${chatTarget}`
}

/**
 * 需求在代码托管平台的 Web 链接（复制需求的「Issue 链接」用）。
 *
 * 以前直接拿 `focus.url`（`#pipe/<number>` 流水线深链）当 Issue 链接，语义不对：
 * 复制出来的需求指向的是流水线页，不是需求页。这里按平台拼真实 Issue URL；
 * 平台未知时按 GitCode 处理（与插件其余默认一致）。
 */
export function issueWebUrl(
  platform: string | undefined,
  owner: string,
  repo: string,
  number: unknown,
): string {
  const o = str(owner)
  const r = str(repo)
  const n = normalizeIssueNumber(number)
  if (!o || !r || !n) return ''
  const host = str(platform).toLowerCase() === 'gitee' ? 'https://gitee.com' : 'https://gitcode.com'
  return `${host}/${o}/${r}/issues/${n}`
}

/** 复制需求的预填值 */
export interface CopyPrefill {
  title: string
  description: string
}

/** 平台标题上限（与 `create-issue.ts` 的校验一致） */
const TITLE_MAX = 200
/** 副本后缀（4 个字符：`（副本）`） */
const COPY_SUFFIX = '（副本）'

/**
 * 复制需求的预填（标题 +「（副本）」、描述 + Issue 链接）。
 *
 * - 标题截断到 `200 - 后缀长度` 再加后缀，保证总长不超平台上限；
 * - 源标题为空时给「需求副本」占位（用户可直接改）；
 * - 描述为空时只留 Issue 链接 —— 平台复制表单里描述是**必填**，留空会让用户提交失败。
 */
export function copyPrefill(input: {
  title?: unknown
  task_description?: unknown
  url?: unknown
}): CopyPrefill {
  const rawTitle = str(input.title)
  const limit = TITLE_MAX - [...COPY_SUFFIX].length
  const baseTitle = rawTitle ? [...rawTitle].slice(0, limit).join('') : '需求副本'
  const title = `${baseTitle}${COPY_SUFFIX}`

  const desc = str(input.task_description)
  const url = str(input.url)
  const link = url ? `Issue 链接: ${url}` : ''
  const description = desc && link ? `${desc}\n\n${link}` : (desc || link)
  return { title, description }
}

/**
 * 移交 skipped / 失败的文案。
 *
 * 两类 `skipped` 是**正常业务结果**（不是错误）：重复移交、目标场景没有可接手的节点。
 * 前端要给出不同措辞，否则用户会以为「点坏了」而反复点击。
 */
export function handoffSkipText(code: string): string {
  if (code === 'duplicate_handoff') return '该需求已移交过这条流水线，无需重复操作'
  if (code === 'target_scene_missing_node') return '目标流水线缺少可接手的节点，请换一条流水线或先完善场景配置'
  return '移交失败'
}