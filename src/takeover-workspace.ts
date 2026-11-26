/**
 * 接管工作区路径映射 —— 把「平台给的远端任务目录」变成本机真实可用的目录。
 *
 * 背景（2026-11-18 实测故障）：平台 `bundle.workspace.cwd_hint` 给的是**远端 worker**
 * 上的绝对路径，形如 `/root/grape-workspaces/gitcode/<owner>/<repo>/issues/<n>/<agent>`。
 * 桌面端在 Windows 上直接把它交给 dsh 的 workspaceRegistry 会得到
 * `Workspace path is not fully qualified: '/root/...'`（Windows 需要盘符），
 * 于是 workspaceId 为空 → 前端拿不到 workspace → 不起会话 →
 * 「打开本地会话」按钮不出现、点接管看起来「卡住」。
 *
 * 本模块只做纯计算（平台、目录存在性都注入），所以 Linux CI 也能测 Windows 分支：
 *   · 远端路径在本机**确实可用**（同一台机器上接管本地任务）→ 原样使用；
 *   · 否则取 `grape-workspaces/` 之后的尾部，拼到本地工作区根下；
 *   · 尾部也取不到（平台没给 cwd 或结构变了）→ 用 `<owner>/<repo>/issues/<n>/<agent>` 兜底生成。
 *
 * 这里**不出现任何具体机器的目录名或产品名**：本地根来自环境变量或用户主目录，
 * 尾部来自平台返回值，因此任何机器、任何安装位置都能工作。
 */

/** 平台标记（与 process.platform 一致，注入以便跨平台单测）。 */
export type PathPlatform = 'win32' | 'darwin' | 'linux'

/** 拼接/判断路径时用哪套规则。 */
function pathApi(platform: PathPlatform) {
  // 用 node:path 的两个命名空间做字符串运算，不碰文件系统。
  return platform === 'win32'
    ? { sep: '\\', join: (...p: string[]) => _joinWin(p), abs: _isAbsWin }
    : { sep: '/', join: (...p: string[]) => p.filter(Boolean).join('/').replace(/\/{2,}/g, '/'), abs: _isAbsPosix }
}

function _isAbsPosix(p: string): boolean {
  return p.startsWith('/')
}

function _isAbsWin(p: string): boolean {
  const s = String(p || '')
  // 盘符绝对路径 C:\ / C:/ ，或 UNC \\server\share
  return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s)
}

function _joinWin(parts: string[]): string {
  const list = parts.filter((x) => x !== '' && x != null)
  if (!list.length) return ''
  const [head, ...rest] = list
  const tail = rest
    .join('\\')
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('\\')
  if (!tail) return head
  return head.replace(/[\\/]+$/, '') + '\\' + tail
}

/**
 * 一个路径是否是本机「完全限定」的绝对路径。
 *
 * Windows 上 `/root/x` 虽然以分隔符开头却**不是**完全限定路径（没有盘符），
 * dsh 的 workspaceRegistry 正是按这个口径拒绝的，所以判断要按平台区分。
 */
export function isFullyQualifiedPath(path: string, platform: PathPlatform): boolean {
  const p = String(path || '')
  if (!p) return false
  return platform === 'win32' ? _isAbsWin(p) : _isAbsPosix(p)
}

/** 单个路径段清洗：去掉 Windows 非法字符、结尾点/空格，并中和 `..`。 */
export function sanitizeSegment(segment: string): string {
  const raw = String(segment ?? '')
  if (!raw) return ''
  const replaced = raw
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    // Windows 不允许段尾是点或空格（"vod." 会被系统悄悄改名为 "vod"）
    .replace(/[. ]+$/, '')
  if (replaced === '' || replaced === '.' || replaced === '..') return ''
  return replaced
}

