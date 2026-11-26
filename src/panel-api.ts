/**
 * 右栏「资源浏览」的宿主侧只读代理。
 *
 * 为什么要有它（见 RIGHT-PANEL-BROWSER-DESIGN.md §3）：
 * 浏览器里要按点击取 Grape 数据，三条路都验证过，选这条 ——
 *   A. 面板直连 https://www.grapedev.cn：CORS 实测是开的，但 **token 得进浏览器**，
 *      而本插件的 token 是 `.role('secret')`（只写不读），前端根本拿不到。
 *   B. 宿主代理（本文件）：token 只留宿主，同源免 CORS，还能缓存/去重/统一口径。
 *   C. ctx.typert 远程命名空间：最「官方」，但 contribution 是 build 期 codegen 产物，最重。
 *
 * 安全设计：
 *   · **只读白名单**：固定三条命令，路径固定映射，前端传不进任意 CLI 参数。
 *   · **spawn 用数组**（不用 shell）→ 本身没有命令注入面；但仍严格校验参数，
 *     并拒绝以 `-` 开头的值（否则会被 CLI 当成 flag，属于参数走私）。
 *   · **不写不建不改**：任何写操作仍走 AI 工具 + 写确认，本代理不含写接口。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { GrapeCliConfig } from './cli-client.js'
import { execGrape } from './cli-client.js'
import { extractPipelineSummary, pipelineFocus, sanitizeFocus } from './focus.js'
import { isValidIssueNumber, normalizeIssueNumber } from './issue-number.js'
import {
  ISSUE_SEARCH_PER_PAGE,
  isValidIssueSearchQ,
  issueSearchKeySuffix,
  normalizeIssueSearchQ,
} from './issue-search.js'
import { projectSceneNodes } from './pipeline-model.js'
import { summarizeViewer, withReposDiagnostics } from './repo-diagnostics.js'
import {
  HostFetchError,
  hostFetchAuthProfile,
  hostFetchIssuesList,
  hostFetchIssuesMine,
  hostFetchOrgsList,
  hostFetchPipeline,
  hostFetchReposManaged,
  hostFetchScenesWithPipeline,
  type HostFetchResult,
  type IssuesListQuery,
  type IssuesMineQuery,
  type PipelineQuery,
} from './host-fetch.js'
import { findMineIssue, projectScenesView, projectTaskView } from './task-view.js'
import { repoKeyFor } from './takeover-plan.js'

// ── 响应投影用的极小取值器（避免 undefined 进 JSON）──
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
const numOr = (v: unknown, d = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d

/**
 * 合法 issue 编号的白名单在 `issue-number.ts`（Issue #39）：GitCode 为纯数字、
 * Gitee 为字母数字（如 `IKXR3B`），且 `"0"` 是 Gitee 的占位值、**不是**合法编号。
 * 宿主投影、路由、pins 存档、预览选择、`@` 引用共用同一口径，本文件不再自带一份。
 */
export { isValidIssueNumber } from './issue-number.js'

/**
 * 把 `grape dashboard repo` 的返回**投影**成卡片需要的形状。
 *
 * 实测原始返回 **64KB**，主体是 `agent_engines`（每个 agent 的全量 worker 清单，
 * 上百条带 device/cred_name/scene_tags 的记录）—— 概览卡一条都用不到。
 * 投影后只留：身份（role/dev_scene/work_branch）、metrics、场景骨架（节点 tag/next/handoff）、
 * agent 摘要。响应从 64KB 压到几 KB，前端也不必再自己过滤。
 */
function projectDashboard(raw: unknown): unknown {
  const o = rec(raw)
  if (!o) return raw
  const m = rec(o.metrics)
  const adv = rec(o.advanced_options)
  return {
    repo: str(o.repo),
    role: str(o.role),
    dev_scene: str(o.dev_scene),
    work_branch: str(adv?.work_branch),
    linked_repos: arr(adv?.linked_repos),
    metrics: {
      total_issues: numOr(m?.total_issues),
      total_events: numOr(m?.total_events),
      events_week: numOr(m?.events_week),
      active_agents: numOr(m?.active_agents),
      pending_events: numOr(m?.pending_events),
      failed_events: numOr(m?.failed_events),
      auto_resolution: numOr(m?.auto_resolution),
      avg_response: numOr(m?.avg_response),
    },
    // 场景：只留骨架（完整定义含 skill 与 engine_runtime_ids，卡片用不到）
    scenes: arr(o._scenes).map((s) => {
      const so = rec(s) ?? {}
      return {
        id: str(so.id),
        name: str(so.display_name) || str(so.name),
        description: str(so.description),
        work_branch: str(so.work_branch),
        created_by: str(so.created_by),
        nodes: arr(so.nodes).map((n) => {
          const no = rec(n) ?? {}
          return {
            tag: str(no.tag) || str(no.id),
            next: str(no.next),
            handoff: str(no.handoff),
            enabled: no.enabled !== false,
          }
        }),
      }
    }),
    agents: arr(o.agents).map((a) => {
      const ao = rec(a) ?? {}
      return {
        agent_type: str(ao.agent_type),
        backend: str(ao.backend),
        status: str(ao.status),
        skill_display_name: str(ao.skill_display_name),
        enabled_in_scene: ao.enabled_in_scene === true,
      }
    }),
  }
}

