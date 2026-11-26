/**
 * 需求卡只读视图的投影（Issue #42）。
 *
 * 三个投影函数把 CLI / HTTP 的原始返回**收窄成面板真正要画的字段**：
 *   · `projectTaskView`      —— 卡片 4 个按钮的数据来源（内部 id / 编号 / 场景 / 描述）；
 *   · `projectScenesView`    —— 复制需求的场景下拉（含 user_only 快路径不可用时的降级标记）；
 *   · `projectHandoffTargets` —— 移交流水线的目标列表。
 *
 * 为什么单独成模块：这些判定要能被 `node:test` 直接覆盖（`src/client` 不产出 `lib/`），
 * 而路由与面板只做接线。与 #40 的 `create-issue.ts` 同一条分界线。
 *
 * 关键口径：
 *   · **内部 id 必须保留为数字** —— 移交用 issue number 实测 404，缺 id 时前端禁用按钮，
 *     绝不用编号兜底；
 *   · 编号统一走 `normalizeIssueNumber`（GitCode 整数 / Gitee `IKXR3B`），不产生 `0` 假编号；
 *   · 描述三级回退：`issues mine.task_description` → 首个 `issue_opened` 事件 payload → 空串。
 *
 * 纯模块：不 import React / DOM / Node 内置。
 */

import { normalizeIssueNumber } from './issue-number.js'
import { projectSceneNodes } from './pipeline-model.js'

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''

