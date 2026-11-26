/**
 * Grape 焦点（focus）模块 —— host 与 client 共享。
 *
 * 现状（2026-10-23 起）：本模块**只提供类型与少量状态映射工具**，
 * 外加供 pin 卡使用的构造器（`pinToFocus` 在 client/pins-store.ts，用的是这里的类型与
 * `statusToNum` / `statusNumText` / `grapeAppUrl`）。
 *
 * ⚠️ 曾经的用途已不存在，别再照着它的历史描述去改：
 *   · host 侧工具执行后把"当前焦点"+ 渲染摘要编码成 `<!--grape-focus:{json}-->` 标记，
 *     附在 render 输出末尾；
 *   · client 侧从工具结果文本里解析出来驱动侧栏"AI 焦点卡"。
 *   该卡片按用户判断已从面板移除；而"AI 调 Grape 工具时自动切侧栏 Tab"这一行为
 *   改从**工具调用参数**读取（`StartedToolCall.argsRaw`），不再需要任何标记 ——
 *   标记机制（编码/解析/剥离）已整体删除，因为它让**模型也跟着白读一份焦点 JSON**。
 *
 * 剩下的 `pipelineFocus` / `eventFocus` / `overviewFocus` / `extractPipelineSummary` /
 * `sanitizeFocus` 目前仅供宿主 `/grape-panel-api/focus` 路由使用，**该路由客户端已不再调用**
 * （见 MULTI-PIN-AND-MENTION-DESIGN.md 的遗留项）。
 */

/**
 * 代码平台 id → 展示名。**浏览面板与实时面板共用这一份**。
 *
 * 两个面板都要显示平台（浏览面板在仓库行/issue 头，实时面板在 pin 卡），
 * 各写一份迟早会出现"同一个 gitcode 一处叫 GitCode 一处叫 gitcode"。
 * 未收录的平台保留原样（将来的 gitlab/gitee 也能显示，不必改这里）。
 */
export const PLATFORM_LABEL: Record<string, string> = {
  gitcode: 'GitCode',
  github: 'GitHub',
  gitlab: 'GitLab',
  gitee: 'Gitee',
}

/** 平台展示名（未收录保留原样；无平台 → 空串，调用方据此隐藏标签） */
export function platformLabel(p?: string | null): string {
  if (!p) return ''
  return PLATFORM_LABEL[p] ?? p
}

/** 焦点种类 */
export type GrapeFocusKind = 'pipeline' | 'event' | 'overview'

/**
 * Grape 节点状态码：0 pending / 1 running / 2 completed / 3 failed / 4 cancelled / 5 skipped
 * 另补 6 = 待审核（pending_review，服务端业务状态，不是平台 status_num 的取值）。
 */
export type GrapeStatusNum = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** 紧凑的节点摘要（够画节点链，不含日志/产物等大字段） */
export interface GrapeFocusNode {
  /** 节点 tag（vod / issue / coding / qa / sre） */
  tag: string
  /** 状态码 */
  status: GrapeStatusNum
  /** 耗时（秒），未知省略 */
  dur?: number
  /** 该节点最新事件 seq */
  seq?: number
  /** 最新事件类型，如 a2a_event / issue_opened */
  ev?: string
  /** 执行者，如 wdmike */
  actor?: string
  /** 重试次数（同一 tag 在事件段里出现多次时，链上只占一格，这里给出次数） */
  retries?: number
  /** 该节点在场景外（事件段里有、场景 nodes 里没有） */
  outsideScene?: boolean
}

/** 一次工具调用产生的"当前焦点" */
export interface GrapeFocus {
  /** 焦点种类 */
  kind: GrapeFocusKind
  /** 仓库 owner */
  owner?: string
  /** 仓库名 */
  repo?: string
  /** issue 号（pipeline 焦点） */
  number?: string
  /** 事件 seq（event 焦点） */
  seq?: number
  /** 该焦点对应的 Grape 官网页面 URL（逃生舱用） */
  url: string
  /** 产生时间戳（ms），client 用于判断新鲜度 */
  ts: number