/**
 * 投影 issue 列表到**面板真正渲染的字段**。
 *
 * 为什么必须做：`grape-dev/grape` 有 512 个 issue，原始响应 **565 KB**，其中：
 *   · `qa_history` 132 KB（26.5%）—— 面板根本不渲染
 *   · `conversation_id` / `scene_id` / `repo_key` / `created_at` / `completed_at` …
 *     约 60 KB —— 面板也不用
 *   · 25 个字段的**字段名本身**就占约 190 KB（512 个对象 × 每对象重复一遍键名）
 * 全量发给浏览器 = 白传 + 白解析（浏览器还要在 512 个完整对象上跑三遍筛选取值域统计）。
 *
 * 只保留「浏览」面板 issue 行用到的字段，并且顺手把 `latest_event` 里的 `title`
 * 也去掉（面板只显示 seq / status / created_at）。
 * 这与 `dashboard` 的投影是同一条原则：大响应在**宿主侧**收窄，浏览器只拿它要画的。
 */
function projectIssues(raw: unknown): unknown {
  const o = rec(raw)
  if (!o) return raw
  const issues = arr(o.issues)
  return {
    // Issue #41 复审 Optional：`q` 搜索响应的 `total` 为 null，不能再经 numOr 投影成 0
    // （否则消费者会误判「0 条」）；与 has_more 一样保留 number/null 原值。
    total: typeof o.total === 'number' && Number.isFinite(o.total) ? o.total : null,
    // Issue #41：`q` 搜索响应的 `total` 为 null，翻页/「还有更多」只能依据 has_more；
    // 保留原值（不伪造 false），普通列表缺失时输出 null，前端按 `=== true` 读取。
    has_more: typeof o.has_more === 'boolean' ? o.has_more : null,
    issues: issues.map((it) => {
      const io = rec(it) ?? {}
      const le = rec(io.latest_event)
      return {
        // issue_number 与 number 在原始数据里是同一值；归一为**字符串**（Issue #39）：
        // GitCode 整数与 Gitee 字母数字都能承载，缺失时输出空串（不再伪造 0）。
        issue_number: normalizeIssueNumber(io.issue_number) || normalizeIssueNumber(io.number),
        title: str(io.title),
        status: str(io.status),
        stage: str(io.stage),
        scene_name: str(io.scene_name),
        assignee: str(io.assignee),
        events_count: numOr(io.events_count),
        is_running: io.is_running === true,
        latest_event: le
          ? { seq: numOr(le.seq), status: str(le.status), created_at: str(le.created_at) }
          : null,
      }
    }),
  }
}

/** 代理前缀（dsh 命名路由：需与已有路由不同；现有为 /api/file、/api/v0/*、/auth-api/*、/oauth/callback） */
export const PANEL_API_PREFIX = '/grape-panel-api'

/**
 * 结果缓存 TTL（毫秒）。
 *
 * Issue #27：面板数据（托管仓库 / issue 列表 / 流水线）变动频率低，30s 会让
 * 「返回再点进去」「刷新后切回」反复触发 CLI 冷启动；提到 5min 后热载基本零开销。
 * 可用环境变量 `GRAPE_PANEL_CACHE_TTL_MS` 覆盖（见 `resolveCacheTtl`）。
 */
export const CACHE_TTL_MS = 300_000

/**
 * 场景信息缓存 TTL（毫秒，Issue #26）。
 *
 * 场景节点由 `scenes detail` 提供，变动远低于 issue 列表；换场景时 `scene_id`
 * 变化会让缓存键自然失效，所以这里给到 5 分钟。与成功缓存默认 TTL 解耦，
 * 是为了在 `GRAPE_PANEL_CACHE_TTL_MS` 被调低时，场景骨架仍不至于每 30s 重 spawn 一次。
 */
export const SCENE_TTL_MS = 300_000

/**
 * 失败结果短缓存（毫秒）。
 *
 * 失败不长期缓存（否则故障恢复后还要等 5min），但也不能完全不留 ——
 * 用户连点会连续 spawn CLI。8s 足够吃掉连点风暴，又能快速自愈。
 */
export const FAILURE_TTL_MS = 8_000

/**
 * 需求卡任务视图的缓存 TTL（毫秒，Issue #42）。
 *
 * 卡片 4 个按钮都依赖 `task`（内部 id / 状态 / 场景 / 描述），但它是**懒加载**
 * （展开或点操作才取），不进 20s 轮询。45s 足够吃掉「展开 → 点按钮 → 弹层」内的重复取数，
 * 又能在状态翻转（如刚确认完成）后很快自愈；`force=1` 可精确刷新单条。
 */
export const TASK_TTL_MS = 45_000

/**
 * `/task` 取 mine 行的每页条数（Issue #42 复审 R1）。
 *
 * mine 端点缺省只回 20 行：目标 issue 一旦不在第一页，`conversation_id` / `is_running`
 * 就取不到。HTTP 端点稳定支持 `per_page`（上限 100），CLI 侧不传该参数（部分版本会
 * Usage 报错），因此这里只在宿主快路径使用。
 */
export const TASK_MINE_PER_PAGE = 100

/**
 * 缓存条数上限（Issue #27 R6）。
 *
 * TTL 从 30s 提到 5min 后，只靠惰性过期会让 /issues 的不同过滤组合长期占内存；
 * 超过上限按插入顺序淘汰最老一条（简单 FIFO，语义足够）。
 */
export const CACHE_MAX_ENTRIES = 200

/** 取数来源：宿主快路径 / CLI 回退（响应里标注，便于排障与回归对比） */
export type PanelSource = 'host' | 'cli'

