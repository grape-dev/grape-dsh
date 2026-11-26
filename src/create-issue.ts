/**
 * 创建需求的纯逻辑（Issue #40 P1）：输入校验 / 编号提取 / 错误映射。
 *
 * 为什么单独成模块：宿主路由（`/grape-worker-api/create-issue`）与面板只做接线，
 * 判定全部落在可 `node:test` 覆盖的纯函数上 —— 校验、编号归一、错误文案任何一处
 * 回归都能被单测挡住，而不是靠人点按钮。
 *
 * 编号口径**复用** `issue-number.ts`（#39 收敛的唯一出处）：Gitee 字母数字、
 * 拒 `"0"`、缺失归空串；取不到编号时调用方只回 warning，**绝不自动重建**。
 *
 * 纯模块：不 import React / DOM / Node 内置。
 */

import { normalizeIssueNumber } from './issue-number.js'
import { normalizePlatform, repoKeyFor } from './takeover-plan.js'

/** owner / repo 形态：首字符字母数字，其余字母数字 / `_` `.` `-`，总长 ≤ 100 */
const REPO_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** 校验失败原因码 */
export type CreateIssueValidationCode =
  | 'invalid_owner'
  | 'invalid_repo'
  | 'invalid_title'
  | 'invalid_assignee'
  | 'invalid_scene_id'

/** 校验通过后的归一值（可选字段为空时不出现，直接可拼请求体） */
export interface CreateIssueValue {
  owner: string
  repo: string
  title: string
  description?: string
  assignee?: string
  /** 代码平台（已归一）；缺失/非法不出现，由 repo_key 缺省 gitcode 兜底 */
  platform?: string
  /** 目标流水线场景（Issue #42：复制需求可指定）；缺失时不出现，建单行为与 #40 一致 */
  scene_id?: string
}

/**
 * 场景 id 形态白名单（Issue #42）：首字符字母数字，其余字母数字 / `_` `-`，≤64。
 *
 * 收紧原因：它会直接进平台建单 body，并且与 URL 场景 id 同形态；`..` / 空格 / 斜杠
 * 一律不接受（避免参数走私和拼路径时的意外）。
 */
const SCENE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** 校验结果 */
export type CreateIssueValidation =
  | { ok: true; value: CreateIssueValue }
  | { ok: false; code: CreateIssueValidationCode; message: string }

/** 仓库段校验：形态白名单 + 拒绝 `..`（路径穿越会让拼出来的接口路径跑出仓库范围） */
function validRepoSegment(v: string): boolean {
  return REPO_SEGMENT_RE.test(v) && !v.includes('..')
}

/** 取可选的字符串字段（非字符串视为未提供；trim 后为空也视为未提供） */
function optionalText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 校验建单入参（面板表单 → 宿主路由 body）。
 * 不抛错：任何形态都返回 `{ok:false, code, message}`，路由直接 400 回可读原因。
 */
export function validateCreateIssueInput(raw: unknown): CreateIssueValidation {
  const input = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {}

  const owner = typeof input.owner === 'string' ? input.owner.trim() : ''
  if (!validRepoSegment(owner)) {
    return { ok: false, code: 'invalid_owner', message: '仓库 owner 格式不合法（字母数字开头，允许 . _ -）' }
  }

  const repo = typeof input.repo === 'string' ? input.repo.trim() : ''
  if (!validRepoSegment(repo)) {
    return { ok: false, code: 'invalid_repo', message: '仓库名格式不合法（字母数字开头，允许 . _ -，≤100 字）' }
  }

  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) {
    return { ok: false, code: 'invalid_title', message: '标题不能为空' }
  }
  if (title.length > 200) {
    return { ok: false, code: 'invalid_title', message: '标题不能超过 200 字' }
  }

  const assignee = optionalText(input.assignee)
  if (assignee && !validRepoSegment(assignee)) {
    return { ok: false, code: 'invalid_assignee', message: '指派账号格式不合法（字母数字开头，允许 . _ -）' }
  }

  const description = optionalText(input.description)
  const platform = normalizePlatform(input.platform)
  // Issue #42：可选 scene_id —— 提供了就必须合法（非法直接 400，不静默丢弃：
  // 静默丢弃会让用户以为建到了指定流水线，实际落到默认场景）
  const sceneId = optionalText(input.scene_id)
  if (sceneId && !SCENE_ID_RE.test(sceneId)) {
    return { ok: false, code: 'invalid_scene_id', message: '目标流水线 id 不合法（字母数字开头，允许 _ -，≤64 字）' }
  }
  const value: CreateIssueValue = { owner, repo, title }
  if (description) value.description = description
  if (assignee) value.assignee = assignee
  // 平台必须在这里留住：建单要靠它拼 repo_key，丢了会让 Gitee 仓库落到 GitCode 同名仓库
  if (platform) value.platform = platform
  if (sceneId) value.scene_id = sceneId
  return { ok: true, value }
}

