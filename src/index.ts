/**
 * @grape-dev/grape-dsh — Grape DevOps pipeline tools for DeepSeek Harness.
 *
 * Registers 33 model-facing tools that let the dsh agent trigger, monitor,
 * and manage Grape multi-agent DevOps pipelines via grape CLI.
 *
 * All tools are [Grape-unique] — they query data only available inside Grape.
 *
 * Design principle: only trigger, only observe, never interfere with
 * pipeline node-to-node handoff.
 *
 * Tools (33):
 *   Pipeline (5):
 *     1. grape_trigger_pipeline       — Trigger a pipeline
 *     2. grape_get_task_status        — Get task status by event_seq
 *     3. grape_wait_task              — Wait for task to reach terminal state
 *     4. grape_get_pipeline_info      — Get pipeline node status for an issue
 *     5. grape_get_pipeline_roadmap   — Get repo-level pipeline roadmap
 *
 *   Issues (10):
 *     6. grape_list_issues            — List issues with pipeline status
 *     7. grape_list_my_issues         — List my issues (no owner/repo needed)
 *     8. grape_get_issue_detail       — Issue detail (stage/events/pipeline)
 *     9. grape_create_issue           — Create issue + trigger pipeline (unified)
 *    10. grape_cancel_issue           — Cancel issue (stop pipeline)
 *    11. grape_resume_issue           — Resume cancelled issue
 *    12. grape_start_issue            — Start/open issue session
 *    13. grape_get_issue_events       — Event history for an issue
 *    14. grape_list_repo_events       — Repository events (cross-issue)
 *    15. grape_search                 — Global search (issues/repos/skills)
 *
 *   Events (1):
 *    16. grape_terminate_event        — Force-terminate a single event
 *
 *   Scenes (3):
 *    17. grape_list_scenes            — List available pipeline scenes
 *    18. grape_apply_scene            — Switch repo's scene
 *    19. grape_list_scenes_for_repo   — List scenes for a repo
 *
 *   Repos (5):
 *    20. grape_list_managed_repos     — List managed repos
 *    21. grape_list_repos_member      — List repos I can operate
 *    22. grape_get_repo_project_info  — Get repo project info
 *    23. grape_host_repo              — Host (onboard) a new repo
 *    24. grape_sync_repos             — Sync repos from VCS
 *
 *   Skills (3):
 *    25. grape_list_skills            — List skills
 *    26. grape_get_skill_detail       — Skill detail (SKILL.md)
 *    27. grape_search_skills          — Search skills
 *
 *   Knowledge (2):
 *    28. grape_list_knowledge         — List knowledge entries
 *    29. grape_get_knowledge_detail   — Knowledge entry detail
 *
 *   Dashboard (2):
 *    30. grape_get_repo_dashboard     — Repository dashboard
 *    31. grape_get_ops_overview       — Global ops overview
 *
 *   Project (2):
 *    32. grape_list_project_templates — List project templates
 *    33. grape_create_project         — Create project from template
 *
 * Note: grape_get_issue_status was removed — grape CLI 0.3.3 exposes no
 * read-only issue-status command (`issues status` is the PUT update verb).
 *
 * @module @grape-dev/grape-dsh
 */

import z from '@deepseek-ai/schemastery'
import { execGrape, grapeConfigError, resolveGrapeCliConfig, resolveGrapeCliConfigLenient } from './cli-client.js'
import { createPanelApiHandler, PANEL_API_PREFIX } from './panel-api.js'
import { checkWorkerApiRequest } from './worker-api-guard.js'
import {
  buildCreateIssuePayload,
  extractCreatedIssueNumber,
  toCreateIssueError,
  validateCreateIssueInput,
} from './create-issue.js'
import {
  classifyHandoffResult,
  isAlreadyStarted,
  parseIssueActionId,
  toIssueActionError,
  validateHandoffInput,
} from './issue-action-api.js'
import { projectHandoffTargets } from './task-view.js'
import { repoKeyFor } from './takeover-plan.js'
import { registerGrapeSkill } from './skill.js'
import { detectHostInfo, normalizePath, type HostInfo } from './host-os.js'
import {
  fetchTakeoverBundle,
  isLegacyTakeoverId,
  legacyAttachReply,
  legacyEndpointReply,
} from './takeover-bundle.js'
import { writeTakeoverScripts, type BundleScript } from './script-writer.js'
import { isFullyQualifiedPath, localizeRestoredCwd, localizeTakeoverCwd, resolveTakeoverRoot } from './takeover-workspace.js'
import {
  evaluateRedispatchGuard,
  eventDetailPath,
  mapRedispatchReply,
  takeoverListPath,
  type TakeoverSessionLite,
} from './takeover-dispatch.js'
import { runWorkerInstallCommand, workerInstallCommandWithEnv } from './install-command.js'
import {
  autoStartStatus,
  blockAutoStart,
  buildWorkerStartRecord,
  classifyWorkerState,
  cleanupStaleTakeoverTokens,
  evaluateStartGuard,
  findPython,
  grapeExecutable,
  installLayout,
  isAutoStartBlocked,
  pythonMissingMessage,
  pythonTooOldMessage,
  readLocalWorker,
  recordAutoStart,
  removeTakeoverToken,
  resolveApiAuth,
  resolveGrapeBin,
  runLocal,
  serverUrlMismatch,
  shouldAutoStartWorker,
  startLocalWorker,
  stopRuntimeAgent,
  workerLayout,
  workerLayoutCandidates,
  type GrapeBinResolution,
  type WorkerStartRecord,
} from './local-runtime.js'
import { redactSensitiveText } from './repo-diagnostics.js'
import {
  decideOnboard,
  listCredentials,
  listServerDevices,
  matchCredential,
  mintCredential,
  readServerState,
  resolveOnboardDeviceName,
  revokeCredential,
  runOnboardTransaction,
  sanitizeDeviceName,
  verifyDeviceOnline,
} from './worker-onboard.js'
import { hostname, homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { createPipelineTools } from './tools/pipeline.js'
import { createIssueTools } from './tools/issues.js'
import { createSceneTools } from './tools/scenes.js'
import { createRepoTools } from './tools/repos.js'
import { createEventTools } from './tools/events.js'
import { createSkillTools } from './tools/skills.js'
import { createKnowledgeTools } from './tools/knowledge.js'
import { createDashboardTools } from './tools/dashboard.js'
import { createProjectTools } from './tools/project.js'
import { GRAPE_WRITE_TOOL_NAMES } from './tool-names.js'

/** Cordis plugin name */
export const name = 'grape-tools'

/** Services required: only the tool registry */
export const inject = ['tools']

/** Plugin config (all optional — read from env vars by default)
 *
 * 字段加了 `.volatile()` 后**不是裸值**，而是 live getter（必须 `.get()` 才拿到值，
 * dsh 借此实现热改不重挂）。故一律用 {@link ConfigField} 类型 + {@link readConfigField} 读取。
 */
export type ConfigField<T> = T | { get: () => T }

export interface Config {
  /** Override grape CLI binary path (default: grape from PATH) */
  bin?: ConfigField<string>
  /**
   * Grape 服务地址 —— **唯一来源**（不再读 GRAPE_BASE_URL / GRAPE_SERVER_URL，也没有内置默认值）。
   * 本机 worker 的 `RUNTIME_SERVER_URL` 必须与它一致，否则视为「本环境没有 worker」需重装。
   */
  baseUrl?: ConfigField<string>
  /** Grape API Key —— 同样**唯一来源**（不读 GRAPE_API_TOKEN），与 baseUrl 必须属于同一环境 */
  token?: ConfigField<string>
  /**
   * 本机 worker 设备名（可选；不同环境可不同，必须 `dsh` 开头，例：`dsh-worker-001`）。
   * 缺省时按 `dsh-<hostname>` 生成；命名会经 `sanitizeDeviceName` 归一。
   */
  deviceName?: ConfigField<string>
  /** Request timeout in seconds (default: 30) */
  timeout?: ConfigField<number>
  /**
   * 写操作执行前是否要用户确认（默认 true）。
   *
   * 走 dsh 的 tools/pre-execute + approval seam。注意：若部署的审批策略是
   * `never`（DSH_PERMISSION_MODE=danger-full-access），ask 会被直接拒绝，
   * 此时应把它设为 false，否则写操作会被 fail-closed 挡住。
   */
  confirmWrites?: ConfigField<boolean>
  /** 客户端把界面换成 Grape 官网风格（深色 + 靛紫）；默认关 */
  grapeTheme?: ConfigField<boolean>
}

/**
 * 读一个配置字段：兼容裸值与 `.volatile()` 的 live getter。
 *
 * @param v 字段原值
 * @param fallback 缺失/空值时的回退
 */
function readConfigField<T>(v: unknown, fallback: T): T {
  if (v === undefined || v === null) return fallback
  if (typeof v === 'object' && typeof (v as { get?: unknown }).get === 'function') {
    const got = (v as { get: () => unknown }).get()
    return got === undefined || got === null ? fallback : (got as T)
  }
  return v as T
}

/** 本次会话内刚自动装好的 grape CLI 绝对路径（进程内记忆，重启后由已知安装目录/PATH 接管） */
let installedGrapeBin = ''

/** CLI 解析结果的短缓存：`/check` 20s 轮询 + 工具调用不必每次都探一次 `--version` */
const GRAPE_BIN_CACHE_TTL_MS = 30000
let grapeBinCache: { at: number; key: string; res: GrapeBinResolution } | null = null

/**
 * 本机 worker 相关路由要用的 grape CLI 解析结果（含来源，面板可直接排障）。
 *
 * 顺序（R9 config 优先 / R5 平台可执行名作最后兜底 / 已知安装目录优先于 PATH）：
 *   ① 插件 config 的 `bin`（用户配了绝对路径就必须尊重 —— 分析文档 §5.5）
 *   ② `GRAPE_CLI_BIN` 环境变量
 *   ③ 本次会话内刚自动安装的路径（装完 PATH 未必立刻生效，见 /install-grape）
 *   ④ 已知安装目录（插件安装器 / worker 安装脚本都可能在机器上留一份 CLI，Windows 无软链）
 *   ⑤ 平台可执行名（`grape.exe` / `grape`），真的能跑才算数
 */
function resolveLocalGrapeBin(config?: Config): GrapeBinResolution {
  const configured = readConfigField<string>(config?.bin, '')
  const envValue = String(process.env.GRAPE_CLI_BIN || '')
  const key = `${configured}\u0000${envValue}\u0000${installedGrapeBin}`
  const now = Date.now()
  if (grapeBinCache && grapeBinCache.key === key && now - grapeBinCache.at < GRAPE_BIN_CACHE_TTL_MS) {
    return grapeBinCache.res
  }
  const res = resolveGrapeBin({ configured, envValue, installed: installedGrapeBin })
  grapeBinCache = { at: now, key, res }
  return res
}

function localGrapeBin(config?: Config): string {
  return resolveLocalGrapeBin(config).bin
}

/** schemastery config schema
 *
 * `.volatile()` 标记"可运行时热改"（settings 系统用 volatileForm 投影出表单）；
 * `.role('secret')` 标记结构化脱敏——值不会跨 wire 回传浏览器，
 * 配置页拿到的是"存在/不存在"而非明文。
 *
 * 注：不写显式类型标注，因为 `.volatile()` 会把 schema 的 flavor 改成
 * `volatile-defined`，与 `z<Config>` 不兼容；让 TS 自行推断。
 */
export const Config = z.object({
  bin: z.string().default('').volatile(),
  baseUrl: z.string().default('').volatile(),
  token: z.string().default('').volatile().role('secret'),
  /**
   * 本机 worker 设备名（可选；不同环境可不同，必须 `dsh` 开头，例：`dsh-worker-001`）。
   *
   * ⚠️ 必须声明在这里（运行时 schema），只在 TS `Config` 接口里加是不够的：
   * dsh 的设置表单按 schema 校验写入，未声明的字段会被主机拒绝 → 面板点保存报「保存失败」。
   * 缺省按 `dsh-<hostname>` 生成；命名会经 `sanitizeDeviceName` 归一。
   */
  deviceName: z.string().default('').volatile(),
  timeout: z.number().default(30).volatile(),
  confirmWrites: z.boolean().default(true).volatile(),

  /**
   * 把 dsh 的界面换成 Grape 官网的视觉语言（深色 + 靛紫 #7170ff）。
   *
   * 客户端用 `ctx.theme.overrideTokens` 叠加 token 覆盖层实现；关掉即完全还原
   * 内置明/暗。默认关：装上插件不该擅自改别人整个界面。
   */
  grapeTheme: z.boolean().default(false).volatile(),
})

// ── P8：写操作确认 ──

/** 各写操作的中英提示文案 */
const WRITE_TOOL_PROMPT: Record<string, { en: string; zh: string }> = {
  grape_create_issue: { en: 'Create issue and trigger its pipeline', zh: '创建 Issue 并触发流水线' },
  grape_cancel_issue: { en: 'Cancel issue — stops the running pipeline', zh: '取消 Issue —— 会停止正在跑的流水线' },
  grape_trigger_pipeline: { en: 'Trigger a pipeline run', zh: '触发一次流水线执行' },
  grape_resume_issue: { en: 'Resume a cancelled issue', zh: '恢复已取消的 Issue' },
  grape_start_issue: { en: 'Start an issue', zh: '启动一个 Issue' },
  grape_terminate_event: { en: 'Terminate the given event', zh: '终止指定事件' },
  grape_apply_scene: { en: 'Apply a scene to the repository', zh: '为仓库应用场景（改配置）' },
  grape_host_repo: { en: 'Host a repository on Grape', zh: '在 Grape 上托管仓库' },
  grape_create_project: { en: 'Create a project from template', zh: '从模板创建项目' },
}

/** dsh 的 tools 事件面（我们只用到 pre-execute） */
interface HostCtx {
  tools: { register: (def: Record<string, unknown>) => void }
  on?: (
    event: 'tools/pre-execute',
    handler: (
      exec: { name: string; arguments?: unknown },
      next: () => Promise<unknown>,
    ) => unknown,
  ) => unknown
  /**
   * 作用域注入：`ctx.inject(服务名, 回调)` 只在服务可用时执行回调。
   *
   * 用它拿 `webServer` 而**不是**写进静态 `inject`：静态 inject 是硬依赖，
   * 会让本插件在 headless / SDK 部署（没有 webServer）下**完全不加载**，
   * 而我们的 33 个工具在那边照样有用。cordis 没有 optional inject 语义，
   * 作用域注入才是「可选依赖」的正确写法。
   */
  inject?: (
    services: string[],
    callback: (scoped: HostCtx & { webServer: WebServerLike }) => void,
  ) => unknown
}

/** `ctx.webServer` 的最小面（只用到 register） */
interface WebServerLike {
  register: (route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
  }) => () => void
}

/**
 * 接管工作区的显示名前缀。
 *
 * dsh 的 workspace title 默认取路径最后一段 —— 而每个任务的 cwd 都是
 * `<repo>/issues/<n>/<agent>`，最后一段永远是 agent 名，于是每接管一个任务
 * 侧栏就多一个 "vod"/"coding"/"qa"，很快就分不清谁是谁。
 * 这里统一加前缀 + 仓库/Issue 号，让每一行自解释。
 */
const TAKEOVER_TITLE_PREFIX = '接管 · '

/** 保留多少个接管工作区（更早的自动注销，避免侧栏越堆越长）。 */
const TAKEOVER_WS_KEEP = 10

/**
 * 判断一个 workspace 是不是「接管时自动建的」。
 *
 * 只认 Grape worker 的工作目录形态：/root/grape-workspaces/<平台>/<owner>/<repo>/issues/<n>/<agent>。
 * 用户自己的项目（data / grape-dsh / 任意路径）绝不匹配，所以清理不会误伤。
 */
function isTakeoverWorkspacePath(path: string): boolean {
  // 跨平台：把 \ 归一成 / 后按结构匹配（Linux /root/...、macOS /Users/...、Windows C:/...）
  // 不再要求绝对前缀为 /root —— 否则 macOS/Windows 上永远不命中，侧栏淘汰失效。
  // 中间层数不写死（平台名可能多一层，如 gitcode/<owner>/<repo>），只锚定尾部结构。
  const p = normalizePath(path)
  return /(^|\/)grape-workspaces\/.+\/issues\/\d+\/[A-Za-z0-9_-]+$/.test(p)
}

/**
 * 把技能包物化到 <cwd>/.skills/<skill>/。
 *
 * 为什么由插件做而不是留给 agent：worker 的 session token 调
 * `grape skills download` 必然 403（CLI 帮助明写 "session (tk_) → 403"），
 * agent 只能反复试错。而 `grape skills detail` 是 session 可用的，返回
 * SKILL.md 正文 + 短期 zip_url；插件用后者一次把整包（含 references/）落盘，
 * agent 开局就能读到 .skills/<skill>/SKILL.md。
 *
 * zip 结构实测为 `<skill>/SKILL.md` + `<skill>/references/*`，解压到 .skills/ 即正确落位。
 * zip 不可用时退回到「只写 SKILL.md 正文」，保证主文件一定有。
 */