/** 单次取数的 timing（/repos 响应携带，宿主同时打一行日志） */
export interface PanelTiming {
  /** 宿主快路径耗时；回退 CLI 时为 null */
  hostMs: number | null
  cache: 'hit' | 'miss'
  source: PanelSource
  totalMs: number
}

/** 宿主快路径适配器（默认接 `host-fetch.ts`；单测可注入） */
export interface HostFetchAdapter {
  reposManaged(cfg: GrapeCliConfig): Promise<HostFetchResult>
  issuesList(cfg: GrapeCliConfig, q: IssuesListQuery): Promise<HostFetchResult>
  pipeline(cfg: GrapeCliConfig, q: PipelineQuery): Promise<HostFetchResult>
  /** 空账号诊断（可选：缺省时这两条仍走 CLI） */
  authProfile?(cfg: GrapeCliConfig): Promise<HostFetchResult>
  orgsList?(cfg: GrapeCliConfig): Promise<HostFetchResult>
  /** 场景列表（可选：user_only；缺省 / 403 时 `/scenes` 降级当前场景，Issue #42） */
  scenesWithPipeline?(cfg: GrapeCliConfig, q: { owner: string; repo: string }): Promise<HostFetchResult>
  /**
   * mine 列表（可选；Issue #42 复审 R1）。
   * 缺省 / 失败 → `/task` 回退 `issues mine` CLI（不带 `--per_page`）。 */
  issuesMine?(cfg: GrapeCliConfig, q: IssuesMineQuery): Promise<HostFetchResult>
}

/** handler 依赖注入（全部可缺省；生产走真实实现） */
export interface PanelApiDeps {
  /** CLI 执行（默认 `execGrape`） */
  exec?: (cfg: GrapeCliConfig, args: string[]) => Promise<unknown>
  /** 时钟（单测控制 TTL） */
  now?: () => number
  /** 成功缓存 TTL 覆盖（默认 env / `CACHE_TTL_MS`） */
  cacheTtlMs?: number
  /** 失败缓存 TTL 覆盖（默认 `FAILURE_TTL_MS`） */
  failureTtlMs?: number
  /** 一行日志输出（默认 console.log；不落 token） */
  log?: (line: string) => void
  /** 宿主快路径适配器（默认真实 Node fetch） */
  hostFetch?: HostFetchAdapter
}

const defaultHostFetch: HostFetchAdapter = {
  reposManaged: (cfg) => hostFetchReposManaged(cfg),
  issuesList: (cfg, q) => hostFetchIssuesList(cfg, q),
  pipeline: (cfg, q) => hostFetchPipeline(cfg, q),
  authProfile: (cfg) => hostFetchAuthProfile(cfg),
  orgsList: (cfg) => hostFetchOrgsList(cfg),
  scenesWithPipeline: (cfg, q) => hostFetchScenesWithPipeline(cfg, q),
  issuesMine: (cfg, q) => hostFetchIssuesMine(cfg, q),
}

/** 成功缓存 TTL：显式注入 > 环境变量 > 默认常量 */
function resolveCacheTtl(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit
  const env = Number.parseInt(process.env.GRAPE_PANEL_CACHE_TTL_MS || '', 10)
  return Number.isFinite(env) && env > 0 ? env : CACHE_TTL_MS
}

/** 参数校验：owner/repo 允许 GitCode 常见字符集；禁止以 `-` 开头 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
/** issue number：数字（GitCode）与字母数字（Gitee）统一走 `ISSUE_NUMBER_RE`（Issue #39） */
/**
 * 过滤类参数（status/scene/assignee/sort_order/mode）：字母数字下划线连字符，禁止以 `-` 开头。
 *
 * 上限 64：scene_id 可能是 UUID（36 位，如 `42151cf7-51da-4098-ba24-c9c3765f57ac`），
 * 旧的 32 位上限会让 `/scenes?scene_id=<UUID>` 直接 400「参数 scene_id 不合法」，
 * 复制需求因此取不到场景下拉、还会把错误显示两次。
 */
const FILTER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

interface CacheEntry {
  at: number
  ok: boolean
  value?: unknown
  source: PanelSource
  hostMs: number | null
  message?: string
  code?: string
}

interface CallResult {
  value: unknown
  source: PanelSource
  hostMs: number | null
  cache: 'hit' | 'miss'
  totalMs: number
}

/** 失败缓存的回放错误（避免连点重复 spawn CLI） */
class CachedCallError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'CachedCallError'
    this.code = code
  }
}

/**
 * 创建面板代理的 HTTP handler。
 *
 * @param getConfig - 每次请求时取 CLI 配置（`.volatile()` 热改即时生效）
 * @param deps - 依赖注入（默认接真实 CLI / Node fetch；单测注入桩）
 * @returns node:http handler
 */