  // ── 渲染摘要（可选，panel 画图用）──
  /** 节点链 */
  nodes?: GrapeFocusNode[]
  /** 当前阶段（tag） */
  stage?: string
  /** 是否执行中 */
  executing?: boolean
  /** 一句话摘要 */
  summary?: string
  /** 场景名 */
  scene?: string
  /** 整体状态短文案（业务字段判定，如 已完成 / 待审核 / 进行中） */
  overall?: string
  /** 整体状态码（6 = 待审核） */
  overallCode?: GrapeStatusNum
  /** 整体状态详情（如 `qa · 待审核（pending_review）`） */
  overallDetail?: string
  /**
   * 待审核发生在哪一格（节点 tag）。
   * ⚠️ 与节点 status 无关：节点 status 只表示执行状态（2=完成），
   * 审核是 issue 级业务状态，UI 用本字段做旁注，不得改写节点 status。
   */
  reviewTag?: string
  /** 场景拉取失败，节点链退化为事件段顺序 */
  sceneUnknown?: boolean
  /** 仓库概览：issue 统计 */
  stats?: { total?: number; progress?: number; failed?: number }
  /** 事件焦点：事件类型 */
  ev?: string
  /** 事件焦点：耗时（秒） */
  dur?: number
}

// ── 焦点标记机制已移除（2026-10-23）──
//
// 原设计：宿主把焦点编码成 `<!--grape-focus:{json}-->` 附在工具结果展示文本末尾，
// 客户端解析它来驱动侧栏。侧栏 AI 焦点卡删除后，唯一需要"AI 在看什么"的行为
// （自动切到侧栏 Tab）改为从**工具调用参数**读取，于是"往结果里塞 JSON"这条链路
// 整体不再需要 —— 标记的编码/解析/剥离三个函数与两个常量一并删除。
//
// 保留的：`GrapeFocus` / `GrapeFocusNode` 类型、`statusToNum` / `statusNumText` /
// `grapeAppUrl`，以及 pin 卡的构造器 `pinToFocus`（见 client/pins-store.ts）。

// ── 状态解析 ──

/** 字符串状态 → 状态码 */
export function statusToNum(status: string | undefined | null): GrapeStatusNum {
  if (!status) return 0
  const map: Record<string, GrapeStatusNum> = {
    pending: 0,
    running: 1, processing: 1, active: 1, in_progress: 1,
    // 接管中：原 worker 已被取消，Issue 由本地交互式会话推进 —— 展示上等同「进行中」
    takeover: 1, taking_over: 1,
    completed: 2, success: 2, done: 2,
    failed: 3, error: 3,
    cancelled: 4, canceled: 4,
    skipped: 5,
    pending_review: 6,
  }
  return map[status.toLowerCase()] ?? 0
}

/** 状态码 → 中文文字 */
export function statusNumText(n: GrapeStatusNum): string {
  return ({ 0: '待处理', 1: '进行中', 2: '已完成', 3: '失败', 4: '已取消', 5: '已跳过', 6: '待审核' } as const)[n]
}

// ── URL 构造 ──

/**
 * 官网深链目标。
 *
 * 为什么不再用 `(view, param)` 两个散参数：Grape 前端把**当前仓库**存在
 * `localStorage`，URL 里没有仓库上下文 —— 于是 `#pipe/8` 在「另一个仓库也有 #8」
 * 或「全新浏览器（无 currentRepo）」时会静默落到错误仓库 / 仓库列表页
 * （分析文档 §5.9.3）。目标对象把 `owner/repo` 带上，从结构上消除歧义。
 */
export interface GrapeUrlTarget {
  /** 路由视图（`app.js` 的 nav(view, param)） */
  view: 'pipe' | 'event' | 'dash' | 'observability'
  /** 仓库 owner（与 `repo` 同时存在才生效） */
  owner?: string
  /** 仓库名 */
  repo?: string
  /** 流水线目标：issue 号 */
  number?: string | number
  /** 事件目标：事件 seq */
  seq?: number
}

/** 目标里的仓库引用 `owner/repo`（缺一即空串，调用方据此决定是否提示） */
export function grapeUrlRepo(target: GrapeUrlTarget): string {
  return target.owner && target.repo ? `${target.owner}/${target.repo}` : ''
}

/**
 * Grape 官网页面 URL。
 *
 * 线上前端的真实契约（`static/js/deeplink.js` + `static/js/app.js`，2026-11-18 实测）：
 *   路径：`/app/<owner>/<repo>/`  ← **仓库在路径里**，前端据此 `_applyAppPathRepo()`
 *   哈希：`#<view>[/<param>]`
 *
 * 例：`https://beta.grapedev.cn:9443/app/developer_ch/takeover-ch/#pipe`
 *
 * 旧实现把仓库塞进 hash 的查询串（`/app/#pipe/8?repo=owner/repo`），前端根本不读
 * `?repo=` —— 于是「另一个仓库也有 #8」或「全新浏览器无 currentRepo」时会静默落到
 * 错误仓库 / 仓库列表页。改成路径式后，仓库随 URL 一起走，深链可分享、可刷新。
 *
 * 视图：`pipe`（流水线，param=issue 号）/ `event`（事件，param=seq）/
 *      `dash`（项目仪表盘）/ `observability`（运维概览，无仓库维度）。
 *
 * 注意：URL 一律用 `/` 分隔，**不要**在这里引入 `path.join` 或平台分支 —— 这是浏览器地址，
 * 不是文件系统路径。
 */