/** 正整数（内部 issue id）：数字或纯数字字符串，其余一律 0（不猜、不截断） */
function positiveInt(v: unknown): number {
  const n = typeof v === 'number'
    ? v
    : typeof v === 'string' && /^\d{1,20}$/.test(v.trim()) ? Number(v.trim()) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/** 卡片任务视图（字段与 Spec 6.1 一致） */
export interface TaskView {
  /** 内部 issue id（写路由 /start /confirm-done /handoff 必须用它；0 = 取不到） */
  id: number
  /** 归一后的编号字符串（GitCode `42` / Gitee `IKXR3B`） */
  issue_number: string
  repo_key: string
  status: string
  scene_id: string
  /** 需求原文（三级回退后；空串 = 只有标题可用） */
  task_description: string
  conversation_id: string
  title: string
  stage: string
  is_running: boolean
}

/**
 * 从 `issues mine` 的返回里挑出目标 issue。
 *
 * - 接受 `{ issues: [...] }` 信封或裸数组；
 * - 编号按 `normalizeIssueNumber` 比对（`42` 与 `"42"` 等价，Gitee 字母数字大小写敏感）；
 * - 给了 `repoKey` 且行上带 `repo_key` 时必须一致 —— 同一编号在 GitCode / Gitee 是两个需求。
 */
export function findMineIssue(
  raw: unknown,
  input: { repoKey?: string; number: string },
): Record<string, unknown> | null {
  const rows = Array.isArray(raw) ? raw : arr(rec(raw)?.issues)
  const want = normalizeIssueNumber(input.number) || str(input.number).trim()
  if (!want) return null
  for (const r of rows) {
    const row = rec(r)
    if (!row) continue
    const num = normalizeIssueNumber(row.issue_number) || normalizeIssueNumber(row.number)
    if (num !== want) continue
    const key = str(row.repo_key)
    if (input.repoKey && key && key !== input.repoKey) continue
    return row
  }
  return null
}

/** 从首个 `issue_opened` 事件里取描述（`payload.object_attributes.description`） */
function eventDescription(firstEvent: unknown): string {
  const payload = rec(rec(firstEvent)?.payload)
  return str(rec(payload?.object_attributes)?.description).trim()
}

/**
 * 组装卡片任务视图。
 *
 * `row` 是 `findMineIssue` 挑出的 `issues mine` 行，`detail` 是 `issues detail` 的返回，
 * `firstEvent` 是 `events detail --seq <首个 issue_opened>` 的返回 —— 任一层缺失都不报错，
 * 只少字段（前端据此禁用按钮 / 只展示标题）。
 */
export function projectTaskView(input: {
  row?: unknown
  detail?: unknown
  firstEvent?: unknown
  repoKey?: string
}): TaskView {
  const row = rec(input.row) ?? {}
  const detail = rec(input.detail) ?? {}

  const rowDesc = str(row.task_description).trim()
  const taskDescription = rowDesc || eventDescription(input.firstEvent)

  return {
    id: positiveInt(row.id) || positiveInt(detail.issue_id),
    issue_number:
      normalizeIssueNumber(row.issue_number)
      || normalizeIssueNumber(row.number)
      || normalizeIssueNumber(detail.issue_number)
      || normalizeIssueNumber(detail.number),
    repo_key: str(row.repo_key) || str(input.repoKey),
    status: str(row.status) || str(detail.task_status),
    scene_id: str(row.scene_id) || str(detail.scene_id),
    task_description: taskDescription,
    conversation_id: str(row.conversation_id),
    title: str(row.title) || str(detail.title),
    stage: str(row.stage) || str(detail.stage),
    is_running: row.is_running === true,
  }
}

/** 场景（复制需求的场景下拉 / 移交目标） */
export interface SceneView {
  id: string
  display_name: string
  work_branch: string
  pipeline: { nodes: ReturnType<typeof projectSceneNodes> }
  /** 只有降级（user_only 快路径不可用，只拿到当前场景）时才出现 */
  degraded?: boolean
}

/**
 * 场景列表投影：只透出 `id / display_name / work_branch / pipeline.nodes`。
 *
 * 原始响应带 `created_by / icon / scope / engine_runtime_ids` 等大量卡片无关字段，
 * 这里一律丢弃（与 `/issues`、`/dashboard` 的投影同一原则：大响应在宿主侧收窄）。
 * 接受 `{ scenes: [...] }`、裸数组，以及**单场景对象**（`scenes detail` 的降级形态）。
 */
export function projectScenesView(raw: unknown, opts: { degraded?: boolean } = {}): SceneView[] {
  const envelope = rec(raw)
  const list = Array.isArray(raw) ? raw : arr(envelope?.scenes)
  const single = list.length === 0 && envelope && (envelope.id || envelope.scene_id) ? [envelope] : list

  const out: SceneView[] = []
  for (const item of single) {
    const s = rec(item)
    if (!s) continue
    const id = str(s.id) || str(s.scene_id)
    if (!id) continue
    const scene: SceneView = {
      id,
      display_name: str(s.display_name) || str(s.name),
      work_branch: str(s.work_branch),
      pipeline: { nodes: projectSceneNodes(s) },
    }
    if (opts.degraded === true || s.degraded === true) scene.degraded = true
    out.push(scene)
  }
  return out
}

/** 移交目标（列表项） */
export interface HandoffTarget {
  id: string
  display_name: string
  work_branch: string
  is_current: boolean
}

/**
 * 移交目标投影。
 *
 * 平台返回形态不稳定（数组 / `{ targets }` / `{ scenes }` / `{ data }`），这里全部接受。
 *
 * `is_current`（当前流水线标记）两种形态都认（Issue #42 复审 R2）：
 *   ① **顶层** `current_scene_id` —— `GET /api/issues/<id>/handoff/targets` 的真实形状，
 *      `targets[]` 里**没有** `is_current`，只按 item 读会把当前场景判成非当前；
 *      嵌套 `{ data: { current_scene_id, targets } }` 同样取到；
 *   ② item 上的 `is_current: true`（旧形态 / 其它环境）保留兼容。
 * 仍只认严格 true —— 缺失且顶层没有 current_scene_id 时不当成「当前」，否则前端会把
 * 唯一可用目标误标成不可移交。
 */
export function projectHandoffTargets(raw: unknown): HandoffTarget[] {
  const envelope = rec(raw)
  let list: unknown[] = []
  if (Array.isArray(raw)) list = raw
  else {
    for (const key of ['targets', 'scenes', 'data', 'items'] as const) {
      const v = envelope?.[key]
      if (Array.isArray(v)) { list = v; break }
    }
    // 嵌套形态 `{ data: { current_scene_id, targets } }`：列表在 data 里
    if (list.length === 0) {
      const dataEnv = rec(envelope?.data)
      for (const key of ['targets', 'scenes', 'items'] as const) {
        const v = dataEnv?.[key]
        if (Array.isArray(v)) { list = v; break }
      }
    }
  }

  const currentId =
    str(envelope?.current_scene_id)
    || str(rec(envelope?.data)?.current_scene_id)

  const out: HandoffTarget[] = []
  for (const item of list) {
    const s = rec(item)
    if (!s) continue
    const id = str(s.id) || str(s.scene_id)
    if (!id) continue
    out.push({
      id,
      display_name: str(s.display_name) || str(s.name) || str(s.scene_name),
      work_branch: str(s.work_branch),
      is_current: s.is_current === true || (currentId !== '' && id === currentId),
    })
  }
  return out
}