/**
 * 建单请求体（`POST /api/issues/{owner}/{repo}`）。
 *
 * `repo_key` 是**必带**的：平台按它决定去哪个代码平台解析 `owner/repo`
 * （Gitee / GitLab 同名仓库很常见），缺省会退化成 GitCode → 建单失败或串库。
 * 纯函数，宿主路由与单测共用同一口径。
 */
export function buildCreateIssuePayload(value: CreateIssueValue): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    repo_key: repoKeyFor(value.platform, `${value.owner}/${value.repo}`),
    title: value.title,
  }
  if (value.description) payload.description = value.description
  if (value.assignee) payload.assignee = value.assignee
  // Issue #42：只在提供时才出现 —— 不传时载荷与 #40 完全一致（回归保障）
  if (value.scene_id) payload.scene_id = value.scene_id
  return payload
}

/**
 * 从建单响应里取编号：`issue_number → number → issue_id`，逐字段过归一。
 *
 * 平台/版本字段名不一致（GitCode 整数、Gitee 字母数字、旧接口 `issue_id`），
 * 任一字段归一后非空即返回；全空返回 `''`，由调用方提示刷新而**不重建**。
 */
export function extractCreatedIssueNumber(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const row = data as Record<string, unknown>
  for (const key of ['issue_number', 'number', 'issue_id'] as const) {
    const n = normalizeIssueNumber(row[key])
    if (n) return n
  }
  return ''
}

/** 建单错误映射入参 */
export interface CreateIssueErrorInput {
  /** 上游 HTTP 状态（0 / 缺失 = 网络层失败） */
  status?: number | null
  /** 上游响应体（可能是 JSON，也可能是 grapeApiCall 收口后的 `{ raw }`） */
  data?: unknown
  /** 响应头里的 request id（`request-id` / `x-request-id`） */
  requestId?: string
}

/** 建单错误映射结果（`status` 直接用作宿主回包状态） */
export interface CreateIssueErrorMapped {
  status: number
  body: Record<string, unknown>
}

function pickText(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = row[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}

/**
 * 上游失败 → 宿主可读错误。
 *
 * - 4xx 原状态透传（用户能据此判断是无权限还是参数错），code 取平台 `code/error_code`；
 * - 5xx / 网络层失败 → **502 + `upstream_unavailable`**（不把裸 HTTP 500 丢给用户）；
 * - message 只取 `message/error/msg`，**不透出 `raw`**（那是截断的原始响应体，可能含内部堆栈）；
 * - `request_id` 先 body 后响应头，便于用户/平台对齐日志。
 */
export function toCreateIssueError(input: CreateIssueErrorInput): CreateIssueErrorMapped {
  const rawStatus = typeof input.status === 'number' && Number.isFinite(input.status)
    ? Math.trunc(input.status)
    : 0
  const upstream5xx = rawStatus === 0 || rawStatus >= 500
  const status = upstream5xx ? 502 : rawStatus

  const row = (input.data && typeof input.data === 'object' && !Array.isArray(input.data))
    ? input.data as Record<string, unknown>
    : {}

  const upstreamCode = pickText(row, ['code', 'error_code'])
  const code = upstream5xx ? 'upstream_unavailable' : (upstreamCode || 'create_issue_failed')

  const fallback = rawStatus
    ? `创建需求失败（HTTP ${rawStatus}）`
    : '创建需求失败（无法连接 Grape 服务）'
  const message = pickText(row, ['message', 'error', 'msg']) || fallback

  const bodyRequestId = pickText(row, ['request_id'])
  const requestId = bodyRequestId || (typeof input.requestId === 'string' ? input.requestId.trim() : '')

  const body: Record<string, unknown> = { ok: false, code, message }
  if (requestId) body.request_id = requestId
  return { status, body }
}