export function grapeAppUrl(baseUrl: string, target: GrapeUrlTarget): string {
  const base = normalizeGrapeBase(baseUrl)
  const repoPath = target.owner && target.repo
    ? `/app/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/`
    : '/app/'
  const id = target.view === 'event'
    ? (target.seq === undefined || target.seq === null ? '' : String(target.seq))
    : target.view === 'pipe'
      ? (target.number === undefined || target.number === null || target.number === '' ? '' : String(target.number))
      : ''
  const route = id ? `${target.view}/${encodeURIComponent(id)}` : target.view
  return `${base}${repoPath}#${route}`
}

/**
 * 归一化 baseUrl：去掉结尾斜杠；用户把 `/app` 也粘进来时一并去掉（否则会拼成 `/app/app/…`）。
 *
 * 只做字符串处理，不解析成 URL 对象 —— 站点可能有自签证书 / 端口 / 子路径，
 * 交给浏览器原样打开最稳。
 */
function normalizeGrapeBase(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/app$/i, '')
}

// ── 焦点构造便捷函数 ──

/** 流水线焦点（issue 维度） */
export function pipelineFocus(
  baseUrl: string,
  owner: string,
  repo: string,
  number: string | number,
): GrapeFocus {
  return {
    kind: 'pipeline',
    owner,
    repo,
    number: String(number),
    url: grapeAppUrl(baseUrl, { view: 'pipe', owner, repo, number }),
    ts: Date.now(),
  }
}

/** 事件焦点（`ref` 可选：调用方知道仓库时应传，深链才能定位到具体仓库） */
export function eventFocus(
  baseUrl: string,
  seq: number,
  ref?: { owner?: string; repo?: string },
): GrapeFocus {
  return {
    kind: 'event',
    seq,
    owner: ref?.owner,
    repo: ref?.repo,
    url: grapeAppUrl(baseUrl, { view: 'event', seq, owner: ref?.owner, repo: ref?.repo }),
    ts: Date.now(),
  }
}

/** 仓库概览焦点 */
export function overviewFocus(baseUrl: string, owner: string, repo: string): GrapeFocus {
  return {
    kind: 'overview',
    owner,
    repo,
    url: grapeAppUrl(baseUrl, { view: 'dash', owner, repo }),
    ts: Date.now(),
  }
}

/** 运维概览焦点（全平台，无仓库维度） */
export function opsFocus(baseUrl: string): GrapeFocus {
  return {
    kind: 'overview',
    url: grapeAppUrl(baseUrl, { view: 'observability' }),
    ts: Date.now(),
  }
}

// ── 渲染摘要抽取（host 侧，从工具结果里提炼紧凑数据）──

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

/**
 * 从 pipeline 类结果里抽取节点链摘要。
 *
 * 支持两种数据源：
 *  - `issues pipeline` 返回的 `{ segments:[{agent,status,latest_event,duration}], statuses? }`
 *  - `pipeline get` 返回的 `{ active:{ stages:[{agent,latest_event}], statuses, stage, executing } }`
 */