/**
 * 调 Grape HTTP API（PRIVATE-TOKEN；4xx 也返回 body，交由上层映射）。
 *
 * 接管已收敛为服务端一等资源（POST /api/takeover/sessions 等 5 个端点），
 * 插件不再用 curl 拼流程：baseUrl/token 一律取自插件配置（热改即时生效）。
 */
async function grapeApiCall(
  cfg: { baseUrl?: string; token?: string },
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 30000,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; requestId: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(`${String(cfg.baseUrl || '').replace(/\/$/, '')}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'PRIVATE-TOKEN': String(cfg.token || '') },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    })
    const text = await r.text()
    let data: Record<string, unknown> = {}
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      data = { raw: text.slice(0, 400) }
    }
    // request_id：平台可能只放在响应头（body 里没有），原样带出去便于对齐日志
    const requestId = String(r.headers.get('request-id') || r.headers.get('x-request-id') || '')
    return { ok: r.ok, status: r.status, data, requestId }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把 bundle 资产落盘：技能整包（SKILL.md + references/）+ project_info + knowledge。
 *
 * 服务端 bundle 已内联全量内容（本地/无 OBS 环境），插件只写文件；
 * `skill.mode === 'zip'`（OBS 模式，服务端只回 content + 短期 zip_url）时用 curl+unzip 拉整包。
 * 与 worker 的 `_materialize_files` 保持同一落位约定：project_info / knowledge 写工作区根目录。
 */
/** 接管会话 → 工作目录（同一个进程内记着，finish 时用来采集产出） */
const takeoverCwds = new Map<string, string>()
/** legacy 接管（旧服务端无 attach 端点）→ 本地已登记的 workspace */
const legacyWorkspaces = new Map<string, { id: string; name: string }>()

/**
 * 找回某条接管对应的**本机**工作区目录（finish / abort / release 用）。
 *
 * 内存表 `takeoverCwds` 只在同一进程内有效；宿主重启后要从平台快照的
 * `workspace.cwd_hint` 找回 —— 但那是**远端 worker** 的路径（Linux `/root/...`）。
 * 直接当本机路径用会：finish 采不到交接内容（目录不存在）、abort 删错 token 文件
 * （Windows 上 `/root/x` 会解析成当前盘 `C:\root\x`）。所以回退路径必须再走一遍
 * `localizeTakeoverCwd`；拿不到 `grape-workspaces` 尾部时不猜（`derived` 需要
 * repo/issue/agent，这条路径没有），宁可返回空串让调用方降级。
 */
async function resolveTakeoverCwdLocal(
  cfg: { baseUrl?: string; token?: string },
  tid: string,
  provided?: string,
): Promise<string> {
  const cached = takeoverCwds.get(tid)
  if (cached) return cached

  const platform = (process.platform as 'win32' | 'darwin' | 'linux')
  // ① 面板回传的路径：本插件的 /takeover 已经本地化过，存在就能直接用
  const hinted = String(provided || '').trim()
  if (hinted && isFullyQualifiedPath(hinted, platform) && existsSync(hinted)) {
    takeoverCwds.set(tid, hinted)
    return hinted
  }

  // ② 从平台快照的 cwd_hint 找回 —— 再本地化，不能直接当本机路径
  try {
    const one = await grapeApiCall(cfg, 'GET', `/api/takeover/sessions/${encodeURIComponent(tid)}`)
    const bundle = (one.data?.bundle || {}) as {
      workspace?: { cwd_hint?: string }
      task?: { cwd?: string }
    }
    const remoteCwd = String(bundle.workspace?.cwd_hint || bundle.task?.cwd || '')
    if (!remoteCwd) return ''
    const localized = localizeRestoredCwd({
      remoteCwd,
      root: resolveTakeoverRoot({ env: process.env, home: homedir() }),
      platform,
      exists: (p) => {
        try { return existsSync(p) } catch { return false }
      },
    })
    if (!localized.cwd) return ''
    takeoverCwds.set(tid, localized.cwd)
    return localized.cwd
  } catch {
    return ''
  }
}

/**
 * 重派前的接管守门：先查事件属于哪个 issue，再查该 issue 是否有 active 接管。
 *
 * 为什么不让面板传 repo/issue：`NodeChain` 在「浏览」面板里也被复用，
 * 传参要穿过三层组件（还容易漏）；事件详情本身就带 `repo_key` / `issue_id`，
 * 宿主侧查一次比让 UI 各层都记住更可靠。任一步探测失败一律放行 ——
 * 「重新派发」是排障入口，不能因为探测失败就不可用，真正拍板的是平台。
 */
async function redispatchTakeoverGuard(
  cfg: { baseUrl?: string; token?: string },
  seq: number,
): Promise<{ blocked: boolean; status: number; body: Record<string, unknown> }> {
  const allow = { blocked: false, status: 200, body: {} as Record<string, unknown> }
  try {
    const ev = await grapeApiCall(cfg, 'GET', eventDetailPath(seq), undefined, 15000)
    if (!ev.ok) return allow
    const event = ((ev.data.event || ev.data) || {}) as { repo_key?: string; issue_id?: string }
    const repoKey = String(event.repo_key || '')
    if (!repoKey) return allow
    // 没有 issue 维度的事件（PR 订阅等）直接放行：否则会拿 repo 级 active 接管去挡别的 issue 的重派。
    const path = takeoverListPath({ repoKey, issueId: String(event.issue_id || '') })
    if (!path) return allow
    const list = await grapeApiCall(cfg, 'GET', path, undefined, 15000)
    const sessions = list.ok && Array.isArray((list.data as { sessions?: unknown }).sessions)
      ? ((list.data as { sessions: TakeoverSessionLite[] }).sessions)
      : []
    return evaluateRedispatchGuard({ event, sessions })
  } catch {
    return allow
  }
}

/**
 * finish 时自动采集交接内容：本地会话最后一条 assistant 文本 + 仓库改动清单。
 *
 * 为什么必须有：面板点「完成」只带 takeover_id，服务端拼出来的 A2A 交办是
 * "summary: ；evidence: ；files: " —— 下一节点等于没拿到交接内容。
 */
async function collectFinishArtifacts(cwd: string): Promise<{
  summary: string; evidence: string; files: string[]; actions: string[]; artifacts: string[]
}> {
  const out: { summary: string; evidence: string; files: string[]; actions: string[]; artifacts: string[] } =
    { summary: '', evidence: '', files: [], actions: [], artifacts: [] }
  if (!cwd) return out
  const fs = await import('node:fs')
  const path = await import('node:path')
  try {
    const { zstdDecompressSync } = await import('node:zlib')
    // 跨平台 slug：dsh 把工作目录转义成 --<path 分隔符全换 ->--；Windows 是反斜杠
    const slug = `--${cwd.replace(/[\\/]/g, '-')}--`
    const root = path.join(homedir(), '.dsh', 'sessions', slug)
    if (fs.existsSync(root)) {
      const dirs = fs.readdirSync(root)
        .filter((d) => d.startsWith('session-'))
        .map((d) => ({ d, t: fs.statSync(path.join(root, d)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      for (const { d } of dirs) {
        const f = path.join(root, d, 'session.v4.jsonl.zstd')
        if (!fs.existsSync(f)) continue
        let raw = ''
        try { raw = zstdDecompressSync(fs.readFileSync(f)).toString('utf8') } catch { continue }
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            const r = JSON.parse(line) as Record<string, any>
            if (r.type !== 'assistant/message') continue
            const parts = r?.data?.content || r?.data?.message?.content || []
            const txt = (Array.isArray(parts) ? parts : [])
              .filter((x: any) => x && x.type === 'text')
              .map((x: any) => String(x.text || '')).join('\n').trim()
            if (txt) out.summary = txt
          } catch { /* ignore line */ }
        }
        if (out.summary) break
      }
    }
  } catch (e) {
    console.warn(`[grape-dsh] takeover: read local session summary failed: ${String(e)}`)
  }

  try {
    const { execFileSync } = await import('node:child_process')
    // 仓库位置不固定：cwd 本身 / cwd/repo / cwd/worktree（worker 用 git worktree，
    // `.git` 是指针文件不是目录）→ 浅扫一层挑第一个带 .git 的
    const hasGit = (d: string): boolean => fs.existsSync(path.join(d, '.git'))
    let repo = ''
    for (const cand of [cwd, path.join(cwd, 'repo'), path.join(cwd, 'worktree')]) {
      if (fs.existsSync(cand) && hasGit(cand)) { repo = cand; break }
    }
    if (!repo) {
      try {
        for (const d of fs.readdirSync(cwd)) {
          const sub = path.join(cwd, d)
          try { if (fs.statSync(sub).isDirectory() && hasGit(sub)) { repo = sub; break } } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    if (repo) {
      const git = (args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], { timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
      const noise = /(__pycache__|\.pytest_cache|node_modules|\.venv|dist\/|\.DS_Store)/
      out.files = git(['status', '--porcelain']).split('\n')
        .map((l) => l.slice(3).trim())
        .filter((f) => f && !noise.test(f))
        .slice(0, 50)
      const log = git(['log', '--oneline', '-3']).trim()
      const stat = git(['diff', '--stat']).trim().split('\n').slice(-3).join('\n')
      out.evidence = [log ? `commits:\n${log}` : '', stat ? `diff:\n${stat}` : ''].filter(Boolean).join('\n')
      // 结构化结论：actions = 最近提交 + 改动文件数；artifacts = 改动文件 + commit 短 sha
      const commits = log.split('\n').map((l) => l.trim()).filter(Boolean)
      out.actions = commits.map((c) => `提交 ${c}`.slice(0, 200))
      if (out.files.length) out.actions.push(`修改 ${out.files.length} 个文件`)
      out.artifacts = [
        ...out.files.slice(0, 10),
        ...commits.map((c) => c.split(' ')[0]).filter(Boolean).slice(0, 5).map((sha) => `commit ${sha}`),
      ]
      // 分支名也算产出（下一节点/评审要跳过去）
      try {
        const br = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
        if (br && br !== 'HEAD') out.artifacts.unshift(`分支 ${br}`)
      } catch { /* ignore */ }
    }
  } catch (e) {
    console.warn(`[grape-dsh] takeover: collect git artifacts failed: ${String(e)}`)
  }
  out.summary = out.summary.slice(0, 800)
  out.evidence = out.evidence.slice(0, 1200)
  return out
}

async function materializeBundleAssets(
  cwd: string,
  bundle: Record<string, unknown>,
  host: HostInfo = detectHostInfo(),
): Promise<{ ok: boolean; skillMode: string; files: number; error: string }> {
  if (!cwd) return { ok: false, skillMode: 'none', files: 0, error: 'no cwd' }
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const path = await import('node:path')
  const assets = (bundle.assets || {}) as Record<string, unknown>
  const skill = (assets.skill || {}) as Record<string, unknown>
  const skillName = String(skill.name || '')
  // 服务端下发的技能名会被拼成目录名：只接受单个安全段，拒绝分隔符 / `..` / 绝对路径
  const skillDirName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(skillName) ? skillName : ''
  let files = 0
  let error = ''
  const writeAll = (root: string, dict: unknown): void => {
    if (!dict || typeof dict !== 'object') return
    for (const [rel, content] of Object.entries(dict as Record<string, unknown>)) {
      if (!rel || rel === '.metadata.json') continue
      // R4：写盘路径一律 path.join。bundle 里的 rel 永远是 POSIX 形式（`references/SKILL.md`），
      // 所以先按 '/' 拆段再交给 path.join —— 否则 Windows 上会写出 `cwd\.grape-x/references\SKILL.md`。
      const dest = path.join(root, ...rel.split('/').filter(Boolean))
      mkdirSync(path.dirname(dest), { recursive: true })
      writeFileSync(dest, String(content ?? ''), 'utf-8')
      files++
    }
  }
  try {
    // `skill_files` 有两种形状：平铺 {SKILL.md, references/…} 和包一层 {<skill>: {…}}。
    // 直接按原样写会把整个包写成"一个叫 <skill> 的文件"（实测 .grape-takeover-skills/<skill>/<skill>）。
    const flatten = (raw: unknown): Record<string, string> => {
      const out: Record<string, string> = {}
      if (!raw || typeof raw !== 'object') return out
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v && typeof v === 'object') {
          for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
            out[String(k2).replace(/^\.?\//, '')] = String(v2 ?? '')
          }
        } else if (k !== skillName) {
          out[String(k).replace(/^\.?\//, '')] = String(v ?? '')
        }
      }
      // 只有一个字符串且键=技能名 → 当作 SKILL.md 正文
      if (Object.keys(out).length === 0 && typeof raw === 'object') {
        const only = (raw as Record<string, unknown>)[skillName]
        if (typeof only === 'string') out['SKILL.md'] = only
      }
      return out
    }
    const skillFiles = skill.files as unknown
    if (skillDirName && skillFiles && typeof skillFiles === 'object' && Object.keys(skillFiles).length > 0) {
      // 用独立目录而不是 `.skills/`：worker 在任务开始/中止时会对 `.skills/<skill>`
      // 做 rmtree + 重新物化（skills.py dst_dir 清理），接管写在同一个位置会被它删掉/写残
      // ——真机事故：agent 打开 SKILL.md 时 references/ 已经不存在。
      const flat = flatten(skillFiles)
      const dest = path.join(cwd, '.grape-takeover-skills', skillDirName)
      try {
        const { rmSync } = await import('node:fs')
        rmSync(dest, { recursive: true, force: true })   // 只清我们自己这个目录，防上一轮残留嵌套
      } catch { /* ignore */ }
      writeAll(dest, flat)
      if (!Object.keys(flat).length) error = 'skill files empty after flatten' 
    } else if (skillDirName && skill.zip_url) {
      // 跨平台：Node fetch 下载（不依赖 curl），解压优先 tar（Windows 10+ 自带 bsdtar 支持 zip），
      // 再退回 unzip（macOS/Linux 通常有）；两者都失败 → 只落 SKILL.md 的降级由上层处理
      const { execFileSync } = await import('node:child_process')
      const os = await import('node:os')
      const tmpZip = path.join(os.tmpdir(), `grape-skill-${Date.now()}.zip`)
      const r = await fetch(String(skill.zip_url))
      if (!r.ok) throw new Error(`skill zip download failed: HTTP ${r.status}`)
      writeFileSync(tmpZip, Buffer.from(await r.arrayBuffer()))
      mkdirSync(path.join(cwd, '.grape-takeover-skills'), { recursive: true })
      const dest = path.join(cwd, '.grape-takeover-skills')
      const tryCmds: string[][] = host.isWindows
        ? [['tar', '-xf', tmpZip, '-C', dest], ['powershell', '-NoProfile', '-Command',
            `Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${dest}' -Force`]]
        : [['unzip', '-oq', tmpZip, '-d', dest], ['tar', '-xf', tmpZip, '-C', dest]]
      let unzipped = false
      let lastErr = ''
      for (const cmd of tryCmds) {
        try {
          execFileSync(cmd[0], cmd.slice(1), { timeout: 60000, stdio: 'ignore' })
          unzipped = true
          break
        } catch (e) { lastErr = String(e) }
      }
      try { (await import('node:fs')).unlinkSync(tmpZip) } catch { /* ignore */ }
      if (!unzipped) throw new Error(`skill zip extract failed: ${lastErr}`)
      files++
    }
    const pi = assets.project_info as Record<string, unknown> | undefined
    const kn = assets.knowledge as Record<string, unknown> | undefined
    writeAll(cwd, pi?.files)
    writeAll(cwd, kn?.files)
    // 接管脚本：内容由服务端按 host_os 渲染（bundle.assets.scripts），
    // 插件只替换 {{CWD}} 并按平台落盘（POSIX 执行位 / Windows UTF-8 BOM）
    const scripts = assets.scripts as BundleScript[] | undefined
    if (Array.isArray(scripts) && scripts.length) {
      const written = writeTakeoverScripts(cwd, scripts, host)
      const bad = written.filter((w) => !w.ok)
      files += written.filter((w) => w.ok).length
      if (bad.length) error = `script write failed: ${bad.map((b) => `${b.file}: ${b.error || ''}`).join('; ')}`
      console.log(`[grape-dsh] takeover: scripts written ${written.length - bad.length}/${written.length} os=${host.os}`)
    } else {
      console.log('[grape-dsh] takeover: bundle has no scripts assets — 脚本只由服务端按 host_os 渲染，插件不再内联 POSIX 脚本')
    }
    return { ok: files > 0, skillMode: String(skill.mode || 'none'), files, error }
  } catch (e) {
    error = String(e instanceof Error ? e.message : e)
    console.warn(`[grape-dsh] takeover: materialize assets failed: ${error}`)
    return { ok: false, skillMode: String(skill.mode || 'none'), files, error }
  }
}