function splitSegments(value: string): string[] {
  return String(value || '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 从远端路径里取出 `grape-workspaces/` 之后的部分。
 *
 * 平台目录形态：`<任意前缀>/grape-workspaces/<平台>/<owner>/<repo>/issues/<n>/<agent>`，
 * 中间层数不写死 —— 换平台名、加分组都不会失效。
 */
export function tailAfterWorkspaceRoot(remoteCwd: string): string {
  const parts = splitSegments(remoteCwd)
  const idx = parts.lastIndexOf('grape-workspaces')
  if (idx < 0 || idx === parts.length - 1) return ''
  return parts.slice(idx + 1).join('/')
}

/** 远端路径里没带 grape-workspaces 时，用仓库/Issue/agent 生成尾部。 */
export function derivedTail(repo: string, issueNumber: string, agentType: string): string {
  const repoParts = splitSegments(repo)
  const issue = sanitizeSegment(String(issueNumber || '').replace(/^#/, '')) || '0'
  const agent = sanitizeSegment(agentType) || 'agent'
  const segments = [...repoParts, 'issues', issue, agent].map(sanitizeSegment).filter(Boolean)
  return segments.join('/')
}

/** 本地工作区根：环境变量优先，否则落在用户主目录下（不含任何机器专有常量）。 */
export function resolveTakeoverRoot(opts: {
  env?: Record<string, string | undefined>
  home?: string
  platform?: PathPlatform
}): string {
  const platform = opts.platform ?? 'linux'
  const env = opts.env ?? {}
  const configured = String(env.GRAPE_TAKEOVER_WORKSPACE_ROOT || env.GRAPE_WORKSPACE_ROOT || '').trim()
  if (configured && isFullyQualifiedPath(configured, platform)) return configured.replace(/[\\/]+$/, '')
  const home = String(opts.home || '').trim()
  if (!home) return ''
  return pathApi(platform).join(home, 'grape-workspaces')
}

export interface LocalizeTakeoverCwdOptions {
  /** 平台返回的远端任务目录（bundle.workspace.cwd_hint 或 bundle.task.cwd） */
  remoteCwd: string
  /** 仓库（owner/repo 或平台/owner/repo 任意层数） */
  repo?: string
  /** Issue 号（可带 #） */
  issueNumber?: string
  /** agent 名（coding / qa / vod …） */
  agentType?: string
  /** 本地工作区根（resolveTakeoverRoot 的结果） */
  root: string
  /** 本机平台，默认取运行环境 */
  platform?: PathPlatform
  /** 目录是否存在（注入，测试用） */
  exists?: (path: string) => boolean
}

export interface LocalizedTakeoverCwd {
  /** 本机可用、完全限定的目录 */
  cwd: string
  /** local = 远端路径本机可用；mapped = 取尾部映射到本地根；derived = 平台信息兜底生成 */
  source: 'local' | 'mapped' | 'derived'
  /** 相对本地根的尾部（mapped/derived 时有值） */
  tail: string
  /** 给人看的一句话（进日志 / 面板提示） */
  note: string
}

/**
 * 把远端任务目录映射成本机可用目录（纯函数，不建目录、不读盘）。
 *
 * 调用方拿到 `cwd` 后再去 mkdir + 登记 workspace。
 */
export function localizeTakeoverCwd(opts: LocalizeTakeoverCwdOptions): LocalizedTakeoverCwd {
  const platform: PathPlatform = opts.platform ?? ((process.platform as PathPlatform) || 'linux')
  const api = pathApi(platform)
  const exists = opts.exists ?? (() => false)
  const remote = String(opts.remoteCwd || '').trim()

  // ① 同一台机器上接管本地任务：远端路径就是本机路径，直接复用（能带上已有代码）
  if (remote && isFullyQualifiedPath(remote, platform) && exists(remote)) {
    return { cwd: remote.replace(/[\\/]+$/, ''), source: 'local', tail: '', note: `使用本机已有目录 ${remote}` }
  }

  const root = String(opts.root || '').trim().replace(/[\\/]+$/, '')
  const mapped = tailAfterWorkspaceRoot(remote)
  const tail = mapped || derivedTail(String(opts.repo || ''), String(opts.issueNumber || ''), String(opts.agentType || ''))
  if (!tail) {
    // 连兜底都拼不出来：交给调用方按错误处理（不该发生，repo 必填）
    return { cwd: '', source: 'derived', tail: '', note: '无法确定本机工作区目录（平台未返回 cwd，仓库信息也为空）' }
  }
  const safeTail = splitSegments(tail).map(sanitizeSegment).filter(Boolean)
  if (!root) {
    return { cwd: '', source: mapped ? 'mapped' : 'derived', tail: safeTail.join('/'), note: '本机工作区根未确定（无可用的用户主目录）' }
  }
  const cwd = api.join(root, ...safeTail)
  const why = remote
    ? `远端路径 ${remote} 在本机不可用`
    : '平台未返回任务目录'
  const how = mapped ? '已按 grape-workspaces 尾部映射' : '已按仓库/Issue/agent 生成'
  return { cwd, source: mapped ? 'mapped' : 'derived', tail: safeTail.join('/'), note: `${why}，${how}到 ${cwd}` }
}

/**
 * 宿主重启后从平台 `cwd_hint` 恢复本机目录时的保守映射。
 *
 * 与 `localizeTakeoverCwd` 的区别：这条路径拿不到 repo/issue/agent，
 * 所以**不猜 `derived`**（会拼出 `issues/0/agent` 这种错目录，比没有更糟）。
 * 只接受 `local`（远端即本机且存在）与 `mapped`（能按 `grape-workspaces` 尾部映射）。
 */
export function localizeRestoredCwd(opts: {
  remoteCwd: string
  root: string
  platform?: PathPlatform
  exists?: (path: string) => boolean
}): { cwd: string; source: 'local' | 'mapped' | ''; note: string } {
  const localized = localizeTakeoverCwd(opts)
  if (!localized.cwd || localized.source === 'derived') {
    return { cwd: '', source: '', note: localized.note }
  }
  return { cwd: localized.cwd, source: localized.source, note: localized.note }
}