export function extractPipelineSummary(result: unknown): Partial<GrapeFocus> {
  const obj = asRec(result)
  if (!obj) return {}

  const active = asRec(obj.active) || obj
  const statuses = active.statuses as GrapeStatusNum[] | undefined

  const segments = active.segments as Record<string, unknown>[] | undefined
  const stages = active.stages as Record<string, unknown>[] | undefined
  const list = (segments && segments.length ? segments : stages) || []

  if (!list.length) {
    // 单个事件详情（events detail）
    const status = obj.status as string | undefined
    if (status) {
      const single: GrapeFocusNode = {
        tag: (obj.agent_type as string) || '?',
        status: statusToNum(status),
      }
      const evType = obj.event_type as string | undefined
      if (evType) single.ev = evType
      const dur = obj.duration
      if (typeof dur === 'number') single.dur = dur
      const seq0 = obj.seq
      if (typeof seq0 === 'number') single.seq = seq0
      // 注意：这里每个字段都必须"有值才写"，不能写 ev: x || undefined
      // （undefined 属性会让整个工具结果通不过 dsh 的 lossless-JSON 校验）
      return { nodes: [single] }
    }
    return {}
  }

  const nodes: GrapeFocusNode[] = list.map((seg, i) => {
    const ev = asRec(seg.latest_event)
    const statusStr = (ev?.status as string) || (seg.status as string) || undefined
    const n: GrapeFocusNode = {
      tag: ((seg.agent as string) || (seg.tag as string) || '?').toLowerCase(),
      // 优先用 statuses 数组（更权威），回退到事件状态字符串
      status: statuses?.[i] ?? statusToNum(statusStr),
    }
    const seq = (ev?.seq as number) ?? (seg.seq as number)
    if (typeof seq === 'number') n.seq = seq
    const dur = typeof seg.duration === 'number' ? (seg.duration as number)
      : typeof seg.runtime === 'number' ? (seg.runtime as number) : undefined
    if (dur !== undefined) n.dur = dur
    const evType = (ev?.event_type as string) || (seg.event_type as string)
    if (evType) n.ev = evType
    const actor = ev?.actor as string
    if (actor) n.actor = actor
    return n
  })

  const out: Partial<GrapeFocus> = { nodes }
  const stage = (active.stage as string) || undefined
  if (stage) out.stage = stage
  if (typeof active.executing === 'boolean') out.executing = active.executing as boolean
  const scene = (active.scene_name as string) || (obj.scene_name as string)
  if (scene) out.scene = scene
  const summary = (obj.summary as string) || undefined
  if (summary) out.summary = summary
  return out
}

/** 从 dashboard repo 结果里抽取统计摘要。
 *
 * ⚠️ 注意：dsh 会校验工具结果必须是 "lossless JSON"，**显式 undefined 属性会导致
 * 整个工具调用失败**（症状：`value is not lossless JSON`）。所以这里只在值存在时
 * 才写入字段，绝不能 `{ total: x ?? undefined }`。
 */
export function extractRepoSummary(result: unknown): Partial<GrapeFocus> {
  const obj = asRec(result)
  if (!obj) return {}
  const m = asRec(obj.metrics) || obj

  const stats: { total?: number; progress?: number; failed?: number } = {}
  const total = m.total_issues
  if (typeof total === 'number') stats.total = total
  const progress = m.in_progress
  if (typeof progress === 'number') stats.progress = progress
  const failed = m.failed
  if (typeof failed === 'number') stats.failed = failed

  const out: Partial<GrapeFocus> = {}
  if (Object.keys(stats).length > 0) out.stats = stats
  const role = obj.role
  if (typeof role === 'string') out.summary = role
  return out
}

// ── lossless-JSON 安全网 ──

/**
 * 递归剔除 `undefined` 属性与非有限数字，保证值能通过 dsh 的 lossless-JSON 校验。
 *
 * **为什么需要**：dsh 对工具结果做 `isJsonValue` 校验，而
 * `{ a: 1, b: undefined }` **不通过**（undefined / NaN / Infinity / function 都被拒）。
 * 一旦结果里有这类值，整个工具调用会失败——症状是
 * `value is not lossless JSON`，工具直接不可用。
 *
 * 我们踩过：`grape_get_repo_dashboard` 因 `_focus.stats` 里的显式 undefined
 * 而整体不可用（详见 SIDEBAR-AUTO-NAV-DESIGN.md 踩坑记录）。
 *
 * 这是**安全网**：即使将来某个 focus 构造器又写出显式 undefined，也不会让
 * 工具结果整体失效。
 */
export function sanitizeFocus<T>(value: T): T {
  return walkJsonSafe(value) as T
}

function walkJsonSafe(v: unknown): unknown {
  if (v === null) return null
  switch (typeof v) {
    case 'number':
      return Number.isFinite(v as number) ? v : undefined
    case 'string':
    case 'boolean':
      return v
    case 'object': {
      if (Array.isArray(v)) {
        const arr: unknown[] = []
        for (const item of v) {
          const w = walkJsonSafe(item)
          if (w !== undefined) arr.push(w)
        }
        return arr
      }
      const src = v as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(src)) {
        const w = walkJsonSafe(src[key])
        if (w !== undefined) out[key] = w
      }
      return out
    }
    default:
      // undefined / function / symbol / bigint → 剔除
      return undefined
  }
}