/**
 * 登记任务目录为 workspace，返回 { id, name } 供前端定位「New session in X」入口。
 *
 * 不用 sessions.create 自建 session：实测它返回的是 `session-1` 这种内部序号 id，
 * 既不落盘也不绑定 workspace，前端按 id 切过去会打不开。dsh 前端的
 * 「New session in <workspace>」才会生成规范的 session-<uuid> 并建立 workspace 关联。
 *
 * 顺带做两件保持侧栏整洁的事：
 *   ① 新记录带唯一标题（仓库 + Issue + agent），不再是一排同名 "vod"
 *   ② 超出保留数的旧接管工作区自动注销（delete 只删注册，目录和 session 日志都留着）
 */
async function ensureTakeoverWorkspace(
  cwd: string,
  label: string,
  workspaceRegistry?: {
    create?: (path: string, title?: string) => Promise<{ id?: unknown; title?: unknown; path?: unknown }>
    list?: () => Array<{ id?: unknown; title?: unknown; path?: unknown }>
    delete?: (id: unknown) => Promise<boolean>
  },
): Promise<{ id: string; name: string; error: string }> {
  if (!workspaceRegistry || typeof workspaceRegistry.create !== 'function') {
    return { id: '', name: '', error: 'workspaceRegistry 服务不可用' }
  }
  try {
    const ws = await workspaceRegistry.create(cwd, `${TAKEOVER_TITLE_PREFIX}${label}`)
    const id = String(ws?.id ?? '')
    // create 对同一路径会复用旧记录且不改 title，所以显示名以返回值里的 title 为准，
    // 拿不到时退回 label（新建的情况）。
    const name = String(ws?.title ?? `${TAKEOVER_TITLE_PREFIX}${label}`)
    console.log(`[grape-dsh] takeover: workspace ${id} ("${name}") ready for ${cwd}`)

    // 清理历史接管工作区，只留最近 TAKEOVER_WS_KEEP 个
    try {
      if (typeof workspaceRegistry.list === 'function' && typeof workspaceRegistry.delete === 'function') {
        const takeoverWs = workspaceRegistry.list().filter(
          (w) => isTakeoverWorkspacePath(String(w.path ?? '')) && String(w.id) !== id,
        )
        console.log(`[grape-dsh] takeover: ${takeoverWs.length} older takeover workspace(s), keep ${TAKEOVER_WS_KEEP - 1}`)
        // list() 里新建的排在最前，所以超出保留数的就是最早那几个
        for (const stale of takeoverWs.slice(Math.max(0, TAKEOVER_WS_KEEP - 1))) {
          const ok = await workspaceRegistry.delete(stale.id)
          console.log(`[grape-dsh] takeover: pruned workspace ${String(stale.id)} ("${String(stale.title)}") ok=${ok}`)
        }
      } else {
        console.warn('[grape-dsh] takeover: workspaceRegistry.list/delete unavailable, skip prune')
      }
    } catch (e) {
      console.warn(`[grape-dsh] takeover: prune failed: ${String(e instanceof Error ? e.message : e)}`)
    }

    return { id, name, error: '' }
  } catch (e) {
    const error = String(e instanceof Error ? e.message : e)
    console.warn(`[grape-dsh] takeover: workspaceRegistry.create failed: ${error}`)
    return { id: '', name: '', error }
  }
}

/**
 * 准备工作区：目录不存在就建出来，并把任务环境写成可 source 的 shell 文件。
 *
 * 接管的语义是「不要求远端代码无损迁移」—— 远端 worker 的产物本来也拿不到。
 * 这里只保证两件事：
 *   ① 目录存在（session 需要真实 cwd）
 *   ② 环境变量可加载（agent 据此拉代码、调 API）
 * 代码和技能由 agent 自己用 `grape git clone` / `grape skills download` 重建，
 * 两者都走 grape CLI 的服务端凭据，插件不需要碰 git token。
 */