export function createPanelApiHandler(getConfig: () => GrapeCliConfig, deps: PanelApiDeps = {}) {
  const now = deps.now ?? (() => Date.now())
  const exec = deps.exec ?? execGrape
  const hostFetch = deps.hostFetch ?? defaultHostFetch
  const log = deps.log ?? ((line: string) => console.log(line))
  const cacheTtlMs = resolveCacheTtl(deps.cacheTtlMs)
  const failureTtlMs = deps.failureTtlMs ?? FAILURE_TTL_MS

  /** 结果缓存（成功 5min / 失败 8s，同一 key 直接命中，避免连点触发冷启动风暴） */
  const cache = new Map<string, CacheEntry>()
  /** 在途请求去重（同一 key 并发只发起一次 host/CLI 调用） */
  const inflight = new Map<string, Promise<CallResult>>()

  /** 写缓存并维持条数上限（Issue #27 R6：FIFO 淘汰，避免 5min TTL 下无限增长） */
  const putCache = (key: string, entry: CacheEntry): void => {
    cache.set(key, entry)
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
  }

  /**
   * 缓存作用域：`baseUrl + token 指纹`（Issue #27 C2）。
   *
   * 缓存键原先只有路由与参数，而 `getConfig()` 是 `.volatile()` —— 换账号或换环境后
   * 同名键仍会命中，5 分钟内继续把**上一账号**的仓库/issue 返回给前端，
   * 还会被浏览面板写进新环境的 localStorage 快照。这里给所有键加配置身份前缀：
   * token 不落明文，只取 SHA-256 前 12 位用于区分。
   */
  const cacheScope = (): string => {
    try {
      const cfg = getConfig()
      const base = String(cfg.baseUrl ?? '').trim().replace(/\/+$/, '')
      const token = String(cfg.token ?? '')
      if (!base && !token) return ''
      return `${base}|${token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : ''}`
    } catch {
      return ''
    }
  }

  /**
   * 缓存层先行：force → 命中（成功 TTL / 失败短缓存）→ in-flight → 宿主快路径 → CLI 回退。
   *
   * @param key - 缓存键（含全部参数）
   * @param hooks.cliArgs - 回退时的 CLI 参数
   * @param hooks.host - 宿主快路径（缺省则只走 CLI）
   * @param hooks.force - 只失效该 key 的缓存（精确刷新），不影响其他路由
   * @param hooks.ttlMs - 覆盖该 key 的成功缓存 TTL（Issue #26：场景/详情用 60s、场景骨架用 5min）
   */
  const run = async (
    key: string,
    hooks: {
      cliArgs: string[]
      host?: () => Promise<HostFetchResult>
      /**
       * 自定义取数（Issue #42 `/task`）：需要「多条 CLI 串起来再投影」的路由无法用
       * 单条 `cliArgs` 表达，这里给一个同步入缓存前的 loader；缺省行为不变。
       */
      load?: () => Promise<unknown>
      force?: boolean
      ttlMs?: number
      /** 入缓存前投影（Issue #27 R6：/issues 原始响应单条 565KB，投影后只有几 KB） */
      project?: (value: unknown) => unknown
    },
  ): Promise<CallResult> => {
    // 缓存键带配置身份（Issue #27 C2）：换账号/换环境后旧键不再命中
    const scope = cacheScope()
    if (scope) key = `${scope}::${key}`

    if (hooks.force) cache.delete(key)

    const hit = cache.get(key)
    if (hit) {
      const ttl = hit.ok ? (hooks.ttlMs ?? cacheTtlMs) : failureTtlMs
      if (now() - hit.at < ttl) {
        if (!hit.ok) throw new CachedCallError(hit.message || '取数失败', hit.code)
        return { value: hit.value, source: hit.source, hostMs: hit.hostMs, cache: 'hit', totalMs: 0 }
      }
      cache.delete(key)   // 过期：允许重取
    }

    const running = inflight.get(key)
    if (running) {
      if (!hooks.force) return running
      // force（精确刷新）不能复用旧请求：否则「刷新」拿到的仍是那次在途的结果，
      // 而且它随后写进缓存、TTL 从旧结果完成时开始算（Issue #27 R5）。
      await running.catch(() => {})
      return run(key, { ...hooks, force: true })
    }

    const task = (async (): Promise<CallResult> => {
      const started = now()
      let value: unknown
      let source: PanelSource = 'cli'
      let hostMs: number | null = null

      try {
        if (hooks.load) {
          // 自定义 loader（/task）：内部自己完成多次 CLI 调用与投影，来源记为 cli
          value = await hooks.load()
          source = 'cli'
        } else if (hooks.host) {
          try {
            const out = await hooks.host()
            value = out.data
            hostMs = out.hostMs
            source = 'host'
          } catch (hostErr) {
            // 快路径任何失败都回退 CLI：面板行为与现状一致，只标注来源
            const reason = hostErr instanceof HostFetchError
              ? hostErr.code
              : hostErr instanceof Error ? hostErr.message : String(hostErr)
            log(`[grape-dsh] panel ${key} host-fetch fallback (${reason})`)
            value = await exec(getConfig(), hooks.cliArgs)
            source = 'cli'
            hostMs = null
          }
        } else {
          value = await exec(getConfig(), hooks.cliArgs)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const code = (err as { code?: string })?.code
        // 失败也进短缓存：连点不会连续 spawn CLI；到期后自动重试
        putCache(key, { at: now(), ok: false, source: 'cli', hostMs: null, message, code })
        throw err
      }

      const projected = hooks.project ? hooks.project(value) : value
      putCache(key, { at: now(), ok: true, value: projected, source, hostMs })
      return { value: projected, source, hostMs, cache: 'miss', totalMs: now() - started }
    })().finally(() => { inflight.delete(key) })

    inflight.set(key, task)
    return task
  }

  /** 只走 CLI 的调用（dashboard / events / focus 等非快路径接口） */
  const callCli = (
    key: string,
    args: string[],
    opts: { force?: boolean } = {},
  ): Promise<CallResult> => run(key, { cliArgs: args, force: opts.force })

  const timingOf = (r: CallResult): PanelTiming => ({
    hostMs: r.hostMs,
    cache: r.cache,
    source: r.source,
    totalMs: r.totalMs,
  })

  /**
   * 给 pipeline 数据补场景上下文（Issue #26）。
   *
   * `issues pipeline` 不带 `scene_id`，而客户端要按场景节点画骨架，所以这里：
   *   1. 取 `issues detail` 的 `scene_id`（60s 缓存；换场景后 scene_id 变化即失效）；
   *   2. 取 `scenes detail --scene_id <id> --repo <owner>/<repo>` 的 `nodes`（5 分钟缓存）；
   *   3. 把 `scene_id / scene_name / scene_nodes / node_count` 附到原数据上。
   *
   * 任何一步失败都**不报错**：只少附带字段，客户端据此显示「场景未知，按事件推断」，
   * 不允许退回写死 5 节点。两条补全命令都走 `run`，因此失败会进 8s 短缓存
   * （Issue #27 的失败短缓存），坏场景不会每次刷新都重新 spawn 一次 CLI。
   */
  const attachScene = async (owner: string, repo: string, number: string, raw: unknown): Promise<unknown> => {
    const o = rec(raw)
    if (!o) return raw
    let sceneId = str(o.scene_id)
    let sceneName = str(o.scene_name)
    if (!sceneId) {
      const detail = await run(`issue-detail:${owner}/${repo}#${number}`, {
        cliArgs: ['issues', 'detail', '--owner', owner, '--repo', repo, '--number', number, '--json-out'],
        ttlMs: 60_000,
      }).then((r) => r.value).catch(() => null)
      const d = rec(detail)
      sceneId = str(d?.scene_id)
      sceneName = str(d?.scene_name)
      // Issue #26 C1：走 repo 默认场景的 issue，`issues detail` 返回 scene_id="" 且
      // 不带 scene_source/scene_name（实测 developer_ch/takeover-ch#4）。这类 issue
      // 在场景库里对应 id='default' 的默认场景；直接放弃等于它们永远没有节点链、
      // 永远显示「场景未知」。该 repo 没有默认场景时 scenes detail 会快速失败，
      // 下面的 catch 照旧退化成「场景未知」，不会阻塞也不会假装有节点。
      if (!sceneId) sceneId = 'default'
    }
    if (!sceneId) return o

    const scene = await run(`scene:${owner}/${repo}#${sceneId}`, {
      cliArgs: ['scenes', 'detail', '--scene_id', sceneId, '--repo', `${owner}/${repo}`, '--json-out'],
      ttlMs: SCENE_TTL_MS,
    }).then((r) => r.value).catch(() => null)
    const so = rec(scene)
    // 场景取不到时至少把 scene_name 一起带出去，避免前端 header 显示 UUID 当场景名；
    // 同时写 scene_unknown（Issue #26 R2：客户端只在「试过且失败」时才提示场景未知）
    if (!so) {
      return { ...o, scene_id: sceneId, scene_unknown: true, ...(sceneName ? { scene_name: sceneName } : {}) }
    }

    const nodes = projectSceneNodes(so)
    return {
      ...o,
      scene_id: sceneId,
      scene_name: str(so.display_name) || str(so.name) || sceneName,
      scene_nodes: nodes,
      node_count: nodes.length,
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    /** 当前 baseUrl：面板要靠它拼 Grape 官网逃生舱链接 */
    const currentBase = (): string => {
      try { return getConfig().baseUrl } catch { return '' }
    }
    const send = (status: number, body: unknown): void => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(text)
    }
    /** 成功响应统一带上 baseUrl（前端据此构造官网链接）与可选 timing */
    const sendOk = (data: unknown, timing?: PanelTiming): void => {
      send(200, timing
        ? { ok: true, data, baseUrl: currentBase(), timing }
        : { ok: true, data, baseUrl: currentBase() })
    }
    /** 宿主日志打一行：来源 / 缓存命中 / 宿主耗时（不含 token） */
    const logTiming = (route: string, r: CallResult): void => {
      log(`[grape-dsh] panel ${route} source=${r.source} cache=${r.cache} hostMs=${r.hostMs ?? '-'} totalMs=${r.totalMs}`)
    }

    let url: URL
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      send(400, { ok: false, code: 'bad-url', message: '无法解析请求 URL' })
      return
    }

    if (req.method !== 'GET') {
      send(405, { ok: false, code: 'method-not-allowed', message: '只支持 GET（只读代理）' })
      return
    }

    const route = url.pathname.startsWith(PANEL_API_PREFIX)
      ? url.pathname.slice(PANEL_API_PREFIX.length) || '/'
      : url.pathname
    const params = url.searchParams
    const force = params.get('force') === '1'

    // 取参 + 校验。任何不合法直接 400，不把可疑值交给 CLI。
    const seg = (name: string): string | null => {
      const v = params.get(name)
      if (v == null || v === '') return null
      return SEGMENT_RE.test(v) ? v : 'INVALID'
    }
    const issueNumberParam = (name: string): string | null => {
      const v = params.get(name)
      if (v == null || v === '') return null
      return isValidIssueNumber(v) ? v : 'INVALID'
    }
    const filter = (name: string): string | null => {
      const v = params.get(name)
      if (v == null || v === '') return null
      return FILTER_RE.test(v) ? v : 'INVALID'
    }
    const bad = (name: string): { ok: false; code: string; message: string } => ({
      ok: false, code: 'invalid-param', message: `参数 ${name} 不合法`,
    })

    try {
      // ── GET /repos ──
      //
      // 空态诊断（Issue #6）：原始 CLI 只返回 `{ repos: [...] }`，没有 `total` / `org_id`。
      // 这里在插件侧追加 `diagnostics`（白名单字段），客户端空态直接复用；
      // 非空列表仍只读 `repos`，渲染与行为不变。
      if (route === '/repos') {
        const r = await run('repos', {
          cliArgs: ['repos', 'managed', '--json-out'],
          host: () => hostFetch.reposManaged(getConfig()),
          force,
        })
        const data = r.value
        // O10：仅空列表时补取「当前账号 / 组织角色」，非空列表保持零额外开销。
        const recData = rec(data)
        const list = Array.isArray(data)
          ? data
          : Array.isArray(recData?.repos) ? (recData?.repos as unknown[]) : []
        // Issue #27：两条诊断命令改并行（原先串行 await 是空账号首次 ~2s 的主因之一）；
        // 且优先复用宿主快路径（无 token/403 时 run() 内部自动回退 CLI，行为不变）。
        const loadProfile = (): Promise<unknown> =>
          (hostFetch.authProfile
            ? run('auth:profile', {
                cliArgs: ['auth', 'profile', '--json-out'],
                host: () => hostFetch.authProfile!(getConfig()),
                force,
              })
            : callCli('auth:profile', ['auth', 'profile', '--json-out'], { force }))
            .then((x) => x.value).catch(() => null)
        const loadOrgs = (): Promise<unknown> =>
          (hostFetch.orgsList
            ? run('orgs:list', {
                cliArgs: ['orgs', 'list', '--json-out'],
                host: () => hostFetch.orgsList!(getConfig()),
                force,
              })
            : callCli('orgs:list', ['orgs', 'list', '--json-out'], { force }))
            .then((x) => x.value).catch(() => null)
        const viewer = list.length === 0
          ? await (async () => {
              const [profile, orgs] = await Promise.all([loadProfile(), loadOrgs()])
              return summarizeViewer(profile, orgs)
            })()
          : null
        logTiming('/repos', r)
        sendOk(withReposDiagnostics(data, { params: force ? { force: '1' } : {}, viewer }), timingOf(r))
        return
      }

      // ── GET /issues?owner=&repo=&status=&scene=&assignee= ──
      if (route === '/issues') {
        const owner = seg('owner'); const repo = seg('repo')
        if (!owner || !repo) { send(400, { ok: false, code: 'missing-param', message: '需要 owner 与 repo' }); return }
        if (owner === 'INVALID') { send(400, bad('owner')); return }
        if (repo === 'INVALID') { send(400, bad('repo')); return }
        const status = filter('status'); const sortOrder = filter('sort_order')
        const mode = filter('mode'); const assignees = filter('assignees')
        for (const [n, v] of [['status', status], ['sort_order', sortOrder], ['mode', mode], ['assignees', assignees]] as const) {
          if (v === 'INVALID') { send(400, bad(n)); return }
        }

        // ── 服务端搜索（Issue #41）──
        // 查询词归一后校验：去首尾空白、≤64、拒绝控制字符与 `-` 开头（后者会被 CLI 当 flag）。
        // 归一/校验口径与前端 browse-store 共用 `issue-search.ts`，避免两边漂移。
        const q = normalizeIssueSearchQ(params.get('q'))
        if (!isValidIssueSearchQ(q)) { send(400, bad('q')); return }
        // page 只服务搜索翻页：普通列表不传，首页行为不变（cache 键也不含 page）
        let page = 1
        const pageRaw = params.get('page')
        if (pageRaw != null && pageRaw !== '') {
          if (!/^\d{1,4}$/.test(pageRaw) || Number(pageRaw) < 1 || Number(pageRaw) > 1000) {
            send(400, bad('page')); return
          }
          page = Number(pageRaw)
        }

        const args = ['issues', 'list', '--owner', owner, '--repo', repo]
        if (status) args.push('--status', status)
        if (sortOrder) args.push('--sort_order', sortOrder)
        if (mode) args.push('--mode', mode)
        if (assignees) args.push('--assignees', assignees)
        if (q) {
          args.push('--q', q, '--per_page', String(ISSUE_SEARCH_PER_PAGE))
          if (page > 1) args.push('--page', String(page))
        }
        args.push('--json-out')

        const r = await run(
          `issues:${owner}/${repo}:${status || ''}:${sortOrder || ''}:${mode || ''}:${assignees || ''}${issueSearchKeySuffix(q, page)}`,
          {
            cliArgs: args,
            host: () => hostFetch.issuesList(getConfig(), {
              owner: owner as string,
              repo: repo as string,
              status: status ?? undefined,
              sort_order: sortOrder ?? undefined,
              mode: mode ?? undefined,
              assignees: assignees ?? undefined,
              // 搜索才带 q/per_page/page：默认列表的 URL 与缓存键保持原样
              q: q || undefined,
              per_page: q ? ISSUE_SEARCH_PER_PAGE : undefined,
              page: q && page > 1 ? page : undefined,
            }),
            force,
            // 投影后再入缓存：512 个 issue 的原始响应 565 KB → 只留面板渲染用得到的字段
            project: projectIssues,
          },
        )
        logTiming('/issues', r)
        sendOk(r.value, timingOf(r))
        return
      }

      // ── GET /pipeline?owner=&repo=&number= ──
      if (route === '/pipeline') {
        const owner = seg('owner'); const repo = seg('repo'); const number = issueNumberParam('number')
        if (!owner || !repo || !number) { send(400, { ok: false, code: 'missing-param', message: '需要 owner、repo、number' }); return }
        if (owner === 'INVALID') { send(400, bad('owner')); return }
        if (repo === 'INVALID') { send(400, bad('repo')); return }
        if (number === 'INVALID') { send(400, bad('number')); return }

        const r = await run(`pipeline:${owner}/${repo}#${number}`, {
          cliArgs: ['issues', 'pipeline', '--owner', owner, '--repo', repo, '--number', number, '--json-out'],
          host: () => hostFetch.pipeline(getConfig(), { owner: owner as string, repo: repo as string, number }),
          force,
        })
        // Issue #26：补场景上下文（场景节点链），失败只少字段不报错
        const enriched = await attachScene(owner, repo, number, r.value)
        logTiming('/pipeline', r)
        sendOk(enriched, timingOf(r))
        return
      }

      // ── GET /dashboard?owner=&repo= ──
      if (route === '/dashboard') {
        const owner = seg('owner'); const repo = seg('repo')
        if (!owner || !repo) { send(400, { ok: false, code: 'missing-param', message: '需要 owner 与 repo' }); return }
        if (owner === 'INVALID') { send(400, bad('owner')); return }
        if (repo === 'INVALID') { send(400, bad('repo')); return }

        const r = await callCli(`dashboard:${owner}/${repo}`,
          ['dashboard', 'repo', '--owner', owner, '--repo', repo, '--json-out'], { force })
        sendOk(projectDashboard(r.value))
        return
      }

      // ── GET /focus?owner=&repo=&number= ──
      //
      // 「跟随此 issue」用：把浏览到的 issue 变成**实时面板能直接渲染的焦点**。
      //
      // 关键：复用宿主自己的 `pipelineFocus` + `extractPipelineSummary` ——
      // 这样"跟随"得到的焦点与 AI 调工具产生的焦点**同形**（同样的 nodes/stage/url 口径），
      // 实时面板不会出现两套渲染表现。若在前端另拼一份焦点对象，两边迟早会漂移。
      if (route === '/focus') {
        const owner = seg('owner'); const repo = seg('repo'); const number = issueNumberParam('number')
        if (!owner || !repo || !number) { send(400, { ok: false, code: 'missing-param', message: '需要 owner、repo、number' }); return }
        if (owner === 'INVALID') { send(400, bad('owner')); return }
        if (repo === 'INVALID') { send(400, bad('repo')); return }
        if (number === 'INVALID') { send(400, bad('number')); return }

        // 与 /pipeline 共用缓存键：宿主快路径同样可用，pins 轮询刚取过的数据在这里直接命中
        const r = await run(`pipeline:${owner}/${repo}#${number}`, {
          cliArgs: ['issues', 'pipeline', '--owner', owner, '--repo', repo, '--number', number, '--json-out'],
          host: () => hostFetch.pipeline(getConfig(), { owner: owner as string, repo: repo as string, number }),
          force,
        })
        // 摘要在前、身份字段在后：kind/owner/repo/number/url/ts 必须由我们说了算
        const enriched = await attachScene(owner, repo, number, r.value)
        const focus = sanitizeFocus({ ...extractPipelineSummary(enriched), ...pipelineFocus(currentBase(), owner, repo, number) })
        sendOk(focus)
        return
      }

      // ── GET /events?owner=&repo=&number= ──
      //
      // issue 的**事件明细**（`issues events`，seq 升序）。
      // 实测返回 `{events, segments, total}`，其中 `segments` 与 `events` **完全相同**
      // （只是别名），前端统一读 `events`。
      // 与 `issues pipeline` 的关系：pipeline 给的是**阶段节点**（如 5 个），
      // events 给的是**每个事件**（如 17 条）—— 节点链是骨架，事件列表是全过程。
      if (route === '/events') {
        const owner = seg('owner'); const repo = seg('repo'); const number = issueNumberParam('number')
        if (!owner || !repo || !number) { send(400, { ok: false, code: 'missing-param', message: '需要 owner、repo、number' }); return }
        if (owner === 'INVALID') { send(400, bad('owner')); return }
        if (repo === 'INVALID') { send(400, bad('repo')); return }
        if (number === 'INVALID') { send(400, bad('number')); return }

        const r = await callCli(`events:${owner}/${repo}#${number}`,
          ['issues', 'events', '--owner', owner, '--repo', repo, '--number', number, '--json-out'], { force })
        sendOk(r.value)
        return
      }

      // ── GET /task?owner=&repo=&number=[&platform=] ──
      //
      // 需求卡 4 个按钮（进入对话 / 复制需求 / 确认完成 / 移交流水线）的数据来源（Issue #42）。
      // 懒加载：卡片展开或点操作才取，**不进 20s pin 轮询**；45s 缓存 + force 精确刷新。
      //
      // 取数顺序（Spec §5.1）：
      //   ① `issues mine --repo_key`（主：带内部 id / 状态 / 场景 / 描述，且按平台消歧）；
      //   ② 未命中 / 缺 id / 缺描述 → `issues detail`（issue_id + 首个 issue_opened 的 seq）；
      //   ③ 描述仍为空 → `events detail --seq` → `payload.object_attributes.description`。
      // 三条都失败也不抛给前端：投影后前端只禁用按钮 / 只展示标题。
      if (route === '/task') {
        const owner = seg('owner'); const repo = seg('repo'); const number = issueNumberParam('number')
        if (!owner || !repo || !number) { send(400, { ok: false, code: 'missing-param', message: '需要 owner、repo、number' }); return }
        if (owner === 'INVALID') { send(400, bad('owner')); return }
        if (repo === 'INVALID') { send(400, bad('repo')); return }
        if (number === 'INVALID') { send(400, bad('number')); return }
        const platform = filter('platform')
        if (platform === 'INVALID') { send(400, bad('platform')); return }
        const repoKey = repoKeyFor(platform, `${owner}/${repo}`)

        const r = await run(`task:${owner}/${repo}#${number}:${platform || ''}`, {
          // cliArgs 仅作回退声明（真正取数在 load 里）；`issues mine` **不带 `--per_page`** ——
          // 该参数在部分 CLI 版本上不被接受（Usage 报错 exit 1），见 load 内的取数顺序。
          cliArgs: ['issues', 'mine', '--repo_key', repoKey, '--json-out'],
          force,
          ttlMs: TASK_TTL_MS,
          load: async () => {
            const cfg = getConfig()
            // mine 行取数顺序（Issue #42 复审 R1）：
            //   ① 宿主 HTTP `GET /api/issues/mine?repo_key=…&per_page=100`（主：per_page 由端点
            //      稳定支持，宿主 token 直连，无解释器启动）；
            //   ② 快路径不可用 / 失败 → CLI `issues mine --repo_key`（**不传 --per_page**，
            //      兼容不接受该参数的 CLI 版本）。
            //   回退路径最多默认 20 行：目标行不在其中时 ③ 由 detail 兜底，此时
            //   `conversation_id` / `is_running` 缺失（前端只禁用「进入对话」相关按钮），
            //   `id / status / scene_id / 描述` 仍然齐全。
            const host = hostFetch.issuesMine
            const mine = await (async (): Promise<unknown> => {
              if (host) {
                try {
                  return (await host(cfg, { repo_key: repoKey, per_page: TASK_MINE_PER_PAGE })).data
                } catch (err) {
                  // 快路径失败（无 token / 403 / 结构不符）→ CLI 回退，行为与旧版一致
                  const reason = err instanceof HostFetchError ? err.code : 'error'
                  log(`[grape-dsh] panel task mine host-fetch fallback (${reason})`)
                }
              }
              return exec(cfg, ['issues', 'mine', '--repo_key', repoKey, '--json-out']).catch(() => null)
            })()
            const row = rec(findMineIssue(mine, { repoKey, number }))
            const rowId = numOr(row?.id)
            const rowDesc = str(row?.task_description).trim()
            const needDetail = !row || !rowDesc || rowId <= 0

            const detail = needDetail
              ? await exec(cfg, ['issues', 'detail', '--owner', owner, '--repo', repo, '--number', number, '--json-out'])
                .catch(() => null)
              : null

            let firstEvent: unknown = null
            if (!rowDesc) {
              const opened = arr(rec(detail)?.events)
                .map((e) => rec(e))
                .find((e) => e && (str(e.event_type) === 'issue_opened' || str(e.event_type) === 'issue_created'))
              const seq = numOr(opened?.seq)
              if (seq > 0) {
                firstEvent = await exec(cfg, ['events', 'detail', '--seq', String(seq), '--json-out']).catch(() => null)
              }
            }
            return projectTaskView({ row, detail, firstEvent, repoKey })
          },
        })
        logTiming('/task', r)
        sendOk(r.value, timingOf(r))
        return
      }

      // ── GET /scenes?owner=&repo=[&scene_id=] ──
      //
      // 复制需求的场景下拉 / 移交流水线的目标列表（Issue #42）。
      // 宿主快路径 `/api/scenes/with-pipeline` 是 **user_only**：WORKER 会话 token 会 403，
      // 此时降级为「当前场景单条」（`scenes detail` 在 WORKER 可用）+ `degraded` 标记，
      // 保证复制表单至少能提交到源场景，而不是整块下拉不可用。
      if (route === '/scenes') {
        const owner = seg('owner'); const repo = seg('repo')
        if (!owner || !repo) { send(400, { ok: false, code: 'missing-param', message: '需要 owner 与 repo' }); return }
        if (owner === 'INVALID') { send(400, bad('owner')); return }
        if (repo === 'INVALID') { send(400, bad('repo')); return }
        const sceneId = filter('scene_id')
        if (sceneId === 'INVALID') { send(400, bad('scene_id')); return }

        const hostScenes = hostFetch.scenesWithPipeline
        // 既没快路径也没当前场景 id：回空列表（不伪造场景、不发注定 403 的 CLI）
        if (!sceneId && !hostScenes) { sendOk([]); return }

        const cliArgs = sceneId
          ? ['scenes', 'detail', '--scene_id', sceneId, '--repo', `${owner}/${repo}`, '--json-out']
          : ['scenes', 'list', '--repo', `${owner}/${repo}`, '--json-out']
        const r = await run(`scenes:${owner}/${repo}:${sceneId || ''}`, {
          cliArgs,
          host: hostScenes ? () => hostScenes(getConfig(), { owner, repo }) : undefined,
          force,
          ttlMs: SCENE_TTL_MS,
        })
        const data = projectScenesView(r.value, { degraded: r.source !== 'host' })
        logTiming('/scenes', r)
        sendOk(data, timingOf(r))
        return
      }

      // ── GET /health ──
      if (route === '/health') {
        sendOk({ prefix: PANEL_API_PREFIX, ttlMs: cacheTtlMs, failureTtlMs })
        return
      }

      send(404, { ok: false, code: 'not-found', message: `未知路径 ${route}` })
    } catch (err) {
      // 错误**原样**带出（含 CLI 那条 403 文案），前端直接显示，不吞错
      send(502, { ok: false, code: 'cli-error', message: err instanceof Error ? err.message : String(err) })
    }
  }
}