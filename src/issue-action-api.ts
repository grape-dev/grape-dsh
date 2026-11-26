/**
 * 需求卡写路由（`issue-start` / `issue-confirm-done` / `issue-handoff*`）的纯逻辑（Issue #42）。
 *
 * 职责边界与 #40 的 `create-issue.ts` 完全一致：宿主路由只做 `grapeApiCall` 接线，
 * 入参解析、白名单校验、上游错误映射、handoff 结果分类全部落在可 `node:test` 覆盖的纯函数上。
 *
 * 三条硬口径：
 *   ① **只认内部数字 id** —— 移交用 issue number 实测 404，编号绝不冒充分号；
 *   ② 4xx 原状态透传（403 / 404 / 409 的语义各不相同），5xx / 网络 → 502；
 *   ③ handoff 的 `skipped` 是正常业务结果，不能当成异常抛给用户。
 *
 * 纯模块：不 import React / DOM / Node 内置。
 */

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function pickText(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = row[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}

/** 内部 issue id 归一：正整数或纯数字字符串，其余 0（不截断、不四舍五入） */
function toPositiveId(v: unknown): number {
  const n = typeof v === 'number'
    ? v
    : typeof v === 'string' && /^\d{1,20}$/.test(v.trim()) ? Number(v.trim()) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/** 目标场景 id 白名单（与平台场景 id 形态一致：首字符字母数字，≤64） */
export const TARGET_SCENE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export type IssueActionInvalidCode = 'invalid_id' | 'invalid_target_scene'

export type ParsedIssueActionId =
  | { ok: true; id: number }
  | { ok: false; code: IssueActionInvalidCode; message: string }

/**
 * 解析写路由的内部 id（`{ id }` 或 `{ issue_id }`，也接受 query 字符串形态）。
 *
 * 接受数字与纯数字字符串；`0` / 负数 / `#42` / `42.0` / `IKXR3B` 一律拒绝 ——
 * 后者是 issue number 形态，拿它打 `/api/issues/{id}/...` 必然 404。
 */
export function parseIssueActionId(raw: unknown): ParsedIssueActionId {
  const row = rec(raw)
  // 只接受对象形态：裸数字/字符串没有字段语义，放行会让「编号冒充分号」重新有口子
  const value = row ? (row.id ?? row.issue_id) : undefined
  const id = toPositiveId(value)
  if (!id) {
    return { ok: false, code: 'invalid_id', message: '需要内部 issue id（正整数），不能使用 issue 编号' }
  }
  return { ok: true, id }
}

/** handoff 入参归一结果 */
export interface HandoffValue {
  id: number
  target_scene_id: string
}

export type HandoffValidation =
  | { ok: true; value: HandoffValue }
  | { ok: false; code: IssueActionInvalidCode; message: string }

/**
 * 校验移交入参：`{ id, target_scene_id }`。
 *
 * id 先校验（错误码优先级与守卫一致：越靠前的错误越先报），
 * `target_scene_id` 必须命中白名单 —— 它会被拼进平台请求体，不能让任意字符串进。
 */
export function validateHandoffInput(raw: unknown): HandoffValidation {
  const row = rec(raw) ?? {}
  const id = parseIssueActionId(row)
  if (!id.ok) return id

  const target = typeof row.target_scene_id === 'string' ? row.target_scene_id.trim() : ''
  if (!TARGET_SCENE_ID_RE.test(target)) {
    return { ok: false, code: 'invalid_target_scene', message: '目标流水线 id 不合法（字母数字开头，允许 _ -，≤64 字）' }
  }
  return { ok: true, value: { id: id.id, target_scene_id: target } }
}

/** 错误映射入参（与 `create-issue.ts` 同形，便于路由复用同一套取值） */
export interface IssueActionErrorInput {
  status?: number | null
  data?: unknown
  requestId?: string
}

export interface IssueActionErrorMapped {
  status: number
  body: Record<string, unknown>
}

/**
 * 上游失败 → 宿主可读错误。
 *
 * - 4xx 原状态透传（403 权限 / 404 找不到 / 409 状态冲突的处置完全不同）；
 * - 5xx / 网络层失败 → `502 upstream_unavailable`（不把裸 500 丢给用户）；
 * - message 只取 `message/error/msg`，**不透出 `raw`**（截断的原始响应体可能含内部堆栈）；
 * - `request_id` 先 body 后响应头。
 */
export function toIssueActionError(input: IssueActionErrorInput): IssueActionErrorMapped {
  const rawStatus = typeof input.status === 'number' && Number.isFinite(input.status)
    ? Math.trunc(input.status)
    : 0
  const upstream5xx = rawStatus === 0 || rawStatus >= 500
  const status = upstream5xx ? 502 : rawStatus

  const row = rec(input.data) ?? {}
  const upstreamCode = pickText(row, ['code', 'error_code'])
  const code = upstream5xx ? 'upstream_unavailable' : (upstreamCode || 'issue_action_failed')

  const fallback = rawStatus
    ? `操作失败（HTTP ${rawStatus}）`
    : '操作失败（无法连接 Grape 服务）'
  const message = pickText(row, ['message', 'error', 'msg']) || fallback

  const bodyRequestId = pickText(row, ['request_id'])
  const requestId = bodyRequestId || (typeof input.requestId === 'string' ? input.requestId.trim() : '')

  const body: Record<string, unknown> = { ok: false, code, message }
  if (requestId) body.request_id = requestId
  return { status, body }
}

/** `POST /api/issues/{id}/start` 的 409 = 已经启动过：按成功处理（继续打开深链） */
export function isAlreadyStarted(status: number | null | undefined): boolean {
  return status === 409
}

/** 已识别的 handoff 业务结果 */
export type HandoffSkipCode = 'duplicate_handoff' | 'target_scene_missing_node' | ''

export type HandoffOutcome =
  | { ok: true; seq: number }
  | { ok: false; skipped: HandoffSkipCode; message: string; code: string }

const KNOWN_SKIP: readonly HandoffSkipCode[] = ['duplicate_handoff', 'target_scene_missing_node']

/**
 * handoff 成功 / 跳过 / 失败分类。
 *
 * 平台口径：`seq > 0` 表示真的移交了（产生新事件）；`skipped`（或等价放在 `code` 里）
 * 是**正常业务结果** —— `duplicate_handoff`（已经移交过）、`target_scene_missing_node`
 * （目标场景没有可接手节点）。其它一律保留原文 + code，不伪装成 skipped。
 */
export function classifyHandoffResult(data: unknown): HandoffOutcome {
  const row = rec(data) ?? {}
  const seq = typeof row.seq === 'number'
    ? row.seq
    : typeof row.seq === 'string' && /^\d{1,20}$/.test(row.seq.trim()) ? Number(row.seq.trim()) : 0
  if (Number.isSafeInteger(seq) && seq > 0) return { ok: true, seq }

  const rawSkip = pickText(row, ['skipped'])
  const rawCode = pickText(row, ['code', 'error_code'])
  const skip = ([rawSkip, rawCode].find((v) => KNOWN_SKIP.includes(v as HandoffSkipCode)) ?? '') as HandoffSkipCode
  const message = pickText(row, ['message', 'error', 'msg'])
    || (skip === '' ? '移交失败' : '')
  return { ok: false, skipped: skip, message, code: rawCode }
}