async function prepareTakeoverWorkspace(
  cwd: string,
  env: Record<string, string>,
): Promise<{ created: boolean; envFile: string; tokenFile: string; error: string }> {
  if (!cwd) return { created: false, envFile: '', tokenFile: '', error: '任务没有记录 cwd' }
  const { existsSync, mkdirSync, writeFileSync, chmodSync } = await import('node:fs')
  const path = await import('node:path')
  let created = false
  try {
    if (!existsSync(cwd)) {
      mkdirSync(cwd, { recursive: true })
      created = true
    }
  } catch (e) {
    return { created: false, envFile: '', tokenFile: '', error: `创建目录失败：${String(e instanceof Error ? e.message : e)}` }
  }
  // 只写白名单键，避免把无关宿主环境变量带进任务工作区
  const keys = [
    'GRAPE_SESSION_TOKEN', 'GRAPE_SERVER_URL', 'GRAPE_CLI_MODE', 'GRAPE_BOUND_SKILL',
    'GRAPE_ISSUE_ID', 'GRAPE_SCENE_ID', 'GRAPE_WORK_BRANCH', 'ISSUE_ID',
    'REPO_FULL_NAME', 'REPO_OWNER', 'REPO_NAME', 'ISSUE_NUMBER', 'ACCOUNT', 'AGENT_NAME',
    'GRAPE_TAKEOVER_ID',
  ]
  const lines = ['#!/bin/sh', '# 接管时生成：任务级环境变量（0600）']
  for (const k of keys) {
    const v = env[k]
    if (!v) continue
    lines.push(`export ${k}='${String(v).replace(/'/g, `'\\''`)}'`)   // 单引号转义，防 $/反引号展开
  }
  // token 另存一份 0600 文件并导出 GRAPE_AUTH_FILE：
  // dsh 的 bash 工具会 scrub 名字含 TOKEN/KEY/SECRET 的**环境变量**（换 shell 就丢），
  // 落文件后任何新 shell `source .grape-takeover-env.sh` 都能让 grape CLI 重新读到。
  //
  // 为什么不放 os.tmpdir()：本地 agent 在整个接管期间都要用它调 grape CLI，临时目录里的
  // 文件既跨不过会话边界、又会被其它进程看见；工作区 0600 文件随接管生命周期存在
  // （abort 删除；takeover 失败由 finally 删除），生命周期比临时文件更可控。
  const tok = env.GRAPE_SESSION_TOKEN || ''
  let tokenFile = ''
  if (tok) {
    tokenFile = path.join(cwd, '.grape-takeover-token')
    try {
      writeFileSync(tokenFile, String(tok), { mode: 0o600 })
      chmodSync(tokenFile, 0o600)
      lines.push(`export GRAPE_AUTH_FILE='${tokenFile}'`)
    } catch (e) {
      console.warn(`[grape-dsh] takeover: write token file failed: ${String(e)}`)
      tokenFile = ''
    }
  }
  // 进展上报 / 完成申请脚本不再由插件内联生成：
  // 旧实现是两段仅 POSIX 可用的 .sh（stderr 重定向、内联 python3 脚本、把响应丢到空设备），且鉴权头写死
  // `Bearer ***` 这个失效占位值 —— 从未真正跑通。脚本统一由服务端按 host_os 渲染
  // （bundle.assets.scripts → writeTakeoverScripts，Windows 出 .ps1）。

  const envFile = path.join(cwd, '.grape-takeover-env.sh')
  try {
    writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 })
    chmodSync(envFile, 0o600)
  } catch (e) {
    return { created, envFile: '', tokenFile, error: `写环境文件失败：${String(e instanceof Error ? e.message : e)}` }
  }
  return { created, envFile, tokenFile, error: '' }
}

/** Minimal JSON reply helper for the worker-onboard route. */
function _jsonReply(res: unknown, status: number, body: Record<string, unknown>): void {
  const r = res as { writeHead?: (s: number, h: Record<string, string>) => void; end?: (d: string) => void }
  r.writeHead?.(status, { 'content-type': 'application/json' })
  r.end?.(JSON.stringify(body))
}

/**
 * Read a JSON body from an HTTP request.
 *
 * 默认上限 4KB（各路由的 body 都很小）；create-issue 传 64KB —— 描述正文是用户输入，
 * 4KB 会把「描述稍长」直接静默变成 `{}`，用户只看到「标题不能为空」这种误导性报错。
 * 超限时回 `__tooLarge` 标记（调用方回 413 + 明确文案），不再静默变成空对象。
 */
function _readBody(
  req: { on?: (e: string, cb: (c?: unknown) => void) => void },
  maxBytes = 4096,
): Promise<{ cid?: string; __tooLarge?: boolean; [k: string]: unknown }> {
  return new Promise((resolve) => {
    if (typeof req.on !== 'function') return resolve({})
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c ?? ''))
      size += buf.length
      if (size > maxBytes) return resolve({ __tooLarge: true })
      chunks.push(buf)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text ? JSON.parse(text) : {})
      } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** Plugin entry point — registers all Grape tools on ctx.tools */
export function apply(ctx: HostCtx, config?: Config): void {
  // 用宽松解析挂载：缺 baseUrl/token 时**不让整个插件挂掉**（否则 33 个工具和
  // /grape-worker-api/* 路由都注册不上，用户连设置页入口都看不到）。缺配置的提示走两条路：
  //   ① 工具调用 → execGrape 入口抛 grapeConfigError()；
  //   ② 面板 → /check 回传 configError。
  const resolved = resolveGrapeCliConfigLenient(undefined, {
    bin: () => readConfigField<string>(config?.bin, '') || undefined,
    baseUrl: () => readConfigField<string>(config?.baseUrl, '') || undefined,
    token: () => readConfigField<string>(config?.token, '') || undefined,
    timeout: () => readConfigField<number>(config?.timeout, 30),
  })
  const mountConfigError = grapeConfigError(resolved)
  if (mountConfigError) {
    console.warn(`[grape-dsh] ${mountConfigError}（插件已挂载，但工具调用会返回该错误；面板会显示配置缺失）`)
  }

  // 确认开关：每次调用时读取（`.volatile()` 热改立即生效，无需重挂）
  const confirmWritesEnabled = (): boolean =>
    readConfigField<boolean>(config?.confirmWrites, true) !== false

  // Collect all tools from 9 tool groups
  const allTools = [
    ...createPipelineTools(resolved),     // 5
    ...createIssueTools(resolved),        // 10
    ...createEventTools(resolved),        // 1
    ...createSceneTools(resolved),        // 3
    ...createRepoTools(resolved),         // 5
    ...createSkillTools(resolved),        // 3
    ...createKnowledgeTools(resolved),    // 2
    ...createDashboardTools(resolved),    // 2
    ...createProjectTools(resolved),      // 2
  ]

  for (const toolDef of allTools) {
    ctx.tools.register(toolDef)
  }

  // ── P8：写操作执行前弹确认 ──
  //
  // 走 dsh 的 tools/pre-execute waterfall + approval seam：
  // 返回 { kind:'ask' } → dsh 把请求交给审批通道（web 端弹确认框），
  // 用户允许 → allowed-once 后放行；拒绝 → 工具不执行。
  //
  // 幂等：dsh 的 on() 返回 disposer，插件卸载时自动摘除。
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('tools/pre-execute', (exec, next) => {
        if (!GRAPE_WRITE_TOOL_NAMES.includes(exec.name)) return next()
        if (!confirmWritesEnabled()) return next()   // 热读：配置改成 false 即刻放行
        const prompt = WRITE_TOOL_PROMPT[exec.name]
        return {
          kind: 'ask',
          reason: `grape-write:${exec.name}`,
          displayReason: {
            en: prompt
              ? `${prompt.en}? This changes Grape state.`
              : `${exec.name} changes Grape state. Allow?`,
            zh: prompt
              ? `${prompt.zh}？这会改动 Grape 状态。`
              : `${exec.name} 会改动 Grape 状态，允许执行吗？`,
          },
        }
      })
    } catch (err) {
      console.warn(`[grape-dsh] pre-execute confirmation registration failed: ${String(err)}`)
    }
  }

  console.log(
    `[grape-dsh] Registered ${allTools.length} tools, baseUrl=${resolved.baseUrl}, bin=${resolved.bin}` +
      (confirmWritesEnabled() ? `, confirmWrites=on (${GRAPE_WRITE_TOOL_NAMES.length} write tools)` : ', confirmWrites=off'),
  )

  // ── 默认 skill：约束模型"issue 的实现交给流水线，别自己动手" ──
  //  见 src/skill.ts 顶部 —— 这是对一次真实事故的修补：
  //  模型被要求在某个 issue 里实现功能时，绕开 Grape 自己 clone + 改代码 + push + 开 PR，
  //  还在本插件仓库里留了 .scratch/。
  try {
    registerGrapeSkill(ctx)
    console.log('[grape-dsh] default skill registered (grape-issue-workflow)')
  } catch (err) {
    console.warn(`[grape-dsh] skill registration failed: ${String(err)}`)
  }

  // ── P11：右栏「资源浏览」的只读代理 ──
  //
  // 面板要按点击取 Grape 数据，但 token 是 `.role('secret')`（只写不读），
  // 前端拿不到 → 由宿主代理：token 只留宿主、同源免 CORS、可缓存去重。
  // 见 RIGHT-PANEL-BROWSER-DESIGN.md §3-4。
  //
  // 用**作用域注入**拿 webServer：headless 部署没有它时回调不执行，
  // 插件照常加载（33 个工具在那边的价值不受影响）。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scoped) => {
        const handler = createPanelApiHandler(() =>
          // 每次请求重新解析：`.volatile()` 配置热改即时生效
          resolveGrapeCliConfig(undefined, {
            bin: () => readConfigField<string>(config?.bin, '') || undefined,
            baseUrl: () => readConfigField<string>(config?.baseUrl, '') || undefined,
            token: () => readConfigField<string>(config?.token, '') || undefined,
            timeout: () => readConfigField<number>(config?.timeout, 30),
          }))

        try {
          scoped.webServer.register({
            kind: 'prefix',
            path: PANEL_API_PREFIX,
            handler: handler as unknown as (req: unknown, res: unknown) => Promise<void>,
          })
          console.log(`[grape-dsh] panel api mounted at ${PANEL_API_PREFIX} (read-only)`)
        } catch (err) {
          console.warn(`[grape-dsh] panel api route registration failed: ${String(err)}`)
        }
      })
    } catch (err) {
      console.warn(`[grape-dsh] panel api wiring failed: ${String(err)}`)
    }
  }

  // ── E：本机接入 Worker（CLI 方案，2026-10-29 重构）──────────────────
  //
  // 原方案（已废弃）：自建 HTTP 路由 + nonce 鉴权 + fetch 调 Grape API 签发凭据
  //   → ~400 行 worker-onboard.ts，鉴权复杂，且 token 穿透是单独的问题。
  //
  // 新方案：grape CLI 已有完整的 runtime credential 命令族：
  //   grape settings runtime credential create --json '{"name":"dsh-<host>"}' --json-out
  //   grape settings runtime credentials                    （列表）
  //   grape settings runtime credential revoke --cid <id>  （吊销）
  //
  // 所以宿主侧只需要：把一条 shell 命令写进本机终端（ctx.terminalController），
  // 让 grape CLI 在终端里完成签发 + 安装。鉴权由 grape CLI 自己管（读 env / config），
  // 不需要插件自建 nonce / 同源校验。
  //
  // 命令不自动回车：本机可能已接入过，安装器默认目录会再装一份 → 用户看一眼再按回车。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scoped) => {
        const handler = createPanelApiHandler(() =>
          // 每次请求重新解析：`.volatile()` 配置热改即时生效
          resolveGrapeCliConfig(undefined, {
            bin: () => readConfigField<string>(config?.bin, '') || undefined,
            baseUrl: () => readConfigField<string>(config?.baseUrl, '') || undefined,
            token: () => readConfigField<string>(config?.token, '') || undefined,
            timeout: () => readConfigField<number>(config?.timeout, 30),
          }))

        try {
          scoped.webServer.register({
            kind: 'prefix',
            path: PANEL_API_PREFIX,
            handler: handler as unknown as (req: unknown, res: unknown) => Promise<void>,
          })
          console.log(`[grape-dsh] panel api mounted at ${PANEL_API_PREFIX} (read-only)`)
        } catch (err) {
          console.warn(`[grape-dsh] panel api route registration failed: ${String(err)}`)
        }
      })
    } catch (err) {
      console.warn(`[grape-dsh] panel api wiring failed: ${String(err)}`)
    }
  }

  // ── E：本机接入 Worker（CLI 方案，2026-10-29 重构）──────────────────
  //
  // 原方案（已废弃）：自建 HTTP 路由 + nonce 鉴权 + fetch 调 Grape API 签发凭据
  //   → ~400 行 worker-onboard.ts，鉴权复杂，且 token 穿透是单独的问题。
  //
  // 新方案：grape CLI 已有完整的 runtime credential 命令族：
  //   grape settings runtime credential create --json '{"name":"dsh-<host>"}' --json-out
  //   grape settings runtime credentials                    （列表）
  //   grape settings runtime credential revoke --cid <id>  （吊销）
  //
  // 所以宿主侧只需要：把一条 shell 命令写进本机终端（ctx.terminalController），
  // 让 grape CLI 在终端里完成签发 + 安装。鉴权由 grape CLI 自己管（读 env / config），
  // 不需要插件自建 nonce / 同源校验。
  //
  // 命令不自动回车：本机可能已接入过，安装器默认目录会再装一份 → 用户看一眼再按回车。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scoped) => {
        const handler = createPanelApiHandler(() =>
          // 每次请求重新解析：`.volatile()` 配置热改即时生效
          resolveGrapeCliConfig(undefined, {
            bin: () => readConfigField<string>(config?.bin, '') || undefined,
            baseUrl: () => readConfigField<string>(config?.baseUrl, '') || undefined,
            token: () => readConfigField<string>(config?.token, '') || undefined,
            timeout: () => readConfigField<number>(config?.timeout, 30),
          }))

        try {
          scoped.webServer.register({
            kind: 'prefix',
            path: PANEL_API_PREFIX,
            handler: handler as unknown as (req: unknown, res: unknown) => Promise<void>,
          })
          console.log(`[grape-dsh] panel api mounted at ${PANEL_API_PREFIX} (read-only)`)
        } catch (err) {
          console.warn(`[grape-dsh] panel api route registration failed: ${String(err)}`)
        }
      })
    } catch (err) {
      console.warn(`[grape-dsh] panel api wiring failed: ${String(err)}`)
    }
  }

  // ── E：本机接入 Worker（CLI 方案，2026-10-29 重构）──────────────────
  //
  // 原方案（已废弃）：自建 HTTP 路由 + nonce 鉴权 + fetch 调 Grape API 签发凭据
  //   → ~400 行 worker-onboard.ts，鉴权复杂，且 token 穿透是单独的问题。
  //
  // 新方案：grape CLI 已有完整的 runtime credential 命令族：
  //   grape settings runtime credential create --json '{"name":"dsh-<host>"}' --json-out
  //   grape settings runtime credentials                    （列表）
  //   grape settings runtime credential revoke --cid <id>  （吊销）
  //
  // 所以宿主侧只需要：把一条 shell 命令写进本机终端（ctx.terminalController），
  // 让 grape CLI 在终端里完成签发 + 安装。鉴权由 grape CLI 自己管（读 env / config），
  // 不需要插件自建 nonce / 同源校验。
  //
  // 命令不自动回车：本机可能已接入过，安装器默认目录会再装一份 → 用户看一眼再按回车。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scoped) => {
        const handler = createPanelApiHandler(() =>
          // 每次请求重新解析：`.volatile()` 配置热改即时生效
          resolveGrapeCliConfig(undefined, {
            bin: () => readConfigField<string>(config?.bin, '') || undefined,
            baseUrl: () => readConfigField<string>(config?.baseUrl, '') || undefined,
            token: () => readConfigField<string>(config?.token, '') || undefined,
            timeout: () => readConfigField<number>(config?.timeout, 30),
          }))

        try {
          scoped.webServer.register({
            kind: 'prefix',
            path: PANEL_API_PREFIX,
            handler: handler as unknown as (req: unknown, res: unknown) => Promise<void>,
          })
          console.log(`[grape-dsh] panel api mounted at ${PANEL_API_PREFIX} (read-only)`)
        } catch (err) {
          console.warn(`[grape-dsh] panel api route registration failed: ${String(err)}`)
        }
      })
    } catch (err) {
      console.warn(`[grape-dsh] panel api wiring failed: ${String(err)}`)
    }
  }

  // ── E：本机接入 Worker（CLI 方案，2026-10-29 重构）──────────────────
  //
  // 原方案（已废弃）：自建 HTTP 路由 + nonce 鉴权 + fetch 调 Grape API 签发凭据
  //   → ~400 行 worker-onboard.ts，鉴权复杂，且 token 穿透是单独的问题。
  //
  // 新方案：grape CLI 已有完整的 runtime credential 命令族：
  //   grape settings runtime credential create --json '{"name":"dsh-<host>"}' --json-out
  //   grape settings runtime credentials                    （列表）
  //   grape settings runtime credential revoke --cid <id>  （吊销）
  //
  // 所以宿主侧只需要：把一条 shell 命令写进本机终端（ctx.terminalController），
  // 让 grape CLI 在终端里完成签发 + 安装。鉴权由 grape CLI 自己管（读 env / config），
  // 不需要插件自建 nonce / 同源校验。
  //
  // 命令不自动回车：本机可能已接入过，安装器默认目录会再装一份 → 用户看一眼再按回车。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer', 'terminalController', 'agents', 'workspaceRegistry'], (scoped) => {
        try {
          const tc = (scoped as unknown as {
            terminalController?: {
              create?: (agent: unknown, request: unknown, signal: AbortSignal) => Promise<unknown>
              follow?: (agent: unknown, id: string, attachmentId: string, signal: AbortSignal) => AsyncIterable<unknown>
              write?: (agent: unknown, id: string, attachmentId: string, data: string) => Promise<void>
            }
          }).terminalController
          const agents = (scoped as unknown as { agents?: { list?: () => unknown[] } }).agents
          /**
           * 接管用：把任务目录登记成 dsh 的 workspace。
           * session 由**客户端**的 ctx.sessions.create({workspaceId}) + prompt() 建
           * （见 src/client/index.tsx 的 setApiSessionCreator）。宿主侧的 ctx.sessions
           * 是 session registry（get/attach），不带 create —— 别在这里调。
           */
          const workspaceRegistry = (scoped as unknown as {
            workspaceRegistry?: {
              create?: (path: string, title?: string) => Promise<{ id?: unknown; title?: unknown; path?: unknown }>
              list?: () => Array<{ id?: unknown; title?: unknown; path?: unknown }>
              delete?: (id: unknown) => Promise<boolean>
            }
          }).workspaceRegistry
          if (!tc || typeof tc.create !== 'function' || !agents || typeof agents.list !== 'function') {
            console.warn('[grape-dsh] terminalController or agents unavailable, worker-onboard disabled')
            return
          }

          /** 服务端 API 凭据（config 优先、env 兜底，R9） */
          const workerApiAuth = (): { baseUrl: string; token: string; error: string } => resolveApiAuth({
            baseUrl: readConfigField<string>(config?.baseUrl, ''),
            token: readConfigField<string>(config?.token, ''),
          })

          /** 拉起护栏的设备键：有设备名用设备名，否则用安装目录（同一台机器稳定） */
          const autoStartKey = (facts: { deviceName: string; installDir: string }): string =>
            facts.deviceName || facts.installDir

          /** 与本机事实匹配的安装布局（候选里找 installDir 相同的那个） */
          const layoutForFacts = (facts: { installDir: string }) =>
            workerLayoutCandidates().find((l) => l.installDir === facts.installDir) ?? workerLayout()

          /** `/onboard` 进程内互斥（双击 / 双标签 / 超时重试不得并发签发凭据） */
          let onboardInFlight: Promise<void> | null = null

          /**
           * 接入安装进度（`/check` 回传给面板，安装期间显示「正在下载/安装/等待上线」）。
           * null = 当前没有安装在进行。安装是流式异步的，所以这里可以安全地被并发读取。
           */
          let onboardProgress: { stage: string; startedAt: number; lines: string[] } | null = null
          const setOnboardStage = (stage: string): void => {
            if (!onboardProgress) return
            onboardProgress.stage = stage
          }
          const pushOnboardLine = (line: string): void => {
            if (!onboardProgress) return
            const text = line.trim()
            // 过滤 PowerShell 重定向 stderr 时输出的 CLIXML/进度噪声，面板只显示人类可读行
            if (!text || text.startsWith('#< CLIXML') || text.startsWith('<Objs')) return
            onboardProgress.lines.push(text.slice(0, 300))
            if (onboardProgress.lines.length > 20) onboardProgress.lines.shift()
          }

          /**
           * `/check` 的 CLI 凭据探测缓存。
           * 面板每 20s 轮询、每次要跑 `grape --version` + `grape … credentials` 两条 spawnSync，
           * 无缓存时会把偶发手动刷新放大成常态阻塞事件循环。30s TTL 足够（服务端状态另有设备行补全）。
           */
          const CREDS_CACHE_TTL_MS = 30000
          type CachedCreds = Array<{ id: number; name: string; status: string; device_name: string; last_seen_at?: string | null; created_at?: string }>
          let credsCache: { at: number; base: string; data: CachedCreds } | null = null

          /**
           * `/check` 的服务端设备行补全缓存（30s TTL）。
           * 设备列表要翻页拉取（最坏 20 页×10s），面板每 20s 轮询时不能每次都打服务端；
           * `/check` 仍严格只读，缓存只影响展示字段，不参与本地判定。
           */
          const SERVER_DEVICE_CACHE_TTL_MS = 30000
          type CachedServerDevice = {
            credential_id?: number
            device_name: string
            name: string
            credential_status: string
            health: string
            last_seen_at: string | null
            worker_version?: string
          }
          let serverDevicesCache: { at: number; data: CachedServerDevice[] } | null = null

          /**
           * 最近一次拉起的结果（按设备键）。面板「判定依据」展示 pid / 退出码 / stderr 摘要，
           * 也是「拉起失败必须回写错误」的落地位置（Issue #25 第 4 条）。
           */
          const LAST_START = new Map<string, WorkerStartRecord>()

          /** code 42 = 凭据被吊销：本进程内永久停止自动拉起（否则只会刷屏重启） */
          const watchWorkerExit = (key: string, code: number | null): void => {
            const prev = LAST_START.get(key)
            if (prev) LAST_START.set(key, { ...prev, exitCode: code })
            if (code !== 42) return
            blockAutoStart(key, 'credential-revoked')
            console.warn(`[grape-dsh] worker ${key} 退出码 42（凭据被吊销），本进程内不再自动拉起`)
          }

          /**
           * 拉起后核对 runtime.env 的 device_name / token 与期望（服务端行）是否一致，
           * 并回写 pid / 退出码 / stderr 摘要。失败不回滚进程，只把差异写进记录。
           */
          const recordWorkerStart = (
            key: string,
            started: { started: boolean; error: string; pid: number },
            expected: { deviceName?: string; serverUrl?: string; serverDeviceName?: string },
            serverRow: { device_name?: string; worker_version?: string } | null,
          ): WorkerStartRecord => {
            const after = readLocalWorker()
            const record = buildWorkerStartRecord({
              started,
              expected,
              actual: { deviceName: after.deviceName, serverUrl: after.serverUrl, tokenPresent: after.tokenPresent },
              probe: after.probe,
            })
            if (serverRow?.device_name && after.deviceName && serverRow.device_name !== after.deviceName) {
              record.verifyState = 'mismatch'
              record.verifyDetail = [record.verifyDetail, `服务端设备名 ${serverRow.device_name} ≠ 本机 ${after.deviceName}`]
                .filter(Boolean).join('；')
            }
            LAST_START.set(key, record)
            return record
          }

          scoped.webServer.register({
            kind: 'prefix',
            path: '/grape-worker-api',
            handler: async (reqRaw: unknown, res: unknown) => {
              const req = reqRaw as {
                method?: string
                url?: string
                headers?: Record<string, string | string[] | undefined>
              }
              const method = String(req.method ?? 'GET')
              const url = String(req.url ?? '/')

              // 同源 / CSRF 守卫（Origin / Sec-Fetch-Site / Content-Type）：在解析 method/url 后、
              // 进入任何路由前统一判定 —— 该 prefix 下全部写路由一次覆盖，跨站页面无法再用
              // text/plain 的「简单请求」打进来。无 Origin 且无 Content-Type 的 CLI/宿主调用照常放行。
              const guard = checkWorkerApiRequest({ method, headers: req.headers })
              if (!guard.allow) {
                console.log(`[grape-dsh] worker-api blocked: ${guard.code} ${method} ${url.split('?')[0]}`)
                _jsonReply(res, guard.status, { ok: false, code: guard.code, error: guard.message })
                return
              }

              // GET /ping → 就绪检查
              if (method === 'GET' && url.startsWith('/grape-worker-api/ping')) {
                _jsonReply(res, 200, { ok: true })
                return
              }

              // GET /check → 只读：本机事实（runtime.env → 进程 → 安装目录）+ CLI + 服务端补全
              //
              // 🔴 本路由**永不写**、永不签发凭据、永不安装：事故就是「已接入被判未接入」
              // 之后点了接入。判定顺序见 readLocalWorker；服务端数据只用于补全展示。
              if (method === 'GET' && url.startsWith('/grape-worker-api/check')) {
                try {
                  const local = readLocalWorker()
                  // 探测复用 config.bin（§5.5），spawnSync 数组传参 + shell:false（R1/R2）。
                  // 失败时区分「可执行文件不存在」与「执行失败」—— 过去一律当成未安装。
                  // CLI 解析分层：config → env → 会话内装好的 → 已知安装目录 → PATH，
                  // 免得 Windows 上「装了 CLI 但没有 PATH 软链」时面板恒报「未检测到 grape CLI」。
                  const binInfo = resolveLocalGrapeBin(config)
                  const bin = binInfo.bin
                  const probe = runLocal(bin, ['--version'])
                  const grapeVersion = probe.stdout.trim()
                  const grapeAvailable = probe.ok && Boolean(grapeVersion)
                  const probeError = grapeAvailable
                    ? ''
                    : (probe.missing
                      ? `未找到可执行文件: ${bin}（来源：${binInfo.source}；已尝试：${binInfo.tried.slice(0, 5).join(' / ')}）`
                      : (probe.stderr.trim() || probe.error || `exit code ${probe.status ?? 'null'}`)).slice(0, 300)

                  // 凭据来源（Issue #25 三处修复之一）：优先用**插件自己配置的环境**查，
                  // 否则会把 CLI 登录环境（可能是另一台服务端）的凭据混进本环境的设备卡里，
                  // 出现「服务端无匹配设备行，却有 active 凭据 #xxx」这种自相矛盾的诊断。
                  const auth = resolveApiAuth({
                    baseUrl: readConfigField<string>(config?.baseUrl, ''),
                    token: readConfigField<string>(config?.token, ''),
                  })
                  let creds: CachedCreds = []
                  let credentialSource: 'plugin-api' | 'cli' = 'plugin-api'
                  if (!auth.error) {
                    const now = Date.now()
                    if (credsCache && credsCache.base === auth.baseUrl && now - credsCache.at < CREDS_CACHE_TTL_MS) {
                      creds = credsCache.data
                    } else {
                      try {
                        creds = await listCredentials(auth)
                        credsCache = { at: now, base: auth.baseUrl, data: creds }
                      } catch {
                        credentialSource = 'cli'
                      }
                    }
                  } else {
                    credentialSource = 'cli'
                  }
                  // CLI 兜底（CLI 登录即可读，不依赖插件里的 API Key）
                  if (credentialSource === 'cli' && grapeAvailable) {
                    const now = Date.now()
                    if (credsCache && credsCache.base === '__cli__' && now - credsCache.at < CREDS_CACHE_TTL_MS) {
                      creds = credsCache.data
                    } else {
                      const list = runLocal(bin, ['settings', 'runtime', 'credentials', '--json-out'], 15000)
                      if (list.ok) {
                        try {
                          const d = JSON.parse(list.stdout)
                          creds = Array.isArray(d) ? d : (d.credentials ?? d.result ?? [])
                          credsCache = { at: now, base: '__cli__', data: creds }
                        } catch { /* 输出不是 JSON（CLI 版本不匹配等） */ }
                      }
                    }
                  }
                  const deviceName = local.deviceName
                  // 同一设备名可能有多行凭据：active 优先，避免拿旧 revoked 行误导面板
                  const mine = matchCredential(creds, deviceName || '')
                  let serverDevice: CachedServerDevice | null = null
                  if (!auth.error && deviceName) {
                    try {
                      const now = Date.now()
                      if (serverDevicesCache && now - serverDevicesCache.at < SERVER_DEVICE_CACHE_TTL_MS) {
                        serverDevice = serverDevicesCache.data.find((d) => d.device_name === deviceName) ?? null
                      } else {
                        const devices = await listServerDevices(auth)
                        serverDevicesCache = { at: now, data: devices }
                        serverDevice = devices.find((d) => d.device_name === deviceName) ?? null
                      }
                    } catch { /* 补全失败不影响本地事实 */ }
                  }
                  // CLI 不可用 + 本机也读不到任何事实 → 是「读取失败」，不是「未安装」
                  // （后者会诱导用户点接入，进而重装 —— 正是本次事故）
                  const readError = local.readError
                    || (!grapeAvailable && local.source === 'none' ? (probeError || '无法读取本机设备信息') : '')
                  const startKey = autoStartKey(local)
                  const lastStart = LAST_START.get(startKey) ?? null
                  // 环境隔离（2026-11-20 用户要求）：本机 runtime.env 的服务地址与插件 config
                  // 对不上 → 本环境视同「没有 worker」，面板必须引导「重新接入」，绝不给它显示为已接入。
                  const serverMismatch = local.installed && serverUrlMismatch(local.serverUrl, auth.baseUrl)
                  const configuredDeviceName = sanitizeDeviceName(readConfigField<string>(config?.deviceName, ''))
                  // 「接入本机会注册成什么名字」：与 /onboard 用同一个纯函数，保证面板展示与真实行为一致
                  const targetDeviceName = resolveOnboardDeviceName(configuredDeviceName, local.deviceName)
                  // 配置的设备名与运行中的设备名不一致：提示「改名需重新接入」，并说明重新接入后的目标名
                  const deviceNameMismatch = Boolean(local.deviceName && targetDeviceName !== local.deviceName)
                  _jsonReply(res, 200, {
                    ok: true,
                    grapeAvailable,
                    grapeVersion,
                    // 诊断字段（前端忽略未知字段）：排查「装了却检测不到」时直接看到实际探测的路径
                    bin,
                    binSource: binInfo.source,
                    binTried: binInfo.tried.slice(0, 8),
                    grapeMissing: !grapeAvailable && probe.missing,
                    probeError,
                    // 本机事实（M1）：found 由多源判定，不再只看 credential 名
                    // found = 当前配置环境下有这台设备（Issue #25 收敛后的唯一判据）
                    // + 环境隔离：地址不一致时一律 found=false，避免拿别的环境的设备行充数。
                    found: !readError && !serverMismatch && Boolean(serverDevice),
                    installed: local.installed,
                    running: local.running,
                    processAlive: local.running,
                    source: local.source,
                    deviceName,
                    // 配置里指定的设备名（不同环境可不同，必须 dsh 开头）；空 = 未配置，按 dsh-<host> 生成
                    configuredDeviceName,
                    // 「接入本机会注册成的名字」= config 名 > 本机 runtime.env > dsh-<host>
                    targetDeviceName,
                    // 目标名 ≠ 运行中设备名：重新「接入本机」会按目标名注册（运行中需先注销/停止）
                    deviceNameMismatch,
                    // 配置缺失原因（baseUrl/token 未填）：面板据此显示「去设置页填写」，而不是干巴巴的未接入
                    configError: auth.error,
                    serverUrl: local.serverUrl || auth.baseUrl,
                    // 插件配置的环境地址 —— 与 serverUrl 对比以判断本机 worker 是否属于本环境
                    configuredServerUrl: auth.baseUrl,
                    serverMismatch,
                    workerVersion: local.version,
                    tokenPresent: local.tokenPresent,
                    installDir: local.installDir,
                    envFile: local.envFile,
                    readError,
                    // 安装进度（仅接入事务进行中非 null）：面板据此显示「正在下载/安装/等待上线」+ 最近输出，
                    // 因为安装已改为异步流式执行，安装期间 /check 仍然可用。
                    onboard: onboardProgress
                      ? {
                          stage: onboardProgress.stage,
                          elapsedMs: Date.now() - onboardProgress.startedAt,
                          lines: onboardProgress.lines.slice(-8),
                        }
                      : null,
                    // 环境不一致时不要回传「别的环境」的凭据/设备行，避免面板继续展示串环境数据
                    credential: serverMismatch ? null : (mine ?? null),
                    credentialSource: serverMismatch ? '' : credentialSource,
                    credentialEnv: serverMismatch ? '' : (credentialSource === 'plugin-api' ? auth.baseUrl : 'CLI 登录环境'),
                    device: serverMismatch ? null : serverDevice,
                    // 面板只看「本环境有没有这台设备」；12 态状态机仍供 /ensure-worker 内部护栏使用，
                    // 不再回传给面板（Issue #25 收敛：界面只展示设备信息）。
                    heartbeatIntervalSec: local.heartbeatIntervalSec,
                    // 进程探测元数据（命令/超时/退出码/stderr 前 20 行）——脱敏后回传
                    probe: {
                      ...local.probe,
                      error: redactSensitiveText(local.probe.error),
                      stderrLines: local.probe.stderrLines.map((l) => redactSensitiveText(l)),
                      matched: local.probe.matched.map((p) => ({ pid: p.pid, command: redactSensitiveText(p.command) })),
                    },
                    processes: local.processes.map((p) => ({ pid: p.pid, command: redactSensitiveText(p.command) })),
                    lastStart,
                  })
                } catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err) })
                }
                return
              }

              // POST /install-grape → 自动下载安装 grape CLI（跨平台）
              if (method === 'POST' && url.startsWith('/grape-worker-api/install-grape')) {
                try {
                  const { mkdirSync, existsSync, symlinkSync } = await import('node:fs')
                  const layout = installLayout()
                  const tarballUrl = 'https://raw.gitcode.com/grape-dev/grape-cli/archive/refs/heads/main.tar.gz'

                  // 已安装 → 幂等返回（重复点按钮不应再跑一遍 pip）
                  const existing = runLocal(layout.grapeBin, ['--version'])
                  if (existing.ok && existing.stdout.trim()) {
                    installedGrapeBin = layout.grapeBin
                    _jsonReply(res, 200, {
                      ok: true, version: existing.stdout.trim(), path: layout.grapeBin,
                      skipped: true, platform: layout.platform,
                    })
                    return
                  }

                  // ① Python：候选按平台，真正解析 --version 校验 >= 3.10（§5.2 / §5.4）
                  const py = findPython()
                  if (!py) {
                    _jsonReply(res, 503, { ok: false, error: pythonMissingMessage() })
                    return
                  }
                  if (!py.ok) {
                    _jsonReply(res, 503, { ok: false, error: pythonTooOldMessage(py) })
                    return
                  }

                  // ② 目录 + venv：fs API 取代 shell 建目录 / shell 判文件存在
                  console.log(`[grape-dsh] installing grape CLI into ${layout.installDir} (python: ${py.bin}, ${py.version})`)
                  mkdirSync(layout.installDir, { recursive: true })
                  if (!existsSync(layout.venvPython)) {
                    const mk = runLocal(py.bin, ['-m', 'venv', layout.venvDir], 60000)
                    if (!mk.ok) {
                      const detail = (mk.stderr.trim() || mk.error || `exit code ${mk.status ?? 'null'}`).slice(0, 300)
                      _jsonReply(res, 503, { ok: false, error: `Failed to create venv: ${detail}` })
                      return
                    }
                  }
                  if (!existsSync(layout.venvPip)) {
                    _jsonReply(res, 503, { ok: false, error: `venv 缺少 pip：${layout.venvPip}` })
                    return
                  }

                  // ③ pip install：数组传参，不经 shell（Windows 是 pip.exe）
                  const ins = runLocal(layout.venvPip, ['install', '--quiet', '--no-cache-dir', tarballUrl], 180000)
                  if (!ins.ok) {
                    const detail = (ins.stderr.trim() || ins.error || `exit code ${ins.status ?? 'null'}`).slice(0, 400)
                    _jsonReply(res, 500, { ok: false, error: `pip install failed: ${detail}` })
                    return
                  }

                  // ④ POSIX：fs.symlinkSync 暴露到 PATH（取代 shell 软链）；Windows 用 Scripts\ 目录，无软链
                  if (layout.linkPath) {
                    try {
                      if (!existsSync(layout.linkPath)) symlinkSync(layout.grapeBin, layout.linkPath)
                    } catch (e) {
                      console.warn(`[grape-dsh] grape CLI symlink skipped (${layout.linkPath}): ${String(e)}`)
                    }
                  }

                  // ⑤ 验证：装完必须能跑起来才算成功
                  const ver = runLocal(layout.grapeBin, ['--version'])
                  if (!ver.ok || !ver.stdout.trim()) {
                    const detail = (ver.stderr.trim() || ver.error || `exit code ${ver.status ?? 'null'}`).slice(0, 300)
                    _jsonReply(res, 500, { ok: false, error: `installed but version check failed: ${detail}` })
                    return
                  }
                  installedGrapeBin = layout.grapeBin
                  const version = ver.stdout.trim()
                  console.log(`[grape-dsh] grape CLI installed: ${version} (${layout.grapeBin})`)
                  _jsonReply(res, 200, {
                    ok: true, version, path: layout.grapeBin,
                    python: py.version, platform: layout.platform,
                  })
                } catch (err) {
                  console.warn(`[grape-dsh] grape CLI install failed: ${String(err)}`)
                  _jsonReply(res, 500, { ok: false, error: `Install failed: ${String(err instanceof Error ? err.message : err)}` })
                }
                return
              }

              // POST /onboard → 幂等状态机（已安装一律不安装；只有「未安装初始化 / 同设备名重建(需确认)」才写）
              //
              // 🔴 事故防线：`installed=true` 的分支绝不调用安装器、绝不上签发凭据。
              // 状态机见 worker-onboard.decideOnboard；写路径统一走 runOnboardTransaction
              // （失败按本次 created.id 撤销）。
              if (method === 'POST' && url.startsWith('/grape-worker-api/onboard')) {
                // 进程内互斥：双击 / 双标签 / 客户端超时重试并发进入时，两次 readLocalWorker
                // 都读不到安装 → 两次 mint + 两次安装（后者覆盖 runtime.env）→ 两条凭据、
                // 两个 runtime_id（正是事故形态）。在途时直接返回，复用首次结果。
                if (onboardInFlight) {
                  _jsonReply(res, 409, {
                    ok: false,
                    inFlight: true,
                    error: '接入请求正在处理中，请等待当前请求完成后再试。',
                  })
                  return
                }
                const onboardTask = (async () => {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const local = readLocalWorker()
                  // 未安装时按「即将创建的默认名」查重：同名凭据已存在就报冲突，不重复造身份
                  const auth = workerApiAuth()
                  // 目标设备名：config.deviceName（显式意图，可跨环境不同）→ 本机 runtime.env → dsh-<host>
                  // ⚠️ 查询与签发/安装必须用同一个名字。原来「用 config 名查服务端、用 runtime.env 名去装」，
                  //   会出现「判定成 initialize、实际按旧名签发」：撞同名凭据 / 身份又回到旧值。
                  const configuredName = sanitizeDeviceName(readConfigField<string>(config?.deviceName, ''))
                  const targetName = resolveOnboardDeviceName(configuredName, local.deviceName)
                  const server = await readServerState(auth, targetName)
                  // 判定：本环境有没有这台设备 + **服务地址是否一致**（不一致 = 本环境视同没有 worker）
                  const decision = decideOnboard(local, server, { baseUrl: auth.baseUrl })
                  // 目标名 ≠ 本机 runtime.env：本次接入会改名（改名必须先停掉旧进程，见下方护栏）
                  const renamePending = Boolean(local.deviceName) && local.deviceName !== targetName
                  const facts = {
                    action: decision.action,
                    message: decision.message,
                    deviceName: local.deviceName,
                    configuredDeviceName: configuredName,
                    targetDeviceName: targetName,
                    renamePending,
                    installed: local.installed,
                    running: local.running,
                    processAlive: local.running,
                    source: local.source,
                    readError: local.readError,
                  }
                  if (decision.action === 'read-error') {
                    _jsonReply(res, decision.status, { ok: false, ...facts, error: decision.message })
                    return
                  }
                  if (decision.action === 'already-connected') {
                    // 服务端登记的是目标名，而本机 runtime.env 还是旧名：直接放过去，本机会以旧身份上线
                    if (renamePending) {
                      const guidance = `服务端已登记设备 ${targetName}，但本机 runtime.env 记录的是 ${local.deviceName}；`
                        + `请先「注销本机」清掉旧身份，再「接入本机」按 ${targetName} 重新签发凭据。`
                      _jsonReply(res, 409, { ok: false, ...facts, renameBlocked: true, message: guidance, error: guidance })
                      return
                    }
                    _jsonReply(res, decision.status, { ok: true, ...facts, noop: true })
                    return
                  }
                  if (decision.action === 'conflict') {
                    _jsonReply(res, decision.status, { ok: false, ...facts, error: decision.message })
                    return
                  }
                  // 改名护栏：runtime.env 一旦被安装器覆盖，仍在跑的旧进程会用旧 env/旧 token 继续心跳，
                  // 服务端就会出现「新名在线 + 旧名也活着」的双身份。必须先停旧进程再接入。
                  if (decision.action === 'initialize' && local.running && renamePending) {
                    const guidance = `本机 worker 正在以 ${local.deviceName} 运行，配置要求 ${targetName}；`
                      + '请先点「注销本机」（会吊销旧凭据并停止本机 worker），再点「接入本机」按配置的设备名注册。'
                    _jsonReply(res, 409, { ok: false, ...facts, renameBlocked: true, message: guidance, error: guidance })
                    return
                  }
                  // initialize / server-mismatch：credential 事务化（create → install → verify → 失败撤销）
                  if (auth.error) {
                    _jsonReply(res, 503, { ok: false, ...facts, error: auth.error })
                    return
                  }
                  // 目标名已在上方按「config → runtime.env → dsh-<host>」一次算好（targetName），
                  // 这里不再另算：server-mismatch 与 initialize 共用同一个名字，避免查询/安装不一致。
                  onboardProgress = { stage: 'mint', startedAt: Date.now(), lines: [] }
                  // 本环境里可能还留着同名的旧凭据行（换环境后 token 已作废）：先吊销再签发，
                  // 否则 mint 会撞「凭据名称已存在（全局唯一）」。
                  // 吊销失败（已被删/并发/网络）不阻断重装：mint 若真撞名会自己报错，用户仍能看到原因。
                  if (decision.action === 'server-mismatch' && server.credential?.id) {
                    try {
                      await revokeCredential(
                        { baseUrl: auth.baseUrl, token: auth.token, timeout: readConfigField<number>(config?.timeout, 30) },
                        server.credential.id,
                      )
                      console.log(`[grape-dsh] onboard(server-mismatch): 已吊销本环境旧凭据 #${server.credential.id}`)
                    }
                    catch (err) {
                      console.warn(`[grape-dsh] onboard(server-mismatch): 吊销旧凭据 #${server.credential.id} 失败，继续尝试签发：${String(err)}`)
                    }
                  }
                  let result
                  try {
                    result = await runOnboardTransaction({
                      deviceName: targetName,
                      mint: (name) => mintCredential(
                        { baseUrl: auth.baseUrl, token: auth.token, timeout: readConfigField<number>(config?.timeout, 30) },
                        name,
                      ),
                      install: async (token, device) => {
                        // 执行用命令不把 token 拼进命令行（避免进程列表可见），改由环境变量传入
                        const installCmd = workerInstallCommandWithEnv(auth.baseUrl, token, device, detectHostInfo(), auth.baseUrl)
                        console.log(`[grape-dsh] onboard: ${decision.action} → install worker device=${device}`)
                        setOnboardStage('install')
                        // 异步流式执行（见 install-command.ts 注释）：不能再用 execFileSync 阻塞事件循环，
                        // 否则安装期间面板的 /check 全部挂起，表现为「正在检查接入状态…」假死。
                        await runWorkerInstallCommand(installCmd.command, { onLine: pushOnboardLine, env: installCmd.env })
                      },
                      verify: async (credentialId, device) => {
                        setOnboardStage('verify')
                        return verifyDeviceOnline(auth, credentialId, device)
                      },
                      revoke: (id) => revokeCredential(
                        { baseUrl: auth.baseUrl, token: auth.token, timeout: readConfigField<number>(config?.timeout, 30) },
                        id,
                      ),
                      // mint 超时/中断后按唯一名称回查，撤掉可能已建出的孤儿凭据
                      lookup: async (name) => {
                        const creds = await listCredentials({
                          baseUrl: auth.baseUrl,
                          token: auth.token,
                          timeout: readConfigField<number>(config?.timeout, 30),
                        })
                        return creds.find((c) => c.name === name) ?? null
                      },
                      log: (m) => console.log(`[grape-dsh] ${m}`),
                    })
                  }
                  finally {
                    onboardProgress = null
                  }
                  console.log(`[grape-dsh] onboard: ${decision.action} ok credential=#${result.credentialId} (${result.credentialName}) device=${targetName} online=${result.online} pending=${result.pending}`)
                  credsCache = null
                  serverDevicesCache = null
                  _jsonReply(res, 200, {
                    ok: true,
                    ...facts,
                    deviceName: targetName,
                    credentialId: result.credentialId,
                    credentialName: result.credentialName,
                    online: result.online,
                    pending: result.pending,
                  })
                } catch (err) {
                  console.warn(`[grape-dsh] onboard failed: ${String(err)}`)
                  _jsonReply(res, 502, { ok: false, error: String(err instanceof Error ? err.message : err) })
                }
                })()
                onboardInFlight = onboardTask
                try {
                  await onboardTask
                } finally {
                  if (onboardInFlight === onboardTask) onboardInFlight = null
                }
                return
              }

              // POST /ensure-worker → 静默拉起（面板打开/刷新调用）
              //
              // 为什么单独一条路由而不是塞进 GET /check：`/check` 必须严格只读（M1），
              // 带副作用会让「探测」变成「实施」，探针也不再可测。
              // 护栏（M3）：同一进程 5 分钟/设备最多 1 次；code 42 与用户停止后本进程内不再拉起。
              if (method === 'POST' && url.startsWith('/grape-worker-api/ensure-worker')) {
                try {
                  const local = readLocalWorker()
                  const key = autoStartKey(local)
                  const auth = workerApiAuth()
                  // 环境隔离（2026-11-20 用户要求）：地址对不上 = 本环境没有 worker，
                  // 绝不静默拉起一个连到别的环境的进程。
                  if (local.installed && serverUrlMismatch(local.serverUrl, auth.baseUrl)) {
                    _jsonReply(res, 200, {
                      ok: true,
                      started: false,
                      reason: 'state:server-mismatch',
                      serverMismatch: true,
                      deviceName: local.deviceName,
                      localServerUrl: local.serverUrl,
                      configuredServerUrl: auth.baseUrl,
                      processAlive: local.running,
                    })
                    return
                  }
                  // 改名待办：本机 runtime.env 还是旧名，静默拉起只会把旧身份重新挂上线 —— 不拉，
                  // 让用户先走「接入本机」（会按 config 的设备名重写 runtime.env + 重新签发凭据）。
                  const configuredName = sanitizeDeviceName(readConfigField<string>(config?.deviceName, ''))
                  const targetName = resolveOnboardDeviceName(configuredName, local.deviceName)
                  if (local.deviceName && targetName !== local.deviceName) {
                    _jsonReply(res, 200, {
                      ok: true,
                      started: false,
                      reason: 'state:rename-pending',
                      deviceName: local.deviceName,
                      configuredDeviceName: configuredName,
                      targetDeviceName: targetName,
                      processAlive: local.running,
                    })
                    return
                  }
                  // 与服务端设备行对账（只读、失败不影响本地结论）
                  let serverDevice: CachedServerDevice | null = null
                  if (!auth.error && local.deviceName) {
                    try {
                      const now = Date.now()
                      const devices = serverDevicesCache && now - serverDevicesCache.at < SERVER_DEVICE_CACHE_TTL_MS
                        ? serverDevicesCache.data
                        : await listServerDevices(auth)
                      if (!serverDevicesCache || now - serverDevicesCache.at >= SERVER_DEVICE_CACHE_TTL_MS) {
                        serverDevicesCache = { at: now, data: devices }
                      }
                      serverDevice = devices.find((d) => d.device_name === local.deviceName) ?? null
                    } catch { /* 补全失败不影响拉起护栏 */ }
                  }
                  const classification = classifyWorkerState({
                    local,
                    server: serverDevice,
                    probe: { failed: local.probeFailed, method: local.probe.method, ok: local.probe.ok },
                    throttle: autoStartStatus(key),
                    expected: { serverUrl: auth.baseUrl },
                  })
                  // 只有状态机明确 canAutoStart 才看节流；否则（服务端在线/探测失败/进程在跑）直接拒绝
                  const decision = classification.canAutoStart
                    ? shouldAutoStartWorker({
                      key,
                      installed: local.installed,
                      running: local.running,
                      readError: local.readError,
                      probeFailed: local.probeFailed,
                      survivingProcesses: local.processes.length,
                    })
                    : { start: false, reason: `state:${classification.state}` }
                  if (!decision.start) {
                    _jsonReply(res, 200, {
                      ok: true,
                      started: false,
                      reason: decision.reason,
                      deviceName: local.deviceName,
                      processAlive: local.running,
                      workerState: classification,
                    })
                    return
                  }
                  const started = startLocalWorker(layoutForFacts(local), undefined, (code) => watchWorkerExit(key, code))
                  const startRecord = recordWorkerStart(
                    key,
                    started,
                    { deviceName: local.deviceName, serverUrl: local.serverUrl || auth.baseUrl },
                    serverDevice,
                  )
                  console.log(`[grape-dsh] ensure-worker: key=${key} started=${started.started} reason=${decision.reason}${started.error ? ` error=${started.error}` : ''}`)
                  _jsonReply(res, started.started ? 200 : 502, {
                    ok: started.started,
                    started: started.started,
                    reason: decision.reason,
                    deviceName: local.deviceName,
                    pid: started.pid,
                    error: started.error,
                    workerState: classification,
                    lastStart: startRecord,
                  })
                } catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err) })
                }
                return
              }

              // POST /worker-control → 手动启动 / 重启本机 worker（面板「刷新 / 启动 / 重启」用）
              //
              // 与 /ensure-worker 的分工：
              //   · /ensure-worker 是「静默自动拉起」——带 5 分钟节流，只允许状态机判定的 canAutoStart；
              //   · 本路由是**用户显式动作**——「已安装未启动」时直接拉起，运行中时重启，不受节流限制。
              // 重启实现：杀掉当前 worker 进程，`start-worker.ps1` 守护循环会在 5s 内重新拉起；
              // 若 12s 内没回来（守护进程也不在了），再直接 startLocalWorker 兜底，避免「重启完变没进程」。
              if (method === 'POST' && url.startsWith('/grape-worker-api/worker-control')) {
                try {
                  const body = (await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })) as { action?: string }
                  const action = String(body?.action || 'start')
                  const local = readLocalWorker()
                  // 环境隔离：本机 worker 连的是别的环境时，禁止在这里启动/重启它 ——
                  // 启动只会让「串线」继续，用户看到的面板状态仍然不可信。必须重新接入。
                  const controlAuth = workerApiAuth()
                  if (local.installed && serverUrlMismatch(local.serverUrl, controlAuth.baseUrl)) {
                    const configured = controlAuth.baseUrl
                    _jsonReply(res, 409, {
                      ok: false,
                      serverMismatch: true,
                      error: `本机 worker 属于 ${local.serverUrl || '未知环境'}，与插件配置的 ${configured} 不一致；`
                        + '本环境视同没有 Worker，请先「接入本机」重新安装（不会替你启动别的环境的 worker）。',
                    })
                    return
                  }
                  // 改名待办：启动/重启只会拿 runtime.env 里的旧名字上线；必须先「注销本机」再「接入本机」
                  const configuredName = sanitizeDeviceName(readConfigField<string>(config?.deviceName, ''))
                  const targetName = resolveOnboardDeviceName(configuredName, local.deviceName)
                  if (local.deviceName && targetName !== local.deviceName) {
                    const guidance = `配置的设备名是 ${targetName}，本机 runtime.env 记录的是 ${local.deviceName}；`
                      + '启动/重启会按旧名上线。请先「注销本机」，再「接入本机」按配置名重新注册。'
                    _jsonReply(res, 409, {
                      ok: false,
                      renameBlocked: true,
                      deviceName: local.deviceName,
                      configuredDeviceName: configuredName,
                      targetDeviceName: targetName,
                      message: guidance,
                      error: guidance,
                    })
                    return
                  }
                  const key = autoStartKey(local)
                  const killed: number[] = []
                  if (action === 'restart' && local.processes.length) {
                    for (const proc of local.processes) {
                      try {
                        process.kill(proc.pid, 'SIGTERM')
                        killed.push(proc.pid)
                      }
                      catch { /* 已经退出 */ }
                    }
                    const deadline = Date.now() + 12000
                    while (Date.now() < deadline) {
                      await new Promise((resolve) => setTimeout(resolve, 1000))
                      if (readLocalWorker().processes.length) {
                        _jsonReply(res, 200, {
                          ok: true, action, restarted: true, killed,
                          processAlive: true, deviceName: local.deviceName,
                        })
                        return
                      }
                    }
                  }
                  if (action === 'start' && local.processes.length) {
                    _jsonReply(res, 200, {
                      ok: true, action, alreadyRunning: true, processAlive: true, deviceName: local.deviceName,
                    })
                    return
                  }
                  const started = startLocalWorker(layoutForFacts(local), undefined, (code) => watchWorkerExit(key, code))
                  const startRecord = recordWorkerStart(
                    key,
                    started,
                    { deviceName: local.deviceName, serverUrl: local.serverUrl || '' },
                    null,
                  )
                  console.log(`[grape-dsh] worker-control: action=${action} killed=${killed.length} started=${started.started}${started.error ? ` error=${started.error}` : ''}`)
                  _jsonReply(res, started.started ? 200 : 502, {
                    ok: started.started,
                    action,
                    killed,
                    restarted: false,
                    started: started.started,
                    pid: started.pid,
                    error: started.error,
                    deviceName: local.deviceName,
                    lastStart: startRecord,
                  })
                }
                catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err) })
                }
                return
              }

              // POST /revoke → 注销（吊销凭据 + 停本地 worker 服务）
              if (method === 'POST' && url.startsWith('/grape-worker-api/revoke')) {
                try {
                  const cid = (await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })).cid
                  if (!cid) {
                    _jsonReply(res, 400, { ok: false, error: 'missing cid' })
                    return
                  }
                  // 吊销优先走服务端 API（与接入时签发/回滚同一实现）。
                  // 但没有插件 API Key 的 CLI-only 部署（CLI 登录即可收发凭据命令）也必须能注销本机，
                  // 因此 auth.error 时回落到 `grape settings runtime credential revoke --cid`。
                  const auth = workerApiAuth()
                  if (auth.error) {
                    const bin = localGrapeBin(config)
                    const cli = runLocal(bin, ['settings', 'runtime', 'credential', 'revoke', '--cid', String(cid)], 30000)
                    if (!cli.ok) {
                      const detail = (cli.stderr.trim() || cli.error || `exit code ${cli.status ?? 'null'}`).slice(0, 200)
                      _jsonReply(res, 503, {
                        ok: false,
                        error: `${auth.error}；CLI 兜底吊销也失败：${detail}`,
                      })
                      return
                    }
                    console.log(`[grape-dsh] revoke fallback via CLI: cid=${cid}`)
                  } else {
                    try {
                      await revokeCredential(auth, Number(cid))
                    } catch (e) {
                      _jsonReply(res, 502, { ok: false, error: `revoke failed: ${String(e instanceof Error ? e.message : e)}` })
                      return
                    }
                  }
                  // 用户显式停止 → 本进程内不再自动拉起（M3 第 ③ 条）
                  const facts = readLocalWorker()
                  blockAutoStart(autoStartKey(facts), 'user-stopped')
                  // 停本机 worker：平台分支（Linux 服务管理器 / Windows sc→Stop-Service），两侧都容错（R6）
                  try {
                    const stop = stopRuntimeAgent()
                    if (stop && !stop.ok) {
                      const detail = (stop.stderr.trim() || stop.error || `exit code ${stop.status ?? 'null'}`).slice(0, 200)
                      console.warn(`[grape-dsh] stop runtime-agent skipped: ${detail}`)
                    }
                  } catch (e) {
                    console.warn(`[grape-dsh] stop runtime-agent failed: ${String(e)}`)
                  }
                  // 守护进程形态（Windows `start-worker.ps1` + python）下 `sc stop runtime-agent` 是空转，
                  // 不能只靠 worker 自己收到 401 才退出（卡在长任务里会留下「凭据已吊销、进程还在跑」）。
                  // 这里直接按 PID 终止：被杀后守护脚本会重启一份，新进程拿到 401 会 exit 42 → 守护随之退出。
                  const killed: number[] = []
                  for (const proc of facts.processes) {
                    try {
                      process.kill(proc.pid, 'SIGTERM')
                      killed.push(proc.pid)
                    }
                    catch { /* 已经退出 */ }
                  }
                  let workerStopped = facts.processes.length === 0
                  const stopDeadline = Date.now() + 15000
                  while (!workerStopped && Date.now() < stopDeadline) {
                    await new Promise((resolve) => setTimeout(resolve, 1000))
                    workerStopped = readLocalWorker().processes.length === 0
                  }
                  console.log(`[grape-dsh] credential ${cid} revoked; worker killed=${killed.length} stopped=${workerStopped}`)
                  if (!workerStopped) {
                    console.warn('[grape-dsh] revoke: worker 进程 15s 内未退出，可能仍在跑（可点「刷新」复查）')
                  }
                  // 注销后清掉本机接入 token：否则 /check 仍报 tokenPresent=true，
                  // 面板会显示「已安装未启动」并给出「启动 Worker」——那份 rta 已被吊销，
                  // 点下去必然 401 → exit 42，用户观感是"刚注销完又坏了"。
                  // 只清 RUNTIME_TOKEN，保留 SERVER_URL/DEVICE_NAME，重新接入时直接覆盖。
                  let tokenCleared = false
                  try {
                    const { readFileSync, writeFileSync } = await import('node:fs')
                    const envFile = layoutForFacts(facts).envFile
                    const text = readFileSync(envFile, 'utf-8')
                    const next = text.split(/\r?\n/).filter((line) => !/^\s*RUNTIME_TOKEN\s*=/.test(line)).join('\n')
                    if (next !== text) {
                      writeFileSync(envFile, next.endsWith('\n') ? next : `${next}\n`, { encoding: 'utf-8', mode: 0o600 })
                      tokenCleared = true
                      console.log(`[grape-dsh] revoke: cleared RUNTIME_TOKEN in ${envFile}`)
                    }
                  }
                  catch (e) {
                    console.warn(`[grape-dsh] revoke: clear RUNTIME_TOKEN failed: ${String(e)}`)
                  }
                  credsCache = null
                  serverDevicesCache = null
                  _jsonReply(res, 200, { ok: true, tokenCleared, killed, workerStopped })
                } catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err) })
                }
                return
              }

              // ── 接管（takeover）：服务端一等资源，插件只做本地化 ──────────────────
              // 服务端 POST /api/takeover/sessions 原子完成：找任务 → cancel → 事件标 takeover
              // → 签发 tko_ → 组装 bundle（env / 技能整包 / 项目知识 / 历史 / prompt）。
              // 插件只做三件事：物化资产到工作区、登记 workspace、把 prompt 交给前端。
              // 旧实现（context+cancel+mark 三段 + curl + GRAPE_AUTH_FILE）已全部移除。

              // 本地会话 id 回写（面板"打开本地会话"用）
              if (method === 'POST' && url.startsWith('/grape-worker-api/takeover-attach')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const tid = String(body.takeover_id || '')
                  const cs = String(body.client_session || '')
                  if (!tid || !cs) {
                    _jsonReply(res, 400, { ok: false, error: 'missing takeover_id or client_session' })
                    return
                  }
                  // legacy 接管没有服务端 attach 端点：直接回本地已登记的 workspace，
                  // 否则接管刚成功面板就会拿到裸 404。
                  const localAttach = legacyAttachReply(tid, cs, legacyWorkspaces.get(tid))
                  if (localAttach) {
                    console.log(`[grape-dsh] takeover: attach ${tid} local-only ws=${localAttach.body.workspace_id || '(none)'}`)
                    _jsonReply(res, localAttach.status, localAttach.body)
                    return
                  }
                  const { hostname } = await import('node:os')
                  const api = await grapeApiCall(resolved, 'POST',
                    `/api/takeover/sessions/${encodeURIComponent(tid)}/attach`,
                    { client_session: cs, host: String(body.host || hostname()), client_version: '' })
                  console.log(`[grape-dsh] takeover: attach ${tid} session=${cs} -> HTTP ${api.status}`)
                  _jsonReply(res, api.status, api.data)
                } catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) })
                }
                return
              }

              // 手动重新派发某个事件（节点 failed/cancelled 时的补救入口）
              if (method === 'POST' && url.startsWith('/grape-worker-api/event-redispatch')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const seq = Number(body.seq || 0)
                  if (!seq) {
                    _jsonReply(res, 400, { ok: false, error: 'missing seq' })
                    return
                  }
                  // 接管期间禁止派发（与服务端同一规则）：先给可读原因，别让面板显示 already_taken_over
                  const guard = await redispatchTakeoverGuard(resolved, seq)
                  if (guard.blocked) {
                    console.log(`[grape-dsh] event-redispatch seq=${seq} blocked: takeover active`)
                    _jsonReply(res, guard.status, guard.body)
                    return
                  }
                  const api = await grapeApiCall(resolved, 'POST',
                    `/api/events/${seq}/redispatch`, {}, 30000)
                  console.log(`[grape-dsh] event-redispatch seq=${seq} -> HTTP ${api.status}`)
                  const mapped = mapRedispatchReply(api)
                  _jsonReply(res, mapped.status, mapped.body)
                } catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) })
                }
                return
              }

              // agent 提交完成申请（内容落库；推进仍由用户点 finish）
              if (method === 'POST' && url.startsWith('/grape-worker-api/takeover-request-finish')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const tid = String(body.takeover_id || '')
                  if (!tid) {
                    _jsonReply(res, 400, { ok: false, error: 'missing takeover_id' })
                    return
                  }
                  // 旧服务端无 request-finish 端点：本地短路，避免上报链路刷 404。
                  const localRequestFinish = legacyEndpointReply('request-finish', tid)
                  if (localRequestFinish) {
                    console.log(`[grape-dsh] takeover: request-finish ${tid} local-only (legacy protocol)`)
                    _jsonReply(res, localRequestFinish.status, localRequestFinish.body)
                    return
                  }
                  const api = await grapeApiCall(resolved, 'POST',
                    `/api/takeover/sessions/${encodeURIComponent(tid)}/request-finish`, {
                      summary: String(body.summary || ''),
                      evidence: String(body.evidence || ''),
                      files_written: Array.isArray(body.files_written) ? body.files_written : [],
                    }, 20000)
                  console.log(`[grape-dsh] takeover: request-finish ${tid} -> HTTP ${api.status}`)
                  _jsonReply(res, api.status, api.data)
                } catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) })
                }
                return
              }

              // 本地会话是否还在（面板据决定「打开接管会话」还是露出「恢复接管会话」）。
              // 只看磁盘：DSH 删会话后侧栏可能残留旧行，不能拿 DOM 有没有行当存在依据。
              if (method === 'POST' && url.startsWith('/grape-worker-api/session-exists')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const sid = String(body.session_id || '').trim()
                  if (!sid) {
                    _jsonReply(res, 400, { ok: false, error: 'missing session_id' })
                    return
                  }
                  const fsMod = await import('node:fs')
                  const pathMod = await import('node:path')
                  const osMod = await import('node:os')
                  const dirName = sid.startsWith('session-') ? sid : `session-${sid}`
                  const root = pathMod.join(osMod.homedir(), '.dsh', 'sessions')
                  // 默认按「存在」处理：扫描失败（权限/自定义 DSH_HOME/目录暂不可读）不能把
                  // 还活着的会话误判成已删除 —— 那会让面板错误露出「恢复接管会话」并拒绝打开。
                  let exists = true
                  let dir = ''
                  let scanned = false
                  try {
                    exists = false
                    for (const d of await fsMod.promises.readdir(root)) {
                      if (fsMod.existsSync(pathMod.join(root, d, dirName))) { exists = true; dir = d; break }
                    }
                    scanned = true
                  } catch { exists = true }
                  _jsonReply(res, 200, { ok: true, exists, dir, scanned })
                } catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) })
                }
                return
              }

              // 面板「接管中」状态来源（服务端）：刷新/换标签后不依赖 localStorage
              if (method === 'POST' && url.startsWith('/grape-worker-api/takeover-list')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const repo = String(body.repo || '')
                  const issue = String(body.issue || '')
                  if (!repo) {
                    _jsonReply(res, 400, { ok: false, error: 'missing repo' })
                    return
                  }
                  // 平台透传（Gitee 的 owner/repo 不能落到 GitCode 的同名仓库）；
                  // 旧客户端不带 platform → 缺省 gitcode，行为不变。
                  const repoKey = repoKeyFor(body.platform, repo)
                  const qs = new URLSearchParams({ repo_key: repoKey, status: 'active' })
                  if (issue) qs.set('issue_id', issue)
                  const api = await grapeApiCall(resolved, 'GET',
                    `/api/takeover/sessions?${qs.toString()}`)
                  _jsonReply(res, api.status, api.data)
                } catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) })
                }
                return
              }

              // 前端接管流程的落点日志（浏览器 console 不方便取时，从这里进 journalctl）
              if (method === 'POST' && url.startsWith('/grape-worker-api/takeover-log')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  console.log(`[grape-dsh] takeover-log: ${JSON.stringify(body).slice(0, 900)}`)
                  _jsonReply(res, 200, { ok: true })
                } catch (err) {
                  _jsonReply(res, 200, { ok: false, error: String(err) })
                }
                return
              }

              // 进展上报（把本地会话做了什么写回平台日志，actor=当前用户）
              if (method === 'POST' && url.startsWith('/grape-worker-api/takeover-progress')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const tid = String(body.takeover_id || '')
                  if (!tid) {
                    _jsonReply(res, 400, { ok: false, error: 'missing takeover_id' })
                    return
                  }
                  // 旧服务端无 progress 端点：本地短路，避免每次上报都打 404。
                  const localProgress = legacyEndpointReply('progress', tid)
                  if (localProgress) {
                    _jsonReply(res, localProgress.status, localProgress.body)
                    return
                  }
                  const api = await grapeApiCall(resolved, 'POST',
                    `/api/takeover/sessions/${encodeURIComponent(tid)}/progress`,
                    { messages: body.messages || [], summary: String(body.summary || '') })
                  _jsonReply(res, api.status, api.data)
                } catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) })
                }
                return
              }

              // 结束本节点（默认派发下一节点；handoff='none' 只标记完成）
              if (method === 'POST' && url.startsWith('/grape-worker-api/takeover-finish')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const tid = String(body.takeover_id || '')
                  if (!tid) {
                    _jsonReply(res, 400, { ok: false, error: 'missing takeover_id' })
                    return
                  }
                  // 旧服务端无 finish 端点、也不认 legacy:<task_id>：本地明确告知只能到平台手动推进，
                  // 不能伪报「已确认完成」。
                  const localFinish = legacyEndpointReply('finish', tid)
                  if (localFinish) {
                    console.log(`[grape-dsh] takeover: finish ${tid} local-only (legacy protocol)`)
                    takeoverCwds.delete(tid)
                    legacyWorkspaces.delete(tid)
                    _jsonReply(res, localFinish.status, localFinish.body)
                    return
                  }
                  // 自动补交接内容（面板只点按钮，不手填）：本地会话最后一条 assistant 文本
                  // + 仓库改动清单。用户/agent 显式给了值就以显式值为准。
                  let summary = String(body.summary || '')
                  let evidence = String(body.evidence || '')
                  let filesWritten = Array.isArray(body.files_written) ? (body.files_written as string[]) : []
                  let actions = Array.isArray(body.actions) ? (body.actions as string[]) : []
                  let artifacts = Array.isArray(body.artifacts) ? (body.artifacts as string[]) : []
                  let issueSummary = String(body.issue_summary || '')
                  if (!summary || !filesWritten.length || !actions.length || !artifacts.length) {
                    const cwd = await resolveTakeoverCwdLocal(resolved, tid, String(body.workspace_cwd || ''))
                    if (cwd) {
                      const collected = await collectFinishArtifacts(cwd)
                      summary = summary || collected.summary
                      evidence = evidence || collected.evidence
                      filesWritten = filesWritten.length ? filesWritten : collected.files
                      actions = actions.length ? actions : collected.actions
                      artifacts = artifacts.length ? artifacts : collected.artifacts
                      // 结构化结论：把"改了哪些文件/提交了什么"提炼成一句话小结（没有 agent 手写的就用它）
                      issueSummary = issueSummary || (collected.files.length
                        ? `本次接管改动 ${collected.files.length} 个文件：${collected.files.slice(0, 5).join(', ')}`
                        : '')
                      console.log(`[grape-dsh] takeover: finish collect summary=${summary.length}chars ` +
                        `evidence=${evidence.length}chars files=${filesWritten.length} ` +
                        `actions=${actions.length} artifacts=${artifacts.length} cwd=${cwd}`)
                    }
                  }
                  const api = await grapeApiCall(resolved, 'POST',
                    `/api/takeover/sessions/${encodeURIComponent(tid)}/finish`, {
                      outcome: String(body.outcome || 'completed'),
                      summary,
                      evidence,
                      files_written: filesWritten,
                      handoff: String(body.handoff || 'a2a'),
                      next_agent: String(body.next_agent || ''),
                      actions,
                      artifacts,
                      issue_summary: issueSummary,
                    }, 45000)
                  console.log(`[grape-dsh] takeover: finish ${tid} -> HTTP ${api.status} handoff=${String((api.data.handoff as Record<string, unknown> | undefined)?.ok ?? '')}`)
                  // 完成即这条接管生命周期结束：清掉本地映射，避免 takeoverCwds / legacyWorkspaces 单调增长
                  if (api.ok) {
                    takeoverCwds.delete(tid)
                    legacyWorkspaces.delete(tid)
                  }
                  _jsonReply(res, api.status, api.data)
                } catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) })
                }
                return
              }

              // 放弃接管（只停不重派）
              if (method === 'POST' && url.startsWith('/grape-worker-api/takeover-abort')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const tid = String(body.takeover_id || '')
                  if (!tid) {
                    _jsonReply(res, 400, { ok: false, error: 'missing takeover_id' })
                    return
                  }
                  // 旧服务端无 abort 端点：本地明确告知只能到平台手动处理，并清掉本地映射，
                  // 避免用户以为已放弃后卡片仍挂着这条接管。
                  const localAbort = legacyEndpointReply('abort', tid)
                  if (localAbort) {
                    console.log(`[grape-dsh] takeover: abort ${tid} local-only (legacy protocol)`)
                    takeoverCwds.delete(tid)
                    legacyWorkspaces.delete(tid)
                    _jsonReply(res, localAbort.status, localAbort.body)
                    return
                  }
                  const api = await grapeApiCall(resolved, 'POST',
                    `/api/takeover/sessions/${encodeURIComponent(tid)}/abort`,
                    { reason: String(body.reason || ''), redispatch: body.redispatch !== false })
                  const rd = (api.data as { redispatch?: { ok?: boolean; task_id?: string; status?: string } } | undefined)?.redispatch
                  console.log(`[grape-dsh] takeover: abort ${tid} -> HTTP ${api.status} ` +
                    `redispatch=${rd ? `${rd.ok ? 'ok' : 'fail'}:${rd.task_id || '-'}:${rd.status || '-'}` : 'none'}`)
                  // 明确放弃 ＝ 这条接管不会再用了：删掉已失效的 token 文件（env 文件留着方便回溯）。
                  // finish 不在这里删 —— 本地 agent 可能还在收尾，删了它的 grape CLI 会立刻 401；
                  // 由客户端停会话后再调 /takeover-release 回收。
                  if (api.ok) {
                    const cwd = await resolveTakeoverCwdLocal(resolved, tid, String(body.workspace_cwd || ''))
                    if (cwd) {
                      const rm = removeTakeoverToken(cwd)
                      if (rm.removed) console.log(`[grape-dsh] takeover: abort ${tid} removed token file (${cwd})`)
                    }
                    takeoverCwds.delete(tid)
                    legacyWorkspaces.delete(tid)
                  }
                  _jsonReply(res, api.status, api.data)
                } catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) })
                }
                return
              }

              // 接管收尾回收：客户端确认「本地会话已停 / 已空闲」后调这里，删掉失效的 token 文件。
              // 不能在 finish 里直接删：本地 agent 可能还在收尾，删了它的 grape CLI 立刻 401；
              // 而 finish 之后客户端会 cancel 会话，此时 token 已经没人用了，留着只会成为遗留凭据。
              if (method === 'POST' && url.startsWith('/grape-worker-api/takeover-release')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const tid = String(body.takeover_id || '')
                  if (!tid) {
                    _jsonReply(res, 400, { ok: false, error: 'missing takeover_id' })
                    return
                  }
                  const cwd = await resolveTakeoverCwdLocal(resolved, tid, String(body.workspace_cwd || ''))
                  const rm = removeTakeoverToken(cwd)
                  if (rm.removed) console.log(`[grape-dsh] takeover: release ${tid} removed token file (${cwd})`)
                  takeoverCwds.delete(tid)
                  legacyWorkspaces.delete(tid)
                  _jsonReply(res, 200, { ok: true, removed: rm.removed, cwd, error: rm.error || undefined })
                } catch (err) {
                  _jsonReply(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) })
                }
                return
              }

              // 开始接管：一次调用拿全量 bundle
              if (method === 'POST' && url.startsWith('/grape-worker-api/takeover')) {
                // 本次接管写入的 token 文件：失败路径由 finally 清掉，成功则交给本地 agent 使用。
                // 声明在 try 外，finally 才能读到（try 内声明在 finally 里不可见）。
                let stagedTokenFile = ''
                let takeoverReady = false
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const issueNumber = String(body.issue_number || '')
                  const repo = String(body.repo || '')
                  const agentType = String(body.agent_type || 'coding')
                  if (!issueNumber || !repo) {
                    _jsonReply(res, 400, { ok: false, error: 'missing issue_number or repo' })
                    return
                  }
                  const repoKey = repoKeyFor(body.platform, repo)
                  const { hostname } = await import('node:os')
                  const hostInfo = detectHostInfo()

                  // 鉴权：config 优先、env 兜底（R9）。缺 baseUrl / token 直接拒绝 ——
                  // 绝不把空 PRIVATE-TOKEN 发给服务端（分析文档 §5.8.3 ③）。
                  const auth = resolveApiAuth({
                    baseUrl: readConfigField<string>(config?.baseUrl, ''),
                    token: readConfigField<string>(config?.token, ''),
                  })
                  if (auth.error) {
                    _jsonReply(res, 503, { ok: false, code: 'not_configured', error: auth.error })
                    return
                  }
                  const takeoverAuth = { baseUrl: auth.baseUrl, token: auth.token }

                  /**
                   * 取数策略：主路径 POST /api/takeover/sessions（服务端按 host_os 渲染脚本与 prompt 措辞），
                   * 仅 404/405 回退旧接口 /api/runtime/issues/takeover-context，其余错误原样透传。
                   * deps.cfg 只传接管用的 { baseUrl, token }，不把整份 CLI config 交给取数模块。
                   */
                  const fetched = await fetchTakeoverBundle(
                    { cfg: takeoverAuth, apiCall: grapeApiCall, log: console.log, warn: console.warn },
                    {
                      repo,
                      repoKey,
                      issueNumber,
                      agentType,
                      host: hostname(),
                      hostOs: hostInfo.os,
                      hostArch: hostInfo.arch,
                      hostShell: hostInfo.shell,
                    },
                  )
                  if (!fetched.ok) {
                    // request_id 原样透传：平台 500 的日志用同一个值，用户/插件可直接引用
                    _jsonReply(res, fetched.status, {
                      ok: false,
                      code: fetched.code,
                      error: fetched.message,
                      ...(fetched.requestId ? { request_id: fetched.requestId } : {}),
                    })
                    return
                  }

                  const bundle = fetched.bundle as Record<string, any>
                  const takeoverId = fetched.takeoverId
                  const taskAgent = String(bundle?.task?.agent_type || agentType)
                  /**
                   * 平台给的是**远端 worker** 的任务目录（Linux 上 /root/grape-workspaces/...），
                   * 直接交给 dsh 的 workspaceRegistry 会因「不是完全限定路径」被拒（Windows 需要盘符），
                   * 于是 workspaceId 为空、前端不起会话。这里统一映射到本机工作区根下。
                   */
                  const remoteCwd = String(bundle?.workspace?.cwd_hint || bundle?.task?.cwd || '')
                  if (!takeoverId || !remoteCwd) {
                    _jsonReply(res, 500, { ok: false, error: 'bundle missing takeover_id or workspace.cwd_hint' })
                    return
                  }
                  const localized = localizeTakeoverCwd({
                    remoteCwd,
                    repo,
                    issueNumber,
                    agentType: taskAgent,
                    root: resolveTakeoverRoot({ env: process.env, home: homedir() }),
                    platform: (process.platform as 'win32' | 'darwin' | 'linux'),
                    exists: (p) => {
                      try { return existsSync(p) } catch { return false }
                    },
                  })
                  if (!localized.cwd) {
                    _jsonReply(res, 500, { ok: false, error: `无法确定本机工作区目录：${localized.note}` })
                    return
                  }
                  const taskCwd = localized.cwd
                  console.log(`[grape-dsh] takeover: cwd ${localized.source} ${localized.note}`)
                  const env = (bundle.env || {}) as Record<string, string>

                  // ① 工作区 + env 文件（0600，可 source）
                  const ws = await prepareTakeoverWorkspace(taskCwd, env)
                  stagedTokenFile = ws.tokenFile
                  if (ws.error) console.warn(`[grape-dsh] takeover: workspace prep: ${ws.error}`)

                  // ② 资产落盘：.skills/<skill>（SKILL.md + references/）+ project_info / knowledge
                  const assets = await materializeBundleAssets(taskCwd, bundle, hostInfo)
                  console.log(`[grape-dsh] takeover: assets ${assets.ok ? 'ok' : 'partial'} mode=${assets.skillMode} files=${assets.files} ${assets.error || ''}`)

                  // ③ 登记 workspace（session 由前端「New session in X」创建）
                  const wsLabel = `${repo.split('/').pop() ?? repo} #${issueNumber} ${taskAgent}`
                  const wsInfo = await ensureTakeoverWorkspace(taskCwd, wsLabel, workspaceRegistry)
                  takeoverCwds.set(takeoverId, taskCwd)
                  if (isLegacyTakeoverId(takeoverId)) {
                    legacyWorkspaces.set(takeoverId, { id: wsInfo.id, name: wsInfo.name })
                  }

                  const prompt = String(bundle?.instructions?.prompt || '')
                  if (!prompt) {
                    _jsonReply(res, 500, { ok: false, error: 'bundle.instructions.prompt 为空' })
                    return
                  }
                  const historyLen = Number(bundle?.history?.messages?.length || 0)

                  takeoverReady = true   // 到此接管已可用：token 文件交给本地 agent，不再回收

                  _jsonReply(res, 200, {
                    ok: true,
                    prompt,
                    takeoverId,
                    taskId: String(bundle?.task?.id || ''),
                    cancelOk: fetched.cancelOk,
                    cancelError: fetched.cancelError,
                    degraded: fetched.degraded,
                    notice: fetched.notice,
                    workspaceId: wsInfo.id,
                    workspaceName: wsInfo.name,
                    workspaceError: wsInfo.error,
                    workspaceCwd: taskCwd,
                    workspaceCwdSource: localized.source,
                    remoteCwd,
                    workspaceNotice: localized.note,
                    workspaceCreated: ws.created,
                    workspacePrepError: ws.error,
                    envFile: ws.envFile,
                    agentType: taskAgent,
                    issueNumber,
                    repo,
                    logLines: historyLen,
                    promptLen: prompt.length,
                    skillMode: assets.skillMode,
                    warnings: bundle?.warnings || [],
                  })
                  console.log(`[grape-dsh] takeover: ready ${takeoverId} issue=#${issueNumber} agent=${taskAgent} cwd=${taskCwd} skill=${assets.skillMode}files=${assets.files} msgs=${historyLen} cancel=${fetched.cancelOk} protocol=${fetched.degraded ? 'legacy' : 'server'} ws=${wsInfo.name || '(none)'}`)
                } catch (err) {
                  console.warn(`[grape-dsh] takeover failed: ${String(err)}`)
                  _jsonReply(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) })
                } finally {
                  // 失败兜底：接管没建起来就别把 token 留在盘上（成功时该文件交给本地 agent 使用）
                  if (!takeoverReady && stagedTokenFile) {
                    try {
                      const { rmSync } = await import('node:fs')
                      rmSync(stagedTokenFile, { force: true })
                      console.log(`[grape-dsh] takeover: removed token file after failed takeover (${stagedTokenFile})`)
                    } catch (e) {
                      console.warn(`[grape-dsh] takeover: remove token file failed: ${String(e)}`)
                    }
                  }
                }
                return
              }

              // POST /create-issue → 建 issue 并触发流水线（P1，Issue #40）
              //
              // 与 grape_create_issue 同源：`POST /api/issues/{owner}/{repo}` 的契约明确
              // 「creates the issue … and triggers the pipeline」（trigger_pipeline 默认 true），
              // 所以面板建完即可等首节点运行。4xx 原状态透传、5xx 收口成 502 + upstream_unavailable，
              // 用户看到的是可读原因而不是裸 HTTP 500。
              if (method === 'POST' && url.startsWith('/grape-worker-api/create-issue')) {
                try {
                  // 描述是用户正文：用 64KB 上限，避免稍长就被 4KB 截成 `{}`（那会误报「标题不能为空」）
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void }, 64 * 1024)
                  if (body.__tooLarge) {
                    // 超限要说「描述过长」，不能静默变空对象后误报「仓库 owner 格式不合法」
                    _jsonReply(res, 413, {
                      ok: false,
                      code: 'payload_too_large',
                      message: '提交内容过长（上限 64KB），请精简描述后重试',
                    })
                    return
                  }
                  const validated = validateCreateIssueInput(body)
                  if (!validated.ok) {
                    _jsonReply(res, 400, { ok: false, code: validated.code, message: validated.message })
                    return
                  }
                  const target = validated.value
                  const auth = resolveApiAuth({
                    baseUrl: readConfigField<string>(config?.baseUrl, ''),
                    token: readConfigField<string>(config?.token, ''),
                  })
                  if (auth.error) {
                    _jsonReply(res, 503, { ok: false, code: 'not_configured', message: auth.error })
                    return
                  }
                  // repo_key 必须带：平台按它决定去哪个代码平台解析 owner/repo，
                  // 缺省会退化成 GitCode → Gitee/GitLab 的同名仓库建单失败或串库。
                  const payload = buildCreateIssuePayload(target)
                  const api = await grapeApiCall(
                    { baseUrl: auth.baseUrl, token: auth.token },
                    'POST',
                    `/api/issues/${target.owner}/${target.repo}`,
                    payload,
                    45000,
                  )
                  if (!api.ok) {
                    const mapped = toCreateIssueError({ status: api.status, data: api.data, requestId: api.requestId })
                    console.log(`[grape-dsh] create-issue ${target.owner}/${target.repo} -> HTTP ${api.status} code=${String(mapped.body.code)}`)
                    _jsonReply(res, mapped.status, mapped.body)
                    return
                  }
                  const number = extractCreatedIssueNumber(api.data)
                  if (!number) {
                    // 建单已成功但拿不到编号：回 warning 让面板提示刷新，**绝不自动重建**
                    // （重建会在仓库里造出两条一模一样的需求）。
                    console.log(`[grape-dsh] create-issue ${target.owner}/${target.repo} -> ok but no issue number`)
                    _jsonReply(res, 200, {
                      ok: true,
                      number: '',
                      warning: 'no_issue_number',
                      message: '已创建但未拿到编号，请刷新列表',
                    })
                    return
                  }
                  console.log(`[grape-dsh] create-issue ${target.owner}/${target.repo} -> #${number}`)
                  _jsonReply(res, 200, { ok: true, number })
                } catch (err) {
                  // fetch 抛错（DNS / 连接被拒 / 超时）也走可读文案，不把异常栈丢给面板
                  console.warn(`[grape-dsh] create-issue failed: ${String(err)}`)
                  _jsonReply(res, 502, {
                    ok: false,
                    code: 'upstream_unavailable',
                    message: '创建需求失败（无法连接 Grape 服务）',
                  })
                }
                return
              }

              // ── POST /issue-start → 打开 issue 会话（预检，不翻转状态；Issue #42）──
              //
              // 卡片「进入对话」在 status 运行中时先调一次（失败**不阻断**打开深链）。
              // 409 = 已经启动过：按成功处理，前端继续打开聊天。
              if (method === 'POST' && url.startsWith('/grape-worker-api/issue-start')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const parsed = parseIssueActionId(body)
                  if (!parsed.ok) {
                    _jsonReply(res, 400, { ok: false, code: parsed.code, message: parsed.message })
                    return
                  }
                  const auth = resolveApiAuth({
                    baseUrl: readConfigField<string>(config?.baseUrl, ''),
                    token: readConfigField<string>(config?.token, ''),
                  })
                  if (auth.error) {
                    _jsonReply(res, 503, { ok: false, code: 'not_configured', message: auth.error })
                    return
                  }
                  const api = await grapeApiCall(
                    { baseUrl: auth.baseUrl, token: auth.token },
                    'POST',
                    `/api/issues/${parsed.id}/start`,
                    {},
                    30000,
                  )
                  if (!api.ok) {
                    if (isAlreadyStarted(api.status)) {
                      console.log(`[grape-dsh] issue-start #${parsed.id} -> 409 already started`)
                      _jsonReply(res, 200, { ok: true, already_started: true })
                      return
                    }
                    const mapped = toIssueActionError({ status: api.status, data: api.data, requestId: api.requestId })
                    console.log(`[grape-dsh] issue-start #${parsed.id} -> HTTP ${api.status} code=${String(mapped.body.code)}`)
                    _jsonReply(res, mapped.status, mapped.body)
                    return
                  }
                  console.log(`[grape-dsh] issue-start #${parsed.id} -> ok`)
                  _jsonReply(res, 200, { ok: true })
                } catch (err) {
                  console.warn(`[grape-dsh] issue-start failed: ${String(err)}`)
                  _jsonReply(res, 502, { ok: false, code: 'upstream_unavailable', message: '启动会话失败（无法连接 Grape 服务）' })
                }
                return
              }

              // ── POST /issue-confirm-done → 确认需求完成（Issue #42）──
              // confirmation 缺省补 user_confirmed（平台必填）；前端负责二次确认。
              if (method === 'POST' && url.startsWith('/grape-worker-api/issue-confirm-done')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const parsed = parseIssueActionId(body)
                  if (!parsed.ok) {
                    _jsonReply(res, 400, { ok: false, code: parsed.code, message: parsed.message })
                    return
                  }
                  const confirmation = typeof body.confirmation === 'string' && body.confirmation.trim()
                    ? body.confirmation.trim()
                    : 'user_confirmed'
                  const auth = resolveApiAuth({
                    baseUrl: readConfigField<string>(config?.baseUrl, ''),
                    token: readConfigField<string>(config?.token, ''),
                  })
                  if (auth.error) {
                    _jsonReply(res, 503, { ok: false, code: 'not_configured', message: auth.error })
                    return
                  }
                  const api = await grapeApiCall(
                    { baseUrl: auth.baseUrl, token: auth.token },
                    'POST',
                    `/api/issues/${parsed.id}/confirm-done`,
                    { confirmation },
                    45000,
                  )
                  if (!api.ok) {
                    const mapped = toIssueActionError({ status: api.status, data: api.data, requestId: api.requestId })
                    console.log(`[grape-dsh] issue-confirm-done #${parsed.id} -> HTTP ${api.status} code=${String(mapped.body.code)}`)
                    _jsonReply(res, mapped.status, mapped.body)
                    return
                  }
                  console.log(`[grape-dsh] issue-confirm-done #${parsed.id} -> ok`)
                  _jsonReply(res, 200, { ok: true })
                } catch (err) {
                  console.warn(`[grape-dsh] issue-confirm-done failed: ${String(err)}`)
                  _jsonReply(res, 502, { ok: false, code: 'upstream_unavailable', message: '确认完成失败（无法连接 Grape 服务）' })
                }
                return
              }

              // ── GET /issue-handoff-targets?id=<内部 id> → 可移交的流水线（Issue #42）──
              //
              // ⚠️ 必须用内部 id：实测拿 issue number 打 `/handoff/targets` 是 404。
              if (method === 'GET' && url.startsWith('/grape-worker-api/issue-handoff-targets')) {
                try {
                  const idParam = new URL(url, 'http://localhost').searchParams.get('id') ?? ''
                  const parsed = parseIssueActionId({ id: idParam })
                  if (!parsed.ok) {
                    _jsonReply(res, 400, { ok: false, code: parsed.code, message: parsed.message })
                    return
                  }
                  const auth = resolveApiAuth({
                    baseUrl: readConfigField<string>(config?.baseUrl, ''),
                    token: readConfigField<string>(config?.token, ''),
                  })
                  if (auth.error) {
                    _jsonReply(res, 503, { ok: false, code: 'not_configured', message: auth.error })
                    return
                  }
                  const api = await grapeApiCall(
                    { baseUrl: auth.baseUrl, token: auth.token },
                    'GET',
                    `/api/issues/${parsed.id}/handoff/targets`,
                    undefined,
                    30000,
                  )
                  if (!api.ok) {
                    const mapped = toIssueActionError({ status: api.status, data: api.data, requestId: api.requestId })
                    console.log(`[grape-dsh] issue-handoff-targets #${parsed.id} -> HTTP ${api.status} code=${String(mapped.body.code)}`)
                    _jsonReply(res, mapped.status, mapped.body)
                    return
                  }
                  _jsonReply(res, 200, { ok: true, scenes: projectHandoffTargets(api.data) })
                } catch (err) {
                  console.warn(`[grape-dsh] issue-handoff-targets failed: ${String(err)}`)
                  _jsonReply(res, 502, { ok: false, code: 'upstream_unavailable', message: '移交目标加载失败（无法连接 Grape 服务）' })
                }
                return
              }

              // ── POST /issue-handoff → 把需求移交给另一条流水线（Issue #42）──
              // skipped 是正常业务结果（已移交 / 目标缺节点）：回 200 + 可读文案，不报 5xx。
              // 注意排除 `-targets`（那是 GET 只读路由，前缀相同但方法/语义不同）。
              if (method === 'POST' && url.startsWith('/grape-worker-api/issue-handoff')
                && !url.startsWith('/grape-worker-api/issue-handoff-targets')) {
                try {
                  const body = await _readBody(reqRaw as unknown as { on?: (e: string, cb: (c?: unknown) => void) => void })
                  const validated = validateHandoffInput(body)
                  if (!validated.ok) {
                    _jsonReply(res, 400, { ok: false, code: validated.code, message: validated.message })
                    return
                  }
                  const auth = resolveApiAuth({
                    baseUrl: readConfigField<string>(config?.baseUrl, ''),
                    token: readConfigField<string>(config?.token, ''),
                  })
                  if (auth.error) {
                    _jsonReply(res, 503, { ok: false, code: 'not_configured', message: auth.error })
                    return
                  }
                  const { id, target_scene_id: targetSceneId } = validated.value
                  const api = await grapeApiCall(
                    { baseUrl: auth.baseUrl, token: auth.token },
                    'POST',
                    `/api/issues/${id}/handoff`,
                    { target_scene_id: targetSceneId },
                    45000,
                  )
                  if (!api.ok) {
                    const mapped = toIssueActionError({ status: api.status, data: api.data, requestId: api.requestId })
                    console.log(`[grape-dsh] issue-handoff #${id} -> HTTP ${api.status} code=${String(mapped.body.code)}`)
                    _jsonReply(res, mapped.status, mapped.body)
                    return
                  }
                  const outcome = classifyHandoffResult(api.data)
                  if (outcome.ok) {
                    console.log(`[grape-dsh] issue-handoff #${id} -> seq ${outcome.seq} scene=${targetSceneId}`)
                    _jsonReply(res, 200, { ok: true, seq: outcome.seq })
                    return
                  }
                  if (outcome.skipped) {
                    console.log(`[grape-dsh] issue-handoff #${id} skipped=${outcome.skipped}`)
                    _jsonReply(res, 200, { ok: false, skipped: outcome.skipped, message: outcome.message, code: outcome.code })
                    return
                  }
                  console.warn(`[grape-dsh] issue-handoff #${id} unexpected: ${String(JSON.stringify(api.data)).slice(0, 200)}`)
                  _jsonReply(res, 502, {
                    ok: false,
                    code: outcome.code || 'upstream_unavailable',
                    message: outcome.message || '移交失败（平台返回异常）',
                  })
                } catch (err) {
                  console.warn(`[grape-dsh] issue-handoff failed: ${String(err)}`)
                  _jsonReply(res, 502, { ok: false, code: 'upstream_unavailable', message: '移交失败（无法连接 Grape 服务）' })
                }
                return
              }

              _jsonReply(res, 404, { ok: false, error: 'not found' })
            },
          })
          console.log('[grape-dsh] worker onboard api mounted at /grape-worker-api (CLI mode, no terminal)')
          // 升级兜底：旧版本把接管 token 写在 os.tmpdir() 且从不删除（分析文档 §5.8.7），
          // 这里扫一遍只清 `grape-takeover-*.tok`，避免升级后临时目录仍有残留。
          try {
            const removed = cleanupStaleTakeoverTokens()
            if (removed) console.log(`[grape-dsh] cleaned ${removed} stale takeover token file(s) from tmpdir`)
          } catch (e) {
            console.warn(`[grape-dsh] stale takeover token cleanup failed: ${String(e)}`)
          }
        } catch (err) {
          console.warn(`[grape-dsh] worker onboard route registration failed: ${String(err)}`)
        }
      })
    } catch (err) {
      console.warn(`[grape-dsh] worker onboard wiring failed: ${String(err)}`)
    }
  }

  // ── shellEnv：把 GRAPE_SESSION_TOKEN 桥接到 DSH_GRAPE_SESSION_TOKEN ──
  //
  // dsh 的 subprocess 服务在 spawn bash 工具时用 scrubbedParentEnv() 把父进程 env
  // 里所有匹配 /KEY|PASSWORD|SECRET|TOKEN/i 的变量名全部剔除（安全设计，防止 dsh
  // 自己的凭据泄露到 model-authored 的 shell 命令里）。GRAPE_SESSION_TOKEN 命中
  // TOKEN → 被洗掉 → bash 里拿不到 → grape CLI 调不了 git-repo 接口 → Issue 评论
  // 发不出去。
  //
  // dsh 提供的逃生口是 ctx.shellEnv.register()：注册的 DSH_* 变量走 spec.dshEnv
  // 显式层，在 scrub 之后合并 → 存活。这里把 GRAPE_SESSION_TOKEN 的值复制到
  // DSH_GRAPE_SESSION_TOKEN；grape CLI 的 config.py 改为先读 DSH_ 再 fallback 到
  // 原变量，其他引擎（hermes/opencode/codex）不受影响（它们不做正则 scrub，或者
  // 用名单制，GRAPE_SESSION_TOKEN 不在名单里 → 原样保留）。
  //
  // 用作用域注入：headless 部署没有 shellEnv 时回调不执行，插件其余部分照常加载。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['shellEnv'], (scoped) => {
        const shellEnv = (scoped as unknown as {
          shellEnv?: {
            register: (contributor: {
              name: string
              variables: Readonly<Record<string, { description: string }>>
              resolve: (execution: unknown) => Readonly<Partial<Record<string, string>>>
            }) => () => void
          }
        }).shellEnv
        if (!shellEnv || typeof shellEnv.register !== 'function') return
        try {
          shellEnv.register({
            name: 'grape-session',
            variables: {
              DSH_GRAPE_SESSION_TOKEN: {
                description: 'Grape session token forwarded from the host env so it survives the dsh subprocess env scrub',
              },
            },
            resolve() {
              const tok = process.env.GRAPE_SESSION_TOKEN || ''
              return { DSH_GRAPE_SESSION_TOKEN: tok }
            },
          })
          console.log('[grape-dsh] shellEnv contributor registered (DSH_GRAPE_SESSION_TOKEN)')
        } catch (err) {
          // 重复注册（热重载）会抛 —— 安全吞掉
          if (!String(err).includes('already registered')) {
            console.warn(`[grape-dsh] shellEnv register failed: ${String(err)}`)
          }
        }
      })
    } catch (err) {
      console.warn(`[grape-dsh] shellEnv wiring failed: ${String(err)}`)
    }
  }
}
