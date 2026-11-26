/**
 * 流水线视图模型 —— host（工具文本渲染）与 client（侧栏面板）共用。
 *
 * 为什么单独成模块（Issue #26）：
 *   · 节点链、整体状态、进度三处口径此前各写一份（面板固定 5 节点、pins 用顶层 status、
 *     文本渲染按事件段逐条画框），结果同一个 issue 在不同界面/工具输出里长得不一样。
 *   · 这里用**一份纯函数**把「场景节点 + 事件段 + 业务状态字段」收敛成一个视图模型，
 *     面板、文本渲染、观察列表都只消费它。
 *
 * 口径（与 Issue #26 Spec 一致）：
 *   §1 节点链以场景为准：scenes detail 的 nodes 决定骨架（id/next/skip/enabled），
 *      场景拿不到时退化为事件段（segments）首次出现顺序，并标记 sceneUnknown。
 *   §2 整体状态以业务字段为准：issue_task_status / issue_stage / review_status；
 *      pipeline 顶层 status 只作为「本次事件是否跑完」的附属提示。
 *   §3 同一 tag 多次出现取 seq 最大那条，链上只占一格，并记录重试次数；
 *      场景外节点照常展示并标记 outsideScene；场景内未跑过的节点为 pending；
 *      被其他节点 skip 列表命中的节点展示为 skipped。
 *   §4 进度：分子 = 已 completed 的格数，分母 = 渲染格数（= 场景节点去重数），
 *      因此恒有 done ≤ total，且 total == 节点格数。
 */

import { statusToNum, type GrapeStatusNum } from './focus.js'

/** 场景节点（scenes detail 的 nodes 元素，字段可能不全） */
export interface SceneNodeInput {
  id?: string
  tag?: string
  skill?: string
  next?: string | null
  skip?: string[]
  enabled?: boolean
}

/** 事件段（issues pipeline 的 segments 元素） */
export interface SegmentInput {
  tag: string
  seq?: number
  status?: string
  /** 已由 statuses[] 解析出的权威状态码（可选） */
  statusCode?: number
  eventType?: string
  duration?: number
  actor?: string
  /** 原始出现顺序，用于无 seq 时排序 */
  order: number
}

/** 服务端业务状态字段 */
export interface StatusFields {
  issue_stage?: string
  issue_task_status?: string
  review_status?: string
  /**
   * `pipeline get` 的 `active.stage`（当前节点）。与 `issue_stage` 语义不同：
   * 它只用于「进行中（qa）」这类展示，不参与整体状态判定（Issue #26 R3）。
   */
  currentStage?: string
  /** pipeline 顶层 status：仅事件级提示，不参与整体判定 */
  status?: string
}

/** 渲染用节点 */
export interface DerivedNode {
  tag: string
  status: GrapeStatusNum
  seq?: number
  dur?: number
  ev?: string
  actor?: string
  /** 重试次数（同一 tag 出现次数 - 1） */
  retries: number
  /** segments 里有、场景里没有 */
  outsideScene: boolean
}

export interface PipelineView {
  nodes: DerivedNode[]
  done: number
  total: number
  /** 场景拉取失败，节点链退化为事件段顺序 */
  sceneUnknown: boolean
  /** 整体状态码（6 = 待审核，是 GrapeStatusNum 的业务扩展） */
  overallCode: GrapeStatusNum
  /** 整体状态短文案（用于 Tag） */
  overallLabel: string
  /** 整体状态详情（如 `qa · 待审核（pending_review）`） */
  overallDetail: string
  /** 是否仍在推进（进行中 / 待审核） */
  executing: boolean
  /** 待审核发生在哪一格（节点 tag）；仅 overallCode === 6 时有值。节点自身 status 不变 */
  reviewTag?: string
  /** 当前阶段 */
  stage?: string
  /** 场景名 */
  scene?: string
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
const numOrUndef = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const norm = (v: string | undefined | null): string => (v ?? '').trim().toLowerCase()
const tagOf = (v: { id?: string; tag?: string }): string => norm(v.tag || v.id || '?')
const isDoneNext = (v: string | undefined | null): boolean => {
  const s = norm(v)
  return s === '' || s === 'done' || s === 'end' || s === 'null'
}

/** 节点状态码标签（在 focus.ts 的 0–5 之外补 6=待审核） */
function statusLabelOf(code: GrapeStatusNum): string {
  switch (code) {
    case 1: return '进行中'
    case 2: return '已完成'
    case 3: return '失败'
    case 4: return '已取消'
    case 5: return '已跳过'
    case 6: return '待审核'
    default: return '待开始'
  }
}

/**
 * 把 `scenes detail` 的 nodes 投影成紧凑结构。
 * 只保留链与状态判定需要的字段，避免把 engine_runtime_ids / scope_check 等大字段带上屏幕。
 */
export function projectSceneNodes(raw: unknown): SceneNodeInput[] {
  const o = asObj(raw)
  if (!o) return []
  return asArr(o.nodes)
    .map((n): SceneNodeInput | null => {
      const no = asObj(n)
      if (!no) return null
      const node: SceneNodeInput = {}
      const id = str(no.id)
      const tag = str(no.tag)
      const skill = str(no.skill)
      const next = str(no.next)
      if (id) node.id = id
      if (tag) node.tag = tag
      if (skill) node.skill = skill
      if (next) node.next = next
      if (Array.isArray(no.skip)) node.skip = no.skip.map((v) => str(v)).filter(Boolean)
      node.enabled = no.enabled !== false
      return node
    })
    .filter((n): n is SceneNodeInput => n !== null)
}

/**
 * 按场景顺序构造节点链。
 *
 * 与 Grape 服务端的链语义保持一致（`pipeline_config.get_next_node` / `is_node_skipped`）：
 *  · 节点按场景 `next` 链推进，`next=done/空` 终止；
 *  · `next` 指向不存在的节点时退回数组顺序的下一格（服务端同样有兜底）；
 *  · `enabled === false` 的节点不进入链；
 *  · 一个节点出现在**其他节点**的 skip 列表里 → 视为跳过（展示用，不改变执行链）。
 */
export function buildSceneChain(nodes: SceneNodeInput[]): Array<SceneNodeInput & { skipped: boolean }> {
  const enabled = nodes.filter((n) => n.enabled !== false)
  if (!enabled.length) return []

  const byKey = new Map<string, SceneNodeInput>()
  for (const n of enabled) {
    const tag = tagOf(n)
    if (!byKey.has(tag)) byKey.set(tag, n)
    const id = norm(n.id)
    if (id && !byKey.has(id)) byKey.set(id, n)
  }

  const skippedTags = new Set<string>()
  for (const n of nodes) {
    for (const s of n.skip ?? []) skippedTags.add(norm(s))
  }

  const chain: Array<SceneNodeInput & { skipped: boolean }> = []
  const seen = new Set<string>()
  let cur: SceneNodeInput | undefined = enabled[0]

  while (cur) {
    const key = tagOf(cur)
    if (seen.has(key)) break
    seen.add(key)
    chain.push({ ...cur, skipped: skippedTags.has(key) || skippedTags.has(norm(cur.id)) })
    const nextKey = norm(cur.next)
    if (isDoneNext(nextKey)) break
    let next = byKey.get(nextKey)
    if (!next) {
      const idx = enabled.indexOf(cur)
      next = enabled.slice(idx + 1).find((n) => n.enabled !== false)
    }
    cur = next
  }

  return chain
}

/**
 * 从 pipeline 数据里提取事件段并解析状态码。
 * 兼容 `issues pipeline` 的 segments / `pipeline get` 的 stages / issue 列表的 agent_statuses。
 */
export function extractSegments(data: unknown): SegmentInput[] {
  const root = asObj(data)
  if (!root) return []
  const active = asObj(root.active) ?? root
  const statuses = asArr(active.statuses).map((v) => numOrUndef(v))

  const segments = asArr(active.segments)
  const stages = asArr(active.stages)
  const agentStatuses = asArr(active.agent_statuses)
  const list = segments.length ? segments : stages.length ? stages : agentStatuses

  return list
    .map((item, i): SegmentInput | null => {
      const o = asObj(item)
      if (!o) return null
      const latest = asObj(o.latest_event)
      const tag = norm(str(o.agent) || str(o.tag))
      if (!tag) return null
      const status = str(latest?.status) || str(o.status)
      const seg: SegmentInput = { tag, order: i }
      const seq = numOrUndef(o.seq) ?? numOrUndef(latest?.seq) ?? numOrUndef(o.latest_seq)
      if (seq !== undefined) seg.seq = seq
      if (status) seg.status = status
      const authoritative = statuses[i] ?? numOrUndef(o.status_num)
      if (authoritative !== undefined) seg.statusCode = authoritative
      const eventType = str(o.event_type) || str(latest?.event_type)
      if (eventType) seg.eventType = eventType
      const duration = numOrUndef(o.duration)
      if (duration !== undefined) seg.duration = duration
      const actor = str(latest?.actor) || str(o.actor)
      if (actor) seg.actor = actor
      return seg
    })
    .filter((s): s is SegmentInput => s !== null)
}

/** 从数据里读取业务状态字段（顶层与 active 子对象都认） */
export function extractStatusFields(data: unknown): StatusFields {
  const root = asObj(data)
  if (!root) return {}
  const active = asObj(root.active) ?? root
  const out: StatusFields = {}
  const stage = str(active.issue_stage) || str(root.issue_stage)
  const currentStage = str(active.stage) || str(root.stage)
  const task = str(active.issue_task_status) || str(active.task_status) || str(root.issue_task_status)
  const review = str(active.review_status) || str(root.review_status)
  const status = str(active.status) || str(root.status)
  if (stage) out.issue_stage = stage
  if (currentStage && currentStage !== stage) out.currentStage = currentStage
  if (task) out.issue_task_status = task
  if (review) out.review_status = review
  if (status) out.status = status
  return out
}

/** 从数据里读取场景节点（host 侧已附加的 scene_nodes） */
export function extractSceneNodes(data: unknown): SceneNodeInput[] | null {
  const root = asObj(data)
  if (!root) return null
  const active = asObj(root.active) ?? root
  const raw = asArr(active.scene_nodes).length ? active.scene_nodes : root.scene_nodes
  if (!Array.isArray(raw) || raw.length === 0) return null
  const nodes = raw
    .map((n): SceneNodeInput | null => {
      const no = asObj(n)
      if (!no) return null
      const node: SceneNodeInput = {}
      const id = str(no.id)
      const tag = str(no.tag)
      const skill = str(no.skill)
      const next = str(no.next)
      if (id) node.id = id
      if (tag) node.tag = tag
      if (skill) node.skill = skill
      if (next) node.next = next
      if (Array.isArray(no.skip)) node.skip = no.skip.map((v) => str(v)).filter(Boolean)
      node.enabled = no.enabled !== false
      return node
    })
    .filter((n): n is SceneNodeInput => n !== null)
  return nodes.length ? nodes : null
}

/** 从数据里读取场景名 */
export function extractSceneName(data: unknown): string {
  const root = asObj(data)
  if (!root) return ''
  const active = asObj(root.active) ?? root
  return str(active.scene_name) || str(root.scene_name) || str(active.scene_id) || str(root.scene_id)
}

const ACTIVE = new Set(['active', 'processing', 'running', 'in_progress', 'takeover', 'taking_over'])
const FAILED = new Set(['failed', 'error'])
const CANCELLED = new Set(['cancelled', 'canceled'])
const PENDING_REVIEW = new Set(['pending_review'])
const COMPLETED = new Set(['completed', 'success', 'done'])

/**
 * 业务状态词全集：出现在 `issue_stage` 里时不得当作节点 tag 展示，
 * 必须参与整体判定（Issue #26 R1：否则「整体待审核」与「链上全绿」并存）。
 */
const BUSINESS_STAGE = new Set<string>([
  ...ACTIVE, ...FAILED, ...CANCELLED, ...PENDING_REVIEW, ...COMPLETED,
])

/**
 * 整体状态判定（业务字段优先）。
 *
 * 返回的 `detail` 会带上原始字段值（如 `pending_review`），方便用户对照服务端，
 * 不再出现「面板显示已完成、Grape 仍在 qa/sre」这种口径错位。
 */
export function deriveOverall(
  fields: StatusFields,
  segments: SegmentInput[],
): { code: GrapeStatusNum; label: string; detail: string; executing: boolean } {
  const stage = norm(fields.issue_stage)
  const task = norm(fields.issue_task_status)
  const review = norm(fields.review_status)

  // issue_stage 有两义：节点 tag（vod/qa…）与服务端偶尔塞进来的业务状态词
  // （pending_review/completed…）。只有前者能当「阶段」展示；后者必须参与判定，
  // 否则会出现「整体待审核、链上全绿」且 detail 重复一遍 pending_review（Issue #26 R1）。
  const stageIsBusiness = Boolean(stage) && BUSINESS_STAGE.has(stage)
  const stageTag = stageIsBusiness ? '' : (stage || norm(fields.currentStage))
  const prefix = stageTag ? `${stageTag} · ` : ''
  const biz = [task, review, stageIsBusiness ? stage : ''].filter(Boolean)
  const firstOf = (set: Set<string>): string => biz.find((v) => set.has(v)) ?? ''

  if (firstOf(COMPLETED)) {
    return { code: 2, label: '已完成', detail: `${prefix}已完成`.trim(), executing: false }
  }
  const failed = firstOf(FAILED)
  if (failed) return { code: 3, label: '失败', detail: `${prefix}失败（${failed}）`, executing: false }
  const cancelled = firstOf(CANCELLED)
  if (cancelled) return { code: 4, label: '已取消', detail: `${prefix}已取消（${cancelled}）`, executing: false }
  const pending = firstOf(PENDING_REVIEW)
  if (pending) return { code: 6, label: '待审核', detail: `${prefix}待审核（${pending}）`, executing: true }

  // 没有业务状态词时按事件段推断（Issue #26 R3）：stage 只是节点 tag，不短路推断；
  // 顶层 status 只作提示，绝不据此判定「已完成」。
  if (!task && !review && !stageIsBusiness) {
    // Issue #26 R4：先按 tag 取 seq 最大的那条再判定。逐段判会把「首跑失败、
    // 重派后成功」的节点一直算成失败（重试在真实数据里很常见）。
    const latestByTag = new Map<string, SegmentInput>()
    for (const s of segments) {
      const prev = latestByTag.get(s.tag)
      if (!prev || (s.seq ?? -1) >= (prev.seq ?? -1)) latestByTag.set(s.tag, s)
    }
    const codes = [...latestByTag.values()].map((s) => s.statusCode ?? statusToNum(s.status))
    const statusHint = fields.status ? `事件状态: ${fields.status}` : ''
    if (codes.some((c) => c === 3)) return { code: 3, label: '失败', detail: `${prefix}失败（按事件推断）`, executing: false }
    if (codes.some((c) => c === 4)) return { code: 4, label: '已取消', detail: `${prefix}已取消（按事件推断）`, executing: false }
    if (codes.some((c) => c === 6)) return { code: 6, label: '待审核', detail: `${prefix}待审核（按事件推断）`, executing: true }
    if (codes.some((c) => c === 1)) {
      return { code: 1, label: '进行中', detail: `${prefix}进行中（按事件推断${statusHint ? `；${statusHint}` : ''}）`, executing: true }
    }
    if (codes.length > 0 && codes.every((c) => c === 2 || c === 5)) {
      // 有明确阶段 tag 时，「事件全部结束」只说明当前节点跑完，整体仍在推进
      if (stageTag) return { code: 1, label: '进行中', detail: `${prefix}进行中（事件均已结束）`, executing: true }
      return {
        code: 2, label: '已完成',
        detail: `事件均已结束（服务端未返回业务状态${statusHint ? `；${statusHint}` : ''}）`,
        executing: false,
      }
    }
    if (stageTag) return { code: 1, label: '进行中', detail: `${prefix}进行中`, executing: true }
    return { code: 0, label: '待开始', detail: statusHint || '待开始', executing: false }
  }

  // 有 stage / task 但都不是终态词 → 视为进行中
  return { code: 1, label: '进行中', detail: `${prefix}进行中（${task || review || stage || '未知'}）`, executing: true }
}

/**
 * 场景节点 + 事件段 → 渲染视图。
 *
 * @param sceneNodes 场景节点；null/undefined 表示场景拉取失败，退化为事件段顺序
 */
export function buildPipelineView(
  segments: SegmentInput[],
  sceneNodes: SceneNodeInput[] | null | undefined,
  fields: StatusFields,
  extras: { scene?: string; sceneUnknown?: boolean } = {},
): PipelineView {
  const overall = deriveOverall(fields, segments)
  const stage = norm(fields.issue_stage)

  // 同一 tag 多次出现：按 seq 最大那条作为节点状态，出现次数 - 1 = 重试次数
  const aggregated = new Map<string, { items: SegmentInput[] }>()
  for (const seg of segments) {
    const bucket = aggregated.get(seg.tag) ?? { items: [] }
    bucket.items.push(seg)
    aggregated.set(seg.tag, bucket)
  }
  for (const bucket of aggregated.values()) {
    bucket.items.sort((a, b) => {
      const sa = a.seq ?? -1
      const sb = b.seq ?? -1
      return sa === sb ? a.order - b.order : sa - sb
    })
  }

  const nodeFromSegment = (tag: string, outsideScene: boolean): DerivedNode => {
    const bucket = aggregated.get(tag)!
    const latest = bucket.items[bucket.items.length - 1]
    const code = (latest.statusCode ?? statusToNum(latest.status)) as GrapeStatusNum
    const node: DerivedNode = {
      tag,
      status: code,
      retries: bucket.items.length - 1,
      outsideScene,
    }
    if (latest.seq !== undefined) node.seq = latest.seq
    if (latest.duration !== undefined) node.dur = latest.duration
    if (latest.eventType) node.ev = latest.eventType
    if (latest.actor) node.actor = latest.actor
    return node
  }

  const nodes: DerivedNode[] = []
  const used = new Set<string>()

  if (sceneNodes && sceneNodes.length > 0) {
    for (const sceneNode of buildSceneChain(sceneNodes)) {
      const tag = tagOf(sceneNode)
      used.add(tag)
      if (aggregated.has(tag)) {
        nodes.push(nodeFromSegment(tag, false))
      } else {
        nodes.push({
          tag,
          status: (sceneNode.skipped ? 5 : 0) as GrapeStatusNum,
          retries: 0,
          outsideScene: false,
        })
      }
    }
    // 场景外节点：照常展示，按首次出现顺序追加
    for (const [tag] of aggregated) {
      if (used.has(tag)) continue
      nodes.push(nodeFromSegment(tag, true))
    }
  } else {
    // 场景未知：按事件段首次出现顺序
    for (const [tag] of aggregated) nodes.push(nodeFromSegment(tag, false))
  }

  const total = nodes.length
  // 进度 = 已完成格数（分母 = 渲染格数）。
  // ⚠️ 不要再把「整体待审核」写进某个节点的 status：节点的 status 是**执行状态**
  // （Grape 的 node_status / 事件状态），审核是 **issue 级业务状态**。
  // 历史实现会把当前 stage 那一格改成 6（待审核），导致：平台显示 qa 已完成、面板显示
  // qa 待审核；同时 done 在改写前算出 4、渲染时按节点数得 3，进度出现 3/5 与 4/5 打架。
  const done = Math.min(nodes.filter((n) => n.status === 2).length, total)

  // 「在等审核的是哪一格」单独作为提示透出，由 UI 以旁注形式展示，不污染节点状态。
  let reviewTag: string | undefined
  if (overall.code === 6 && nodes.length > 0) {
    const pickable = (n: DerivedNode): boolean => n.status !== 3 && n.status !== 4 && n.status !== 5
    const byTag = stage && !BUSINESS_STAGE.has(stage) ? nodes.find((n) => n.tag === stage) : undefined
    const target = byTag && pickable(byTag) ? byTag : [...nodes].reverse().find(pickable)
    if (target) reviewTag = target.tag
  }

  return {
    nodes,
    done,
    total,
    // 只有富化方明确标记「试过且失败」时才算场景未知（Issue #26 R2）。
    // 原始 pipeline 数据（如 grape_wait_task 轮询结果）从未尝试补场景，
    // 不能把「没提供」谎报成「取不到」。
    sceneUnknown: extras.sceneUnknown === true,
    overallCode: overall.code,
    overallLabel: overall.label,
    overallDetail: overall.detail,
    executing: overall.executing,
    ...(reviewTag ? { reviewTag } : {}),
    // 业务状态词不是阶段，不透出（Issue #26 R1）
    ...(fields.issue_stage && !BUSINESS_STAGE.has(norm(fields.issue_stage)) ? { stage: fields.issue_stage } : {}),
    ...(extras.scene ? { scene: extras.scene } : {}),
  }
}

/** 从任意 pipeline 数据（工具结果 / 面板代理返回）直接构造视图 */
export function derivePipelineViewFromData(data: unknown): PipelineView {
  const root = asObj(data)
  return buildPipelineView(
    extractSegments(data),
    extractSceneNodes(data),
    extractStatusFields(data),
    {
      scene: extractSceneName(data),
      // Issue #26 R2：读富化方写入的显式失败标记（顶层或 active 子对象）
      sceneUnknown: root?.scene_unknown === true || asObj(root?.active)?.scene_unknown === true,
    },
  )
}

/** 进度文案：`4/5 已完成`，保证 done ≤ total，且分母 = 渲染格数 */
export function progressText(view: Pick<PipelineView, 'done' | 'total'>): string {
  return `${view.done}/${view.total} 已完成`
}

/** 节点状态短标签（含 6=待审核） */
export function nodeStatusLabel(code: GrapeStatusNum): string {
  return statusLabelOf(code)
}