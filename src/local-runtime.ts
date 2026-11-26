/**
 * 本机运行时探测与安装布局（Windows / Linux 双平台）。
 *
 * 为什么单独成模块：`/grape-worker-api/check`、`/install-grape`、`/revoke`、`/takeover`
 * 都各自需要「跑一条本机命令」「找 Python」「算安装目录」「取 config 凭据」——过去这些
 * 逻辑散在路由里，于是同一类缺陷（POSIX 重定向、硬编码 `python3`、写死 `/opt`）被复制了
 * 四份。这里收敛成纯函数 + 注入式探针，路由只做编排，单测可覆盖。
 *
 * 铁律（对应分析文档 §6.0）：
 *   · 一切命令 `spawnSync(bin, args[], { shell: false })` —— 不经 cmd.exe / bash（R1/R2）
 *   · 路径一律 `path` / `os`，按平台分支（R4/R5/R7）
 *   · 网络不需要 shell（R8，各路由用 fetch）
 *   · config 优先、env 兜底（R9）
 */

import { spawn, spawnSync } from 'node:child_process'
import { homedir, platform as osPlatform, tmpdir } from 'node:os'
import { join, posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'

import { redactSensitiveText } from './repo-diagnostics.js'

/** Python 最低版本（分析文档 §5.4：文案说 3.10+，就必须真的校验 3.10+） */
export const PYTHON_MIN_MINOR = 10

/** 一条本机命令的执行结果 */
export interface CommandResult {
  /** 退出码 0 且未发生启动错误 */
  ok: boolean
  /** 退出码（未启动 / 被信号杀死为 null） */
  status: number | null
  stdout: string
  stderr: string
  /** 启动/执行错误信息（ENOENT、EACCES、超时…），正常完成时为空 */
  error: string
  /** 可执行文件不存在（ENOENT）—— 用于区分「未安装」与「执行失败」 */
  missing: boolean
}

/** 探针签名（单测可注入假实现） */
export type ProbeFn = (bin: string, args: readonly string[], timeoutMs?: number) => CommandResult

/**
 * 跑一条本机命令。数组传参 + `shell: false`：
 * Windows 的 `cmd.exe` 与 POSIX 的 `sh` 都不参与，POSIX 的 stderr 重定向无处可写。
 *
 * 例外：Windows 的 `.cmd` / `.bat` 包装器**不能**直接 spawn（Node ≥ 18 起 EINVAL），
 * 必须经 `cmd.exe /c`。这只为「CLI 以批处理包装器发布」的情况兜底，参数仍走数组，
 * 不做字符串拼接。
 *
 * ⚠️ 已知限制：`cmd.exe /c` 仍会**二次解析**参数里的 `&` / `^` / `%`（Node 只处理
 * 空格与引号），所以这条路径不保证参数原样透传。只有用户把 `config.bin` /
 * `GRAPE_CLI_BIN` 指到 `.cmd` / `.bat` 时才会命中；`grape.exe` 走不到这里。
 */
export function runLocal(bin: string, args: readonly string[], timeoutMs = 5000): CommandResult {
  const argv = Array.from(args)
  const wrapper = commandWrapper(bin, osPlatform())
  const r = spawnSync(wrapper.bin, [...wrapper.args, ...argv], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
  })
  const err = r.error as (Error & { code?: string }) | undefined
  return {
    ok: r.status === 0 && !err,
    status: typeof r.status === 'number' ? r.status : null,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    error: err ? String(err.message) : '',
    missing: err?.code === 'ENOENT',
  }
}

/**
 * 可执行文件的启动方式：Windows 的 `.cmd` / `.bat` 需要 `cmd.exe /c <bin>` 前缀。
 * 其余情况原样启动（`args` 为空数组）。
 */
export function commandWrapper(
  bin: string,
  platform: NodeJS.Platform = osPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): { bin: string; args: string[] } {
  const name = String(bin || '')
  if (platform !== 'win32') return { bin: name, args: [] }
  if (!/\.(cmd|bat)$/i.test(name)) return { bin: name, args: [] }
  const comspec = String(env.ComSpec || env.COMSPEC || '').trim()
    || pathWin32.join(String(env.SystemRoot || 'C:\\Windows'), 'System32', 'cmd.exe')
  return { bin: comspec, args: ['/c', name] }
}

/**
 * Python 启动器候选（R5：可执行名按平台确定，禁止写死某一个）。
 *
 * Windows 官方安装包提供 `py.exe` 与 `python.exe`，**不提供** `python3.exe`；
 * 类 Unix 反过来，`python` 在部分发行版仍指向 Python 2。因此按平台排序。
 */
export function pythonLaunchers(platform: NodeJS.Platform = osPlatform()): string[] {
  // 这里的 `python3` 是「启动器名（数据）」而不是被硬编码的调用点：
  // 真正执行一律 runLocal(candidate, ['--version']) 数组传参。
  const py3 = 'python3'
  return platform === 'win32'
    ? ['py', 'python', py3]
    : [py3, 'python']
}

/** 解析 `Python 3.12.10` / `3.9.18` 这类输出 */
export function parsePythonVersion(raw: string): { major: number; minor: number; micro: number; text: string } | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(raw || ''))
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    micro: Number(m[3] ?? 0),
    text: m[0],
  }
}

/** 找到的 Python（可能版本过低） */
export interface PythonProbe {
  /** 启动器名（py / python / python3） */
  bin: string
  /** 归一后的版本串，如 `Python 3.12.10` */
  version: string
  /** 是否满足 >= 3.10 */
  ok: boolean
}

/**
 * 找可用的 Python，并**真实校验版本**。
 *
 * 逐个候选探测：命中第一个 >= 3.10 的立即返回；否则返回找到的最高版本（`ok: false`），
 * 这样「装了 3.9」与「一个都没装」能给出不同文案（分析文档 §5.4）。
 */
export function findPython(platform: NodeJS.Platform = osPlatform(), probe: ProbeFn = runLocal): PythonProbe | null {
  let best: (PythonProbe & { score: number }) | null = null
  for (const bin of pythonLaunchers(platform)) {
    const r = probe(bin, ['--version'])
    if (!r.ok) continue
    const v = parsePythonVersion(`${r.stdout}\n${r.stderr}`)
    if (!v) continue
    const ok = v.major > 3 || (v.major === 3 && v.minor >= PYTHON_MIN_MINOR)
    const cand = {
      bin,
      version: `Python ${v.major}.${v.minor}.${v.micro}`,
      ok,
      score: v.major * 1000 + v.minor,
    }
    if (ok) return { bin: cand.bin, version: cand.version, ok }
    if (!best || cand.score > best.score) best = cand
  }
  return best ? { bin: best.bin, version: best.version, ok: false } : null
}

/** 一个候选都没有时的文案（明确是「没找到命令」，不再谎称环境缺件） */
export function pythonMissingMessage(platform: NodeJS.Platform = osPlatform()): string {
  return `未找到可用的 Python（已尝试：${pythonLaunchers(platform).join(' / ')}）。` +
    '安装 Python 3.10+ 并确保其命令在 PATH 中后重试。'
}

/** 找到了但版本过低时的文案（与「未安装」明确区分） */
export function pythonTooOldMessage(py: PythonProbe): string {
  return `${py.version} 版本过低（通过 ${py.bin} 找到），需要 Python 3.10+。请升级后重试。`
}

/** grape CLI 可执行名（R5） */
export function grapeExecutable(platform: NodeJS.Platform = osPlatform()): string {
  return platform === 'win32' ? 'grape.exe' : 'grape'
}

/** 安装布局（R4/R7：目录、可执行名都按平台分支，且一律走 path） */
export interface InstallLayout {
  platform: 'windows' | 'posix'
  installDir: string
  venvDir: string
  /** venv 内的 Python（存在性判断用，取代 `test -f bin/activate`） */
  venvPython: string
  /** venv 内的 pip（Windows 是 pip.exe） */
  venvPip: string
  /** venv 内的 grape 可执行文件 */
  grapeBin: string
  /** POSIX 侧暴露到 PATH 的软链目标；Windows 走 Scripts 目录，为空串 */
  linkPath: string
}

/**
 * 算本机安装布局。
 *
 * Windows：`%LOCALAPPDATA%\grape-cli` + `.venv\Scripts\`（`python.exe` / `pip.exe` / `grape.exe`）
 * 其它：系统级目录下的 `grape-cli`（`path.posix.join(sep, 'opt', ...)`）+ `.venv/bin/`
 *
 * 用 `path.win32` / `path.posix` 显式构造，使单测在任一平台上都能断言两侧结果。
 */
export function installLayout(
  platform: NodeJS.Platform = osPlatform(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): InstallLayout {
  if (platform === 'win32') {
    const win = pathWin32
    const localAppData = String(env.LOCALAPPDATA || '').trim() || win.join(home, 'AppData', 'Local')
    const installDir = win.join(localAppData, 'grape-cli')
    const venvDir = win.join(installDir, '.venv')
    const scripts = win.join(venvDir, 'Scripts')
    return {
      platform: 'windows',
      installDir,
      venvDir,
      venvPython: win.join(scripts, 'python.exe'),
      venvPip: win.join(scripts, 'pip.exe'),
      grapeBin: win.join(scripts, 'grape.exe'),
      linkPath: '',
    }
  }
  const posix = pathPosix
  const installDir = posix.join(posix.sep, 'opt', 'grape-cli')
  const venvDir = posix.join(installDir, '.venv')
  const binDir = posix.join(venvDir, 'bin')
  return {
    platform: 'posix',
    installDir,
    venvDir,
    venvPython: posix.join(binDir, 'python'),
    venvPip: posix.join(binDir, 'pip'),
    grapeBin: posix.join(binDir, 'grape'),
    linkPath: posix.join(posix.sep, 'usr', 'local', 'bin', 'grape'),
  }
}

/**
 * 清理历史版本遗留在共享临时目录里的接管 token 文件。
 *
 * 旧实现写共享临时目录下的 `grape-takeover-<ts>.tok` 且从不删除（分析文档 §5.8.7）；现在 token 落在
 * 工作区（0600，本地 agent 必须能读），临时目录里不该再有残留 —— 升级后由这里扫一遍兜底。
 * 只删精确匹配 `grape-takeover-*.tok` 的文件，其它内容一律不碰。
 *
 * @returns 删除的文件数
 */
export function cleanupStaleTakeoverTokens(dir: string = tmpdir()): number {
  let removed = 0
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!/^grape-takeover-[\w.-]*\.tok$/.test(name)) continue
    try {
      unlinkSync(join(dir, name))
      removed += 1
    } catch {
      /* 被占用 / 无权限：跳过，不影响接管主流程 */
    }
  }
  return removed
}

/**
 * 删掉接管工作区里已失效的 token 文件（`.grape-takeover-token`）。
 *
 * 为什么不能由 finish 直接删：finish 之后本地 agent 可能还在收尾，删了它的
 * grape CLI 会立刻 401。等客户端确认「会话已停 / 已空闲」后再调 `/takeover-release`
 * 回收；abort 语义是明确放弃，可以直接删。
 *
 * 与 `cleanupStaleTakeoverTokens` 的区别：那个扫的是历史版本写在共享临时目录里的
 * `grape-takeover-*.tok`，这里是当前版本写在**工作区**里的固定文件名。
 */
export function removeTakeoverToken(cwd: string): { removed: boolean; error: string } {
  const dir = String(cwd || '').trim()
  if (!dir) return { removed: false, error: '' }
  try {
    rmSync(join(dir, '.grape-takeover-token'), { force: true })
    return { removed: true, error: '' }
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e)
    return { removed: false, error: msg }
  }
}

/** 接管 / API 调用需要的鉴权（R9：config 优先，env 仅兜底） */
export interface ApiAuth {
  baseUrl: string
  token: string
  /** 非空即不可继续（文案可直接回给前端） */
  error: string
}

/**
 * 解析 Grape API 地址与 token。
 *
 * 注意：**不给 baseUrl 兜底 localhost**。Desktop 进程读不到 shell env（分析文档 §5.8.4），
 * 兜底到 `http://localhost:8000` 只会得到一个连接被拒的假错误，掩盖「config 没配」。
 */
export function resolveApiAuth(
  cfg: { baseUrl?: string; token?: string } | undefined,
): ApiAuth {
  // baseUrl / token 都只认插件 config（cordis.patch.yml）：不读 GRAPE_BASE_URL /
  // GRAPE_SERVER_URL / GRAPE_API_TOKEN，也不兜底 localhost。config 缺失时宁可明确报错，
  // 也不悄悄连到另一个环境、或用另一环境的令牌。
  const baseUrl = String(cfg?.baseUrl || '').trim().replace(/\/+$/, '')
  const token = String(cfg?.token || '').trim()
  if (!baseUrl) {
    return { baseUrl: '', token, error: '未配置 baseUrl：请在 cordis.patch.yml 的 grape-tools.config.baseUrl 填写 Grape 服务地址。' }
  }
  if (!token) {
    return { baseUrl, token: '', error: '未配置 token：请在 cordis.patch.yml 的 grape-tools.config.token 填写 Grape API Key。' }
  }
  return { baseUrl, token, error: '' }
}

/**
 * 本机 runtime.env 的 `RUNTIME_SERVER_URL` 是否与插件配置的 baseUrl 同一环境。
 *
 * 判定口径（2026-11-20 用户要求）：**地址对不上就等于本环境没有 worker**，
 * 必须重新接入（重写 runtime.env + 重装），不允许拿别的环境的 worker 顶替。
 * 未配置 baseUrl 时返回 false（由 {@link resolveApiAuth} 报配置错误，不在这里误判）。
 */
export function serverUrlMismatch(localServerUrl: string, configuredBaseUrl: string): boolean {
  const configured = normalizeServerUrl(configuredBaseUrl)
  if (!configured) return false
  return normalizeServerUrl(localServerUrl) !== configured
}

/**
 * 停本机 runtime-agent 服务（R6：平台分支，两侧都容错）。
 *
 * 只用于 `/revoke` 的「顺便停掉本机 worker」这一步；服务名在服务端脚本里是固定的
 * `runtime-agent`。任何一侧失败都只记日志，不影响凭据吊销结果。
 */
export function stopRuntimeAgent(
  platform: NodeJS.Platform = osPlatform(),
  probe: ProbeFn = runLocal,
): CommandResult | null {
  if (platform === 'win32') {
    const sc = probe('sc.exe', ['stop', 'runtime-agent'], 10000)
    if (sc.ok) return sc
    return probe('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Stop-Service -Name runtime-agent -ErrorAction SilentlyContinue',
    ], 10000)
  }
  return probe('systemctl', ['stop', 'runtime-agent.service'], 10000)
}

// ───────────────────────── Worker 身份与本机事实（Issue #2）─────────────────────────
//
// 事故背景：`/check` 过去按 `dsh-${hostname}` 重推导设备名去匹配 credential，`/onboard`
// 无条件新建 credential 再重装 —— 服务端 runtime/engine 行归属 credential，换凭据即产生新
// `runtime_id`，场景 `engine_runtime_ids` 绑定随之失效，旧 `rta_` 不可恢复。
//
// 修法：把「本机到底装了什么」变成一份**只读事实**（本节），`/check` 与 `/onboard` 共用它。
// 布局与键名逐字对照线上安装脚本（`GET /api/runtime/install`、`install.ps1`）：
//   Windows        %USERPROFILE%\grape   + %USERPROFILE%\.grape\runtime.env
//   普通用户        $HOME/grape           + $HOME/.grape/runtime.env
//   Linux root      /opt/grape            + /etc/grape/runtime.env
// 设备名一律原样取 `RUNTIME_DEVICE_NAME`（服务端对 device→engine 名有截断/归一规则，
// 重推导必然产出新身份）。

/** 一个 worker 安装布局（与 CLI 的 {@link InstallLayout} 区分：那是 grape CLI 的目录） */
export interface WorkerLayout {
  platform: 'windows' | 'posix'
  /** root 模式（POSIX `id -u` == 0）：安装到系统目录、配置落 /etc */
  rootMode: boolean
  /** worker 代码目录（含 .venv / VERSION / 日志） */
  installDir: string
  /** 接入配置（rta_ token + 主控地址，600） */
  envFile: string
  /** 安装时写入的版本号（安装脚本从 `<installDir>/VERSION` 复制） */
  versionFile: string
  /** 启动脚本（POSIX .sh / Windows .ps1） */
  startScript: string
  /** 守护进程 pid 文件（安装脚本不写；存在时用作快速路径） */
  pidFile: string
}

/** 当前进程 uid（Windows / 无此 API 的环境返回 null） */
function currentUid(): number | null {
  try {
    const fn = (process as { getuid?: () => number }).getuid
    return typeof fn === 'function' ? fn() : null
  } catch {
    return null
  }
}

/** 是否以 root 身份安装（安装脚本用 `id -u` 判定；拿不到 uid 时退回 USER/LOGNAME） */
function isRootInstall(uid: number | null, env: NodeJS.ProcessEnv): boolean {
  if (uid !== null) return uid === 0
  const user = String(env.USER || env.LOGNAME || '').trim()
  return user === 'root'
}

/**
 * 算 worker 安装布局（四平台统一入口）。
 *
 * 用 `path.win32` / `path.posix` 显式构造，使单测在任一平台上都能断言四侧结果（R4/R7）。
 * POSIX 系统目录一律 `posix.join(posix.sep, …)` 拼出，不写字面量（静态自检要求）。
 */
export function workerLayout(
  platform: NodeJS.Platform = osPlatform(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  uid: number | null = currentUid(),
): WorkerLayout {
  if (platform === 'win32') {
    const win = pathWin32
    const installDir = win.join(home, 'grape')
    const cfgDir = win.join(home, '.grape')
    return {
      platform: 'windows',
      rootMode: false,
      installDir,
      envFile: win.join(cfgDir, 'runtime.env'),
      versionFile: win.join(cfgDir, 'worker.version'),
      startScript: win.join(installDir, 'start-worker.ps1'),
      pidFile: win.join(installDir, 'data', 'worker.pid'),
    }
  }
  const posix = pathPosix
  if (isRootInstall(uid, env)) {
    const installDir = posix.join(posix.sep, 'opt', 'grape')
    const cfgDir = posix.join(posix.sep, 'etc', 'grape')
    return {
      platform: 'posix',
      rootMode: true,
      installDir,
      envFile: posix.join(cfgDir, 'runtime.env'),
      versionFile: posix.join(cfgDir, 'worker.version'),
      startScript: posix.join(installDir, 'start-worker.sh'),
      pidFile: posix.join(installDir, 'data', 'worker.pid'),
    }
  }
  const installDir = posix.join(home, 'grape')
  const cfgDir = posix.join(home, '.grape')
  return {
    platform: 'posix',
    rootMode: false,
    installDir,
    envFile: posix.join(cfgDir, 'runtime.env'),
    versionFile: posix.join(cfgDir, 'worker.version'),
    startScript: posix.join(installDir, 'start-worker.sh'),
    pidFile: posix.join(installDir, 'data', 'worker.pid'),
  }
}

/**
 * 候选布局（规范布局优先，POSIX 再补另一侧）。
 *
 * 为什么需要：root 用户可能先以普通用户装过（或反之，例如容器里 `su` 装的），
 * 只看规范布局会把「装过」误判成「未安装」→ 再装第二份 → 又是新设备身份。宁可多读一个路径。
 */
export function workerLayoutCandidates(
  platform: NodeJS.Platform = osPlatform(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  uid: number | null = currentUid(),
): WorkerLayout[] {
  const primary = workerLayout(platform, env, home, uid)
  if (primary.platform === 'windows') return [primary]
  const alternate = workerLayout(platform, env, home, primary.rootMode ? 1000 : 0)
  return alternate.envFile === primary.envFile ? [primary] : [primary, alternate]
}

/**
 * 解析 `runtime.env`（安装脚本写入的 KEY=VALUE）。
 *
 * 线上安装脚本、`.bak` 备份、以及用户手工 `export`/`set` 过的文件都出现过，所以这里容错：
 *   · UTF-8 BOM（Windows 记事本另存会带）→ 剥掉，否则第一个键名带 `\ufeff` 永远匹配不上；
 *   · `export KEY=VALUE` / `set KEY=VALUE` / `$env:KEY=VALUE` 前缀；
 *   · 单/双引号包裹的值（去掉引号，不做转义解释 —— 值里有反斜杠是常态，如 Windows 路径）；
 *   · 行尾注释 `KEY=VALUE  # 说明`（只在值未加引号时剥，避免把 `#` 当值内容截断）；
 *   · 值里再出现 `=` 原样保留（token 里可能出现）。
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const body = trimmed
      .replace(/^export\s+/i, '')
      .replace(/^set\s+/i, '')
      .replace(/^\$env:/i, '')
      .trim()
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = body.slice(eq + 1).trim()
    const quoted = value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    if (quoted) {
      value = value.slice(1, -1)
    } else {
      // 未加引号：剥行尾注释（`#` 前至少一个空白，避免误伤 token 内的 `#`）
      const hash = /\s#/.exec(value)
      if (hash) value = value.slice(0, hash.index).trim()
    }
    out[key] = value
  }
  return out
}

// ───────────────────────── grape CLI 定位（本机 worker 解析）─────────────────────────
//
// 事故背景：插件把「能找到 grape CLI」等同于「PATH 里有 grape」，而 Windows 侧
// `/install-grape` 只能把 CLI 放进 venv（没有软链），重启宿主后 `installedGrapeBin`
// 这个内存变量也没了 → 明明装着 CLI，面板却报「未检测到 grape CLI」，连带凭据
// 读不出来，用户看到的就是「本机 worker 设备解析失败」。
//
// 修法：按来源分层解析，并把「最终用的哪个 bin、来自哪里、试过哪些路径」回给面板。

/** grape CLI 的来源分层（面板直接展示，便于排障） */
export type GrapeBinSource =
  | 'config'
  | 'env'
  | 'installed'
  | 'plugin-install'
  | 'worker-install'
  | 'PATH'
  | 'missing'

export interface GrapeBinResolution {
  /** 最终可执行的路径/名称（未找到时为平台可执行名，便于报错文案里带上） */
  bin: string
  source: GrapeBinSource
  /** 已尝试的候选（诊断用；绝对路径与名字都记） */
  tried: string[]
}

/** 已知安装位置（插件安装器 / worker 安装脚本各一套，两侧都可能带 CLI） */
export function grapeBinCandidates(
  platform: NodeJS.Platform = osPlatform(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Array<{ bin: string; source: GrapeBinSource }> {
  const out: Array<{ bin: string; source: GrapeBinSource }> = []
  const plugin = installLayout(platform, env, home)
  out.push({ bin: plugin.grapeBin, source: 'plugin-install' })
  if (platform === 'win32') {
    const win = pathWin32
    out.push({ bin: win.join(home, 'grape', '.venv', 'Scripts', 'grape.exe'), source: 'worker-install' })
  } else {
    const posix = pathPosix
    out.push({ bin: posix.join(home, 'grape', '.venv', 'bin', 'grape'), source: 'worker-install' })
    out.push({ bin: posix.join(posix.sep, 'opt', 'grape', '.venv', 'bin', 'grape'), source: 'worker-install' })
  }
  // 只保留去重后的绝对路径（workerLayout 在某些分支下与上面重复）
  const seen = new Set<string>()
  return out.filter((c) => {
    if (!c.bin || seen.has(c.bin)) return false
    seen.add(c.bin)
    return true
  })
}

/**
 * 解析本机 grape CLI。
 *
 * 顺序（前者优先，用户显式配置必须被尊重）：
 *   ① 插件 config `bin` → ② `GRAPE_CLI_BIN` → ③ 本次会话内刚装的路径
 *   → ④ 已知安装目录（插件安装器 / worker 安装脚本）→ ⑤ PATH 上的平台可执行名
 *
 * 为什么安装目录排在 PATH 之前：Windows 上这两处没有软链，而系统 Python 里
 * 用 pip 全局装的那份往往是很久以前的版本（本机实测旧于 worker 安装脚本装的）；
 * 与本机 worker 配套的是托管副本。用户想强制指定就写 config.bin / GRAPE_CLI_BIN。
 *
 * 注入 `exists` / `probe` 让单测在任意平台上覆盖全部分支（不需要真的装 CLI）。
 */
export function resolveGrapeBin(input: {
  configured?: string
  envValue?: string
  installed?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  exists?: (path: string) => boolean
  probe?: (bin: string) => boolean
} = {}): GrapeBinResolution {
  const platform = input.platform ?? osPlatform()
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  const exists = input.exists ?? existsSync
  const probe = input.probe ?? ((bin: string) => runLocal(bin, ['--version']).ok)
  const fallbackName = grapeExecutable(platform)
  const tried: string[] = []

  const explicit = (bin: string, source: GrapeBinSource): GrapeBinResolution | null => {
    const value = String(bin || '').trim()
    if (!value) return null
    tried.push(value)
    // 显式配置/环境变量：即使探不通也照用 —— 报错要指出用户配的那个路径
    if (source === 'config' || source === 'env') return { bin: value, source, tried }
    return probe(value) ? { bin: value, source, tried } : null
  }

  for (const hit of [
    explicit(input.configured || '', 'config'),
    explicit(input.envValue || '', 'env'),
    explicit(input.installed || '', 'installed'),
  ]) {
    if (hit) return hit
  }

  // 已知安装目录（Windows 上插件安装器 / worker 安装脚本都只放 venv，不建软链）
  for (const candidate of grapeBinCandidates(platform, env, home)) {
    if (!candidate.bin || !exists(candidate.bin)) continue
    // 安装目录里的 CLI 也必须真的能跑（可能是半装的 venv）
    const hit = explicit(candidate.bin, candidate.source)
    if (hit) return hit
  }

  // 最后才看 PATH：系统 Python 里 pip 全局装的那份可能很旧（本机实测旧于托管副本）
  tried.push(fallbackName)
  if (probe(fallbackName)) return { bin: fallbackName, source: 'PATH', tried }

  return { bin: fallbackName, source: 'missing', tried }
}


/** 一条本机进程（pid + 完整命令行） */
export interface WorkerProcess {
  pid: number
  command: string
  /** 父进程 pid（枚举得到时才有；用于把同一 worker 的 launcher 子进程合并掉） */
  ppid?: number
}

/**
 * 本机进程探测的方式（Issue #25：判定依据必须可解释，不再折叠成布尔）。
 *
 * `pid-file` = 命中安装时写的 pid 文件且进程存活；`powershell` / `ps` / `pgrep` = 真实枚举；
 * `custom` = 单测/宿主机注入的进程列表；`none` = 本轮不需要探测（未安装）。
 */
export type WorkerProbeMethod = 'pid-file' | 'powershell' | 'ps' | 'pgrep' | 'custom' | 'none'

/** 一次进程探测的完整元数据（面板「判定依据」直接展示） */
export interface WorkerProbeFacts {
  method: WorkerProbeMethod
  /** 探测命令原文（不含任何凭据） */
  command: string
  timeoutMs: number
  /** 探测工具是否正常执行（超时 / ENOENT / 权限失败时为 false） */
  ok: boolean
  status: number | null
  /** 探测失败原因（成功为空） */
  error: string
  /** 原始 stderr 前 20 行（诊断用） */
  stderrLines: string[]
  /** 命中的 worker 进程（含非 venv 解释器、多进程并存） */
  matched: WorkerProcess[]
}

/** 空探测结果（未安装 / 走 pid 文件快速路径时 matched 为空） */
function emptyProbeFacts(over: Partial<WorkerProbeFacts> = {}): WorkerProbeFacts {
  return {
    method: 'none', command: '', timeoutMs: 0, ok: true, status: null, error: '', stderrLines: [], matched: [],
    ...over,
  }
}

/** stderr 取前 20 行（去除空行，保留原文便于排障） */
export function stderrLineSummary(text: string, limit = 20): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trimEnd())
    .filter((s) => s.trim().length > 0)
    .slice(0, Math.max(0, limit))
}

/**
 * 枚举本机 worker 进程并返回探测元数据（`listWorkerProcesses` 的带诊断版本）。
 *
 * 与旧实现一致：Windows 用 `Get-CimInstance`，POSIX 先 `ps` 再退 `pgrep`；
 * 区别是**不吞掉失败**——超时 / 工具不可用会体现在 `ok=false` + `error`，
 * 供上层判定「探测不可用」，而不是当成「没有进程」。
 */
export function collectWorkerProcesses(
  platform: NodeJS.Platform = osPlatform(),
  probe: ProbeFn = runLocal,
): WorkerProbeFacts {
  if (platform === 'win32') {
    const command = 'powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process"'
    // ⚠️ 这里的 PowerShell 过滤必须与 WORKER_MODULES 同步：旧写法只留 `*src.runtime.agent*`，
    // 新布局（`-m src.domains.runtime.engine.agent`）会被**在 PowerShell 里就筛掉**，
    // 导致 JS 侧 isWorkerCommand 再准也拿不到候选进程（2026-11-19 实测：worker 在跑但 matched=[]）。
    // 放宽到「python + -m src.*agent*」做初筛（同时限制进程名，避免把 dsh 的 powershell 包装器也捞进来），
    // 最终判据仍交给 isWorkerCommand。
    const r = probe('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*-m src.*agent*' } | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)\" }",
    ], 8000)
    const facts = emptyProbeFacts({
      method: 'powershell',
      command,
      timeoutMs: 8000,
      ok: r.ok,
      status: r.status,
      error: r.ok ? '' : (r.error || r.stderr.trim() || `exit code ${r.status ?? 'null'}`),
      stderrLines: stderrLineSummary(r.stderr),
    })
    facts.matched = r.ok
      ? collapseWorkerProcesses(parseProcessList(r.stdout).filter((p) => isWorkerCommand(p.command)))
      : []
    return facts
  }
  const ps = probe('ps', ['-A', '-o', 'pid,ppid,args'], 8000)
  if (ps.ok) {
    const facts = emptyProbeFacts({
      method: 'ps',
      command: 'ps -A -o pid,ppid,args',
      timeoutMs: 8000,
      status: ps.status,
      stderrLines: stderrLineSummary(ps.stderr),
    })
    facts.matched = collapseWorkerProcesses(parseProcessList(ps.stdout).filter((p) => isWorkerCommand(p.command)))
    return facts
  }
  // pgrep 兜底：正则同样要覆盖两种模块入口（与 WORKER_MODULES 同步）
  const pg = probe('pgrep', ['-f', 'src\\.(runtime\\.agent|domains\\.runtime\\.engine\\.agent)'], 8000)
  // pgrep 没有匹配时退出码是 1，这不是「探测工具不可用」：应判「探测成功、没有进程」。
  // 否则 ps 不可用的精简环境会一直 probe-failed，把自动拉起永久挡住（Issue #25 Low）。
  const noMatch = pg.status === 1 && !pg.stderr.trim()
  const facts = emptyProbeFacts({
    method: 'pgrep',
    command: 'pgrep -f src\\.(runtime\\.agent|domains\\.runtime\\.engine\\.agent)',
    timeoutMs: 8000,
    ok: pg.ok || noMatch,
    status: pg.status,
    error: pg.ok || noMatch
      ? ''
      : (pg.error || pg.stderr.trim() || ps.error || `ps exit code ${ps.status ?? 'null'}`),
    stderrLines: stderrLineSummary(`${ps.stderr}
${pg.stderr}`),
  })
  if (!pg.ok && !noMatch) return facts
  facts.matched = pg.stdout
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((pid) => Number.isFinite(pid) && pid > 0)
    .map((pid) => ({ pid, command: 'src.runtime.agent' }))
  return facts
}

/**
 * 枚举本机进程（不可用时返回空数组，绝不抛）。
 *
 * POSIX：`ps -A -o pid,args`（Linux/BSD/macOS 均支持），退化 `pgrep -f`；
 * Windows：`powershell -Command Get-CimInstance Win32_Process`（安装脚本同款判据）。
 * 一律数组传参 + `shell:false`（R1/R2）——PowerShell 只用来执行固定脚本串，不拼用户输入。
 */
export function listWorkerProcesses(
  platform: NodeJS.Platform = osPlatform(),
  probe: ProbeFn = runLocal,
): WorkerProcess[] {
  return collectWorkerProcesses(platform, probe).matched
}

/**
 * 是否为本机 worker 进程命令。
 *
 * 只认「python 解释器 + `-m src.runtime.agent`」结构，避免 `vim src/runtime/agent.py`、
 * `tail -f …`、构建/日志里恰好出现该串的进程把真实离线误报成「运行中」。
 * `pgrep -f` 兜底只回 pid、命令列被置为固定串 `src.runtime.agent`，单独放行。
 */
/**
 * worker 进程的模块入口（两种布局都要认）：
 *   · 旧布局：`python -m src.runtime.agent`
 *   · 新布局：`python -m src.domains.runtime.engine.agent`（h-ed5f4e02adee 起）
 *
 * 只认旧入口的后果（2026-11-19 实测）：新 worker 明明在跑，`/check` 仍报
 * `processAlive=false` → 面板显示「已安装未启动」→ 用户点「启动 Worker」→
 * 宿主再拉起一份，变成重复 worker。所以这里必须两种都匹配。
 */
const WORKER_MODULES = ['src.runtime.agent', 'src.domains.runtime.engine.agent'] as const

export function isWorkerCommand(command: string): boolean {
  const cmd = String(command || '')
  if (!cmd) return false
  // pgrep 兜底：命令行只给出模块名时直接认
  if (WORKER_MODULES.some((mod) => cmd === mod)) return true
  const hasModule = WORKER_MODULES.some((mod) => {
    const escaped = mod.replace(/\./g, '\\.')
    return new RegExp(`(^|\\s)-m\\s+${escaped}(\\s|$)`).test(cmd)
  })
  if (!hasModule) return false
  return /(^|["'/\\\s])(python[0-9.]*(\.exe)?|py)(\s|["']|$)/i.test(cmd)
}

/** 解析 `ps`/PowerShell 的「pid 命令行」输出（跳过表头与非数字行） */
export function parseProcessList(text: string): WorkerProcess[] {
  const out: WorkerProcess[] = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    // 优先按「pid ppid command」解析（Issue #25：需要父子关系来合并同一 worker）；
    // 老格式「pid command」仍然兼容（第二列不是纯数字时退回）。
    const m3 = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m3) {
      out.push({ pid: Number(m3[1]), ppid: Number(m3[2]), command: m3[3] })
      continue
    }
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    out.push({ pid: Number(m[1]), command: m[2] })
  }
  return out
}

/**
 * 合并同一 worker 的父子进程（Issue #25 三处修复之一）。
 *
 * Windows 上 venv 的 `python.exe` 会再拉起一个真实解释器，两者都命中
 * `-m src.runtime.agent`；面板把它们算成「进程数=2」会让人误以为重复拉起。
 * 父进程也在命中列表里时只保留父进程。
 */
export function collapseWorkerProcesses(list: WorkerProcess[]): WorkerProcess[] {
  if (list.length <= 1) return list
  const pids = new Set(list.map((p) => p.pid))
  return list.filter((p) => p.ppid === undefined || !pids.has(p.ppid))
}

/** `/check` 的判定来源（顺序即优先级） */
export type WorkerSource = 'runtime-env' | 'process' | 'install-dir' | 'none'

/** 本机事实（`/check` 与 `/onboard` 的唯一来源；只读） */
export interface LocalWorkerFacts {
  /** 文件/进程层面存在 worker（≠ 已接入在线） */
  installed: boolean
  /** worker 进程存活 */
  running: boolean
  /** 原样取自 `RUNTIME_DEVICE_NAME`（未装或读不到时为空） */
  deviceName: string
  serverUrl: string
  version: string
  /** `RUNTIME_TOKEN` 存在（不回传值） */
  tokenPresent: boolean
  installDir: string
  envFile: string
  source: WorkerSource
  /** 非空 = 本机信息读不全（权限/IO）：前端显示「读取失败」并禁用接入，不得当成未安装 */
  readError: string
  /** 命中的 worker 进程（含多进程并存；不再折叠成布尔） */
  processes: WorkerProcess[]
  /** 本轮进程探测的方式 / 命令 / 超时 / 退出码 / stderr（判定依据） */
  probe: WorkerProbeFacts
  /** 探测工具是否失败（超时 / 不可用 / 权限）——失败一律不得判定为「未运行」，也不得拉起 */
  probeFailed: boolean
  /** `runtime.env` 的 RUNTIME_HEARTBEAT_INTERVAL（秒，缺省 15） */
  heartbeatIntervalSec: number
}

/** 只读探测的依赖（单测注入假 fs / 假进程表） */
export interface ReadLocalWorkerDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  uid?: number | null
  /** 读文本文件；不存在时抛 `code:'ENOENT'` 的错误 */
  readFileText?: (path: string) => string
  exists?: (path: string) => boolean
  listProcesses?: () => WorkerProcess[]
  /** 进程探测命令（默认 `runLocal`；单测注入超时 / 工具不可用） */
  probe?: ProbeFn
  /** 进程存活探测（默认 `process.kill(pid, 0)`） */
  killZero?: (pid: number) => boolean
}

/** 读一个小文本文件（失败时带 code 抛出，供调用方区分 ENOENT 与真错误） */
function defaultReadFileText(path: string): string {
  return readFileSync(path, 'utf8')
}

/** `process.kill(pid, 0)`：只探测存在性，不发信号 */
function defaultKillZero(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 读版本文件（缺失/不可读时返回空串，不影响主判定） */
function readVersion(layout: WorkerLayout, deps: { readFileText: (p: string) => string }): string {
  for (const candidate of [layout.versionFile, join(layout.installDir, 'VERSION')]) {
    try {
      const text = deps.readFileText(candidate).trim()
      if (text) return text.split(/\r?\n/)[0].trim()
    } catch {
      /* 版本只是展示字段：读不到就不展示 */
    }
  }
  return ''
}

/** 读 pid 文件（不存在/非数字返回 null） */
function readPidFile(layout: WorkerLayout, deps: { readFileText: (p: string) => string }): number | null {
  try {
    const n = Number(deps.readFileText(layout.pidFile).trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * 只读探测本机 worker 事实（`/check` 与 `/onboard` 共用，**绝不写**）。
 *
 * 判定顺序：`runtime.env` → `process` → `install-dir` → 未接入。
 * `installed`（文件存在）与 `running`（进程存活）分开表达 —— 已装未运行要走静默拉起，
 * 不能当成未安装再装一遍。
 *
 * 读取遇到 ENOENT 属正常（该布局没装），继续看下一候选；遇到其它错误（权限/IO）则
 * 立刻返回 `readError`，让上层显示「读取失败」而不是「未安装」——后者会诱导用户点接入。
 */
export function readLocalWorker(deps: ReadLocalWorkerDeps = {}): LocalWorkerFacts {
  const platform = deps.platform ?? osPlatform()
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const uid = deps.uid === undefined ? currentUid() : deps.uid
  const exists = deps.exists ?? existsSync
  const fileReader = { readFileText: deps.readFileText ?? defaultReadFileText }
  const killZero = deps.killZero ?? defaultKillZero
  const candidates = workerLayoutCandidates(platform, env, home, uid)

  const empty = (layout: WorkerLayout): LocalWorkerFacts => ({
    installed: false,
    running: false,
    deviceName: '',
    serverUrl: '',
    version: '',
    tokenPresent: false,
    installDir: layout.installDir,
    envFile: layout.envFile,
    source: 'none',
    readError: '',
    processes: [],
    probe: emptyProbeFacts(),
    probeFailed: false,
    heartbeatIntervalSec: 15,
  })

  let layout = candidates[0]
  let envVars: Record<string, string> | null = null
  for (const candidate of candidates) {
    try {
      envVars = parseEnvText(fileReader.readFileText(candidate.envFile))
      layout = candidate
      break
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      // 读不全 ≠ 未安装：把原因交给前端显式呈现，并禁止接入
      return {
        ...empty(candidate),
        readError: `读取 ${candidate.envFile} 失败：${String(err instanceof Error ? err.message : err)}`,
      }
    }
  }

  const facts = empty(layout)
  if (envVars) {
    facts.deviceName = String(envVars.RUNTIME_DEVICE_NAME ?? '').trim()
    facts.serverUrl = String(envVars.RUNTIME_SERVER_URL ?? '').trim()
    facts.tokenPresent = Boolean(String(envVars.RUNTIME_TOKEN ?? '').trim())
    const hb = Number(envVars.RUNTIME_HEARTBEAT_INTERVAL)
    if (Number.isFinite(hb) && hb > 0) facts.heartbeatIntervalSec = hb
    facts.installed = true
  }
  const dirFound = exists(layout.installDir) || exists(layout.versionFile) || exists(layout.envFile)
  facts.version = envVars || dirFound ? readVersion(layout, fileReader) : ''

  // 进程存活：优先 pid 文件（快、准），否则枚举命令行
  let running = false
  if (facts.installed || dirFound) {
    const pid = readPidFile(layout, fileReader)
    if (pid !== null && killZero(pid)) {
      running = true
      facts.probe = emptyProbeFacts({
        method: 'pid-file',
        command: `worker.pid → pid ${pid}（process.kill(pid, 0) 存活）`,
        ok: true,
        matched: [],
      })
    }
  }
  if (!running) {
    // 注入的进程列表（单测 / 宿主）优先；否则真实枚举，并保留探测元数据。
    if (deps.listProcesses) {
      try {
        const listed = deps.listProcesses() ?? []
        facts.probe = emptyProbeFacts({
          method: 'custom',
          command: '注入式进程列表（host/listProcesses）',
          ok: true,
          matched: listed.filter((p) => isWorkerCommand(p.command)),
        })
      } catch (err) {
        facts.probe = emptyProbeFacts({
          method: 'custom',
          command: '注入式进程列表（host/listProcesses）',
          ok: false,
          error: String(err instanceof Error ? err.message : err),
        })
      }
    } else {
      facts.probe = collectWorkerProcesses(platform, deps.probe ?? runLocal)
    }
    running = facts.probe.matched.some((p) => isWorkerCommand(p.command))
  }
  facts.processes = facts.probe.matched
  facts.probeFailed = !facts.probe.ok && facts.probe.method !== 'none' && facts.probe.method !== 'pid-file'

  facts.running = running
  facts.installed = Boolean(envVars) || running || dirFound
  if (envVars) facts.source = 'runtime-env'
  else if (running) facts.source = 'process'
  else if (dirFound) facts.source = 'install-dir'
  else facts.source = 'none'
  return facts
}

// ───────────────────────── 状态机（Issue #25）────────────────────────────────
//
// 事故背景：面板只看 `processAlive` 布尔值 —— PowerShell 探测超时/不可用被当成
// 「没有进程」→ 显示「未运行」→ 自动再拉一份 worker → 同设备凭据争用、心跳抖动。
//
// 修法：把「本地事实 + 服务端心跳 + 探测元数据 + 凭据状态 + 拉起护栏」合成一个
// 可解释的状态（每态一句建议），面板与拉起路由共用同一个结论。服务端 `last_seen_at`
// 落在 2×心跳窗口内时是**唯一权威的在线证据**，本地探测失败只能降级为「探测不可用」，
// 绝不能判「未运行」，更不能触发拉起。

/** 面板/诊断展示的状态标识（9+ 态，禁止再折叠成布尔） */
export type WorkerStateId =
  | 'online'
  | 'not-installed'
  | 'installed-stopped'
  | 'started-waiting-heartbeat'
  | 'server-online-probe-failed'
  | 'server-online-no-local-process'
  | 'identity-mismatch'
  | 'credential-inactive'
  | 'autostart-throttled'
  | 'autostart-blocked'
  | 'probe-failed'
  | 'read-error'

/** 每个状态的一句可操作建议（面板直接展示） */
export const WORKER_STATE_ADVICE: Record<WorkerStateId, string> = {
  online: '本机进程与服务端心跳一致，无需操作。',
  'not-installed': '未检测到本机 Worker 安装。点击「接入本机」完成安装与凭据签发。',
  'installed-stopped': '已安装但进程未运行，可自动或手动拉起（同一设备 5 分钟最多拉起 1 次）。',
  'started-waiting-heartbeat': '进程已在运行，但服务端尚未看到心跳。等待一个心跳周期后刷新；若持续缺失，检查网络与 RUNTIME_SERVER_URL。',
  'server-online-probe-failed': '服务端显示在线，本机进程探测不可用（不是未运行）。请排查进程探测工具权限/超时后再判断，切勿重复拉起。',
  'server-online-no-local-process': '服务端显示在线但本机未枚举到进程（可能运行在容器/其它账号下）。以服务端心跳为准，不自动拉起；如需核对请手动检查进程。',
  'identity-mismatch': '本机设备名或服务地址与服务端记录不一致。请核对 runtime.env 与凭据，不要重复接入。',
  'credential-inactive': '本机凭据不是 active 状态，心跳会被拒绝。请在面板重新接入（会吊销并重建凭据）。',
  'autostart-throttled': '自动拉起处于 5 分钟节流窗口内。稍后刷新或手动检查本机进程，不要重复触发。',
  'autostart-blocked': '自动拉起已被拦截（凭据被吊销或用户显式停止）。需要重新接入或显式操作后才能拉起。',
  'probe-failed': '本机进程探测失败（工具不可用/超时/权限），且服务端也未显示在线。修复探测工具后再判断，不会自动拉起。',
  'read-error': '读取本机配置失败（权限/IO）。修复前不要重复接入，避免生成第二份凭据。',
}

/** 状态判定结果（`/check` 直接返回，面板展示） */
export interface WorkerClassification {
  state: WorkerStateId
  /** 判定依据（人可读，逐条；不含 token） */
  basis: string[]
  advice: string
  /** 唯一允许自动/静默拉起的状态 */
  canAutoStart: boolean
}

/** 分类输入（纯函数，服务端/探测/凭据/节流都可注入） */
export interface WorkerClassificationInput {
  local: {
    installed: boolean
    running: boolean
    deviceName: string
    serverUrl: string
    readError: string
    source?: string
    tokenPresent?: boolean
    probeFailed?: boolean
    processes?: WorkerProcess[]
    heartbeatIntervalSec?: number
  }
  server?: {
    device_name?: string
    health?: string
    last_seen_at?: string | null
    credential_status?: string
    worker_version?: string
  } | null
  probe?: { failed?: boolean; method?: string; ok?: boolean } | null
  cred?: { id?: number; status?: string } | null
  throttle?: { blocked?: string | null; lastStartAt?: number | null } | null
  /** 期望的服务地址（插件配置的 baseUrl）：用于识别 runtime.env 指向了别的服务端 */
  expected?: { serverUrl?: string } | null
  now?: number
}

/** 解析服务端时间（无时区后缀按 UTC，与服务端一致） */
export function parseServerTimeMs(raw: string | null | undefined): number | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
  const iso = hasZone ? text : `${text.replace(' ', 'T')}Z`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** 服务地址归一（去尾斜杠、小写 host、去默认端口，避免仅大小写/斜杠/默认端口差异被误判不一致） */
export function normalizeServerUrl(raw: string | null | undefined): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    const defaultPort = (url.protocol === 'https:' && url.port === '443')
      || (url.protocol === 'http:' && url.port === '80')
    const path = url.pathname.replace(/\/+$/, '')
    const port = defaultPort || !url.port ? '' : `:${url.port}`
    return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}`.toLowerCase()
  }
  catch {
    return text.replace(/\/+$/, '').toLowerCase()
  }
}

/**
 * 合成 Worker 状态（纯函数）。
 *
 * 优先级（Spec 硬要求）：
 *   ① 读取失败 → read-error（禁用一切接入/拉起）
 *   ② 进程在跑但身份不一致 → identity-mismatch（先解释差异）
 *   ③ 服务端 `health=online` 且在 2×heartbeat 窗口内 → 服务端优先：
 *        探测失败 → server-online-probe-failed；进程缺失 → server-online-no-local-process；
 *        进程在跑 → online。此分支 `canAutoStart` 恒 false。
 *   ④ 凭据非 active → credential-inactive
 *   ⑤ 未安装 / 进程在跑（服务端未在线）/ 探测失败 / 节流 / 永久拦截 → 各自状态
 *   ⑥ 其余 → installed-stopped（唯一可拉起状态）
 */
export function classifyWorkerState(input: WorkerClassificationInput): WorkerClassification {
  const now = input.now ?? Date.now()
  const local = input.local
  const server = input.server ?? null
  const hbSec = Number(local.heartbeatIntervalSec ?? 15)
  const heartbeatSec = Number.isFinite(hbSec) && hbSec > 0 ? hbSec : 15
  const windowMs = heartbeatSec * 2000
  const lastMs = parseServerTimeMs(server?.last_seen_at)
  const ageMs = lastMs === null ? null : Math.max(0, now - lastMs)
  const health = String(server?.health ?? '').toLowerCase()
  const serverOnline = health === 'online' && ageMs !== null && ageMs <= windowMs
  const probeFailed = Boolean(input.probe?.failed ?? local.probeFailed)
  const running = Boolean(local.running)
  const processes = local.processes ?? []
  const basis: string[] = [
    `本机：installed=${local.installed} running=${running} source=${local.source ?? 'unknown'} 进程数=${processes.length}`,
  ]
  if (local.deviceName) basis.push(`本机设备名：${local.deviceName}`)
  if (local.serverUrl) basis.push(`本机服务地址：${local.serverUrl}`)
  basis.push(server
    ? `服务端：health=${server.health || 'unknown'} last_seen_at=${server.last_seen_at ?? 'null'}（距今 ${ageMs === null ? '未知' : `${Math.round(ageMs / 1000)}s`}，在线窗口 ${Math.round(windowMs / 1000)}s）`
    : '服务端：无匹配设备行（未配置 API Key 或设备名未匹配）')
  if (input.probe || local.probeFailed !== undefined) {
    basis.push(`探测：method=${input.probe?.method ?? 'unknown'} failed=${probeFailed}`)
  }
  if (input.cred?.status) basis.push(`凭据：id=${input.cred.id ?? '未知'} status=${input.cred.status}`)
  if (input.throttle?.blocked) basis.push(`拉起护栏：永久拦截（${input.throttle.blocked}）`)
  else if (input.throttle?.lastStartAt) basis.push(`拉起护栏：上次拉起 ${new Date(input.throttle.lastStartAt).toISOString()}`)

  const done = (state: WorkerStateId, extra: string[] = []): WorkerClassification => ({
    state,
    basis: [...basis, ...extra],
    advice: WORKER_STATE_ADVICE[state],
    canAutoStart: state === 'installed-stopped',
  })

  if (local.readError) return done('read-error', [`读取错误：${local.readError}`])

  const expectedName = String(server?.device_name ?? '').trim()
  const nameMismatch = Boolean(running && local.deviceName && expectedName && local.deviceName !== expectedName)
  const expectedUrl = normalizeServerUrl(input.expected?.serverUrl)
  const urlMismatch = Boolean(running && expectedUrl && local.serverUrl && normalizeServerUrl(local.serverUrl) !== expectedUrl)
  if (nameMismatch || urlMismatch) {
    return done('identity-mismatch', [
      nameMismatch ? `设备名不一致：本机 ${local.deviceName} ≠ 服务端 ${expectedName}` : '',
      urlMismatch ? `服务地址不一致：本机 ${local.serverUrl} ≠ 配置 ${input.expected?.serverUrl}` : '',
    ].filter(Boolean))
  }

  if (serverOnline) {
    if (probeFailed) return done('server-online-probe-failed', ['探测不可用，但服务端心跳在窗口内：判定为在线（探测不可信）'])
    if (!running) return done('server-online-no-local-process', ['服务端心跳在窗口内，但本机未枚举到进程（以服务端为准，不拉起）'])
    return done('online')
  }

  const credStatus = String(server?.credential_status || input.cred?.status || '').trim()
  if (credStatus && credStatus.toLowerCase() !== 'active') {
    return done('credential-inactive', [`凭据状态不是 active（${credStatus}）`])
  }

  if (!local.installed) return done('not-installed')
  if (running) return done('started-waiting-heartbeat', ['进程在跑但服务端不在 2×心跳窗口内'])
  if (probeFailed) return done('probe-failed')
  if (input.throttle?.blocked) return done('autostart-blocked')
  const lastStart = Number(input.throttle?.lastStartAt ?? 0)
  if (lastStart > 0 && now - lastStart < AUTO_START_THROTTLE_MS) {
    return done('autostart-throttled', [`距上次拉起 ${Math.round((now - lastStart) / 1000)}s < ${Math.round(AUTO_START_THROTTLE_MS / 1000)}s`])
  }
  return done('installed-stopped')
}

/**
 * 拉起前护栏（Issue #25 第 4 条）：任一存活 agent 进程 / 探测失败即拒拉。
 *
 * 为什么独立于状态机：拉起路由可能被并发/直接调用，护栏必须能单独复用。
 */
export function evaluateStartGuard(local: {
  readError?: string
  installed?: boolean
  running?: boolean
  probeFailed?: boolean
  processes?: WorkerProcess[]
}): string {
  if (local.readError) return 'read-error'
  if (!local.installed) return 'not-installed'
  if (local.running) return 'process-alive'
  if ((local.processes ?? []).some((p) => isWorkerCommand(p.command))) return 'process-alive'
  if (local.probeFailed) return 'probe-failed'
  return ''
}

/** 拉起记录（面板「上次拉起」展示；token 不落此结构） */
export interface WorkerStartRecord {
  at: string
  pid: number
  exitCode: number | null
  error: string
  /** 失败原因 / 探测 stderr 摘要（前 20 行，已脱敏） */
  stderrLines: string[]
  deviceName: string
  tokenPresent: boolean
  verifyState: 'ok' | 'mismatch' | 'unverified'
  verifyDetail: string
}

/**
 * 构造一次拉起的结果记录（纯函数，便于单测断言失败回写）。
 *
 * `actual` = 拉起后重新读取的 runtime.env 事实；与期望设备名/服务地址/服务端行核对，
 * 不一致写入 `verifyDetail`（不抛错，也不阻止进程本身继续运行）。
 */
export function buildWorkerStartRecord(input: {
  started: StartWorkerResult
  now?: number
  expected?: { deviceName?: string; serverUrl?: string; serverDeviceName?: string }
  actual?: { deviceName?: string; serverUrl?: string; tokenPresent?: boolean }
  probe?: { ok?: boolean; stderrLines?: string[] } | null
}): WorkerStartRecord {
  const mismatch: string[] = []
  const expected = input.expected ?? {}
  const actual = input.actual ?? {}
  const expName = String(expected.deviceName ?? expected.serverDeviceName ?? '').trim()
  const actName = String(actual.deviceName ?? '').trim()
  if (expName && actName && expName !== actName) mismatch.push(`device_name: ${actName} ≠ ${expName}`)
  const expUrl = normalizeServerUrl(expected.serverUrl)
  const actUrl = normalizeServerUrl(actual.serverUrl)
  if (expUrl && actUrl && expUrl !== actUrl) mismatch.push(`server_url: ${actUrl} ≠ ${expUrl}`)
  if (actual.tokenPresent === false) mismatch.push('runtime.env 缺少 RUNTIME_TOKEN')
  const stderr = [
    ...stderrLineSummary(input.started.error),
    ...(input.probe?.ok === false ? stderrLineSummary((input.probe.stderrLines ?? []).join('\n')) : []),
  ].slice(0, 20).map((line) => redactSensitiveText(line))
  return {
    at: new Date(input.now ?? Date.now()).toISOString(),
    pid: input.started.pid,
    // 刚 spawn 出来还不知道退出码；真实退出码由 watchWorkerExit 回调回填这条记录
    exitCode: null,
    error: redactSensitiveText(input.started.error),
    stderrLines: stderr,
    deviceName: actName,
    tokenPresent: actual.tokenPresent === true,
    verifyState: Object.keys(actual).length === 0 ? 'unverified' : (mismatch.length ? 'mismatch' : 'ok'),
    verifyDetail: mismatch.join('；'),
  }
}

// ── 静默拉起护栏（M3）───────────────────────────────────────────────────────
//
// 三类拦截，缺一不可（事故驱动）：
//   ① 同一个进程 5 分钟内每台设备最多拉起 1 次 —— 防重启风暴；
//   ② 退出码 42（凭据被吊销）后本进程内**永不**再拉起 —— 拉了也会立刻退出，只会刷屏；
//   ③ 用户显式停止（/revoke）后本进程内不再拉起 —— 尊重用户意图。

/** 拉起节流窗口：同一设备 5 分钟最多 1 次 */
export const AUTO_START_THROTTLE_MS = 5 * 60 * 1000

/** 拉起拦截原因 */
export type AutoStartBlockReason = 'credential-revoked' | 'user-stopped'

/** 一台设备最近一次拉起时间（进程级） */
const AUTO_START_AT = new Map<string, number>()
/** 被永久拦截的设备（进程级） */
const AUTO_START_BLOCKED = new Map<string, AutoStartBlockReason>()

/** 静默拉起判定结果 */
export interface AutoStartDecision {
  start: boolean
  /** `ok` / `throttled` / `running` / `not-installed` / `read-error` / `probe-failed` / `process-alive` / `blocked:*` */
  reason: string
}

/** 永久拦截某台设备的自动拉起（code 42 / 用户停止） */
export function blockAutoStart(key: string, reason: AutoStartBlockReason): void {
  if (key) AUTO_START_BLOCKED.set(key, reason)
}

/** 该设备是否已被永久拦截 */
export function isAutoStartBlocked(key: string): AutoStartBlockReason | null {
  return AUTO_START_BLOCKED.get(key) ?? null
}

/**
 * 记录一次「已实际拉起」。
 *
 * 显式点击 `/onboard` 拉起不走 {@link shouldAutoStartWorker} 的节流判定（用户意图优先），
 * 但必须同样记账 —— 否则紧随其后的 `/ensure-worker` 会再拉一次，造成双启。
 */
export function recordAutoStart(key: string, now = Date.now()): void {
  if (key) AUTO_START_AT.set(key, now)
}

/** 查某台设备的拉起护栏状态（`/check` 展示「上次拉起 / 是否节流」） */
export function autoStartStatus(
  key: string,
  now = Date.now(),
): { blocked: AutoStartBlockReason | null; lastStartAt: number | null; throttled: boolean } {
  const id = String(key || '')
  const last = id ? (AUTO_START_AT.get(id) ?? null) : null
  return {
    blocked: id ? (AUTO_START_BLOCKED.get(id) ?? null) : null,
    lastStartAt: last,
    throttled: last !== null && now - last < AUTO_START_THROTTLE_MS,
  }
}

/** 清空护栏状态（单测用；生产进程内不需要重置） */
export function resetAutoStartState(): void {
  AUTO_START_AT.clear()
  AUTO_START_BLOCKED.clear()
}

/**
 * 静默拉起判定（纯逻辑 + 进程级记账）。
 *
 * 返回 `start:true` 时**立即记账**，调用方无需再维护时间戳（漏记就会突破节流）。
 *
 * @param input key=设备标识（无设备名时用安装目录），installed/running/readError 来自
 *              {@link readLocalWorker}，now 可注入以便单测
 */
export function shouldAutoStartWorker(input: {
  key: string
  installed: boolean
  running: boolean
  readError?: string
  /** 进程探测失败：不可判定「未运行」，一律拒拉（Issue #25） */
  probeFailed?: boolean
  /** 现存存活 agent 进程数（含子进程/非 venv 解释器）：>0 一律拒拉 */
  survivingProcesses?: number
  now?: number
}): AutoStartDecision {
  const now = input.now ?? Date.now()
  const key = String(input.key || '')
  if (input.readError) return { start: false, reason: 'read-error' }
  if (!input.installed) return { start: false, reason: 'not-installed' }
  if (input.running) return { start: false, reason: 'running' }
  if (Number(input.survivingProcesses ?? 0) > 0) return { start: false, reason: 'process-alive' }
  if (input.probeFailed) return { start: false, reason: 'probe-failed' }
  const blocked = AUTO_START_BLOCKED.get(key)
  if (blocked) return { start: false, reason: `blocked:${blocked}` }
  const last = AUTO_START_AT.get(key) ?? 0
  if (now - last < AUTO_START_THROTTLE_MS) return { start: false, reason: 'throttled' }
  AUTO_START_AT.set(key, now)
  return { start: true, reason: 'ok' }
}

/** 拉起结果 */
export interface StartWorkerResult {
  started: boolean
  /** 失败原因（成功为空） */
  error: string
  /** 子进程 pid（Windows / POSIX 直起脚本时有值；systemctl 路径为 0） */
  pid: number
}

/** 最小子进程接口（便于单测注入；只需 spawnDetached 用到的方法） */
export interface SpawnedChildLike {
  pid?: number
  on(event: 'error', cb: (err: Error) => void): unknown
  on(event: 'exit', cb: (code: number | null) => void): unknown
  unref(): void
}

/** spawn 签名（默认 `node:child_process.spawn`，单测可注入假实现） */
export type SpawnLike = (
  bin: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean; shell: false },
) => SpawnedChildLike

/**
 * 静默拉起本机 worker（不新建凭据、不改名、不改 env）。
 *
 * POSIX root：`systemctl start runtime-agent.service`（安装脚本装的是 systemd unit）；
 * POSIX 普通用户：直接执行 `<installDir>/start-worker.sh`；
 * Windows：`powershell -ExecutionPolicy Bypass -File <installDir>\start-worker.ps1`。
 *
 * 一律数组传参 + `shell:false`（R1/R2），子进程 `detached` + `stdio:ignore` 脱离本进程存活。
 * `onExit` 用于观察退出码 —— 42 表示凭据被吊销，上层据此永久停止拉起（M3）。
 */
export function startLocalWorker(
  layout: WorkerLayout,
  platform: NodeJS.Platform = osPlatform(),
  onExit?: (code: number | null) => void,
  spawnFn: SpawnLike = spawn as unknown as SpawnLike,
): StartWorkerResult {
  if (platform === 'win32') {
    if (!existsSync(layout.startScript)) {
      return { started: false, error: `启动脚本不存在：${layout.startScript}`, pid: 0 }
    }
    return spawnDetached('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', layout.startScript], onExit, spawnFn, false)
  }
  if (layout.rootMode) {
    const r = runLocal('systemctl', ['start', 'runtime-agent.service'], 20000)
    if (r.ok) return { started: true, error: '', pid: 0 }
    // systemd 不可用（容器）时退回安装脚本自带的启动脚本
    const detail = (r.stderr.trim() || r.error || `exit code ${r.status ?? 'null'}`).slice(0, 200)
    if (!existsSync(layout.startScript)) return { started: false, error: detail, pid: 0 }
    const spawned = spawnDetached(layout.startScript, [], onExit, spawnFn)
    if (!spawned.started) return { started: false, error: `${detail}; ${spawned.error}`, pid: 0 }
    return spawned
  }
  if (!existsSync(layout.startScript)) {
    return { started: false, error: `启动脚本不存在：${layout.startScript}`, pid: 0 }
  }
  return spawnDetached(layout.startScript, [], onExit, spawnFn)
}

/**
 * 启动一个脱离父进程的子进程（失败不抛，返回可读原因）。
 *
 * `started` 由真实 pid 决定：spawn 同步抛错 / 未返回 pid 时为 false；
 * Node 在可执行文件缺失时是**异步**发 `error` 事件的，这里把错误回写到同一个结果对象，
 * 避免过去「恒返回 started=true、错误被吞」把失败误报为拉起成功。
 *
 * `detach` 默认 true（POSIX 的 `start-worker.sh` 需要挣脱父进程）。**Windows 必须传 false**：
 * `powershell.exe` 以 `DETACHED_PROCESS` 启动时会在 ~90ms 内直接 exit 0 且**不执行脚本**
 * （2026-11-20 实测：`-Command "Start-Sleep 3"` 也是 90ms 退出；同参数不 detached 正常跑满 3s；
 * cmd.exe / node 用 detached 正常）。表现为「点『启动 Worker』返回 started=true / pid>0，
 * 但进程秒退、无输出、面板毫无变化」。不 detached 时 ps1 仍作为子进程常驻，
 * 父进程退出也不会连带杀掉它。
 */
function spawnDetached(
  bin: string,
  args: string[],
  onExit?: (code: number | null) => void,
  spawnFn: SpawnLike = spawn as unknown as SpawnLike,
  detach = true,
): StartWorkerResult {
  const result: StartWorkerResult = { started: false, error: '', pid: 0 }
  let child: SpawnedChildLike
  try {
    child = spawnFn(bin, args, {
      detached: detach,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    })
  } catch (err) {
    result.error = String(err instanceof Error ? err.message : err)
    return result
  }
  child.on('error', (err) => {
    result.started = false
    result.pid = 0
    result.error = `启动失败：${String(err instanceof Error ? err.message : err)}`
  })
  if (onExit) child.on('exit', (code) => onExit(code))
  try {
    child.unref()
  } catch {
    /* unref 失败不影响已创建的子进程 */
  }
  const pid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : 0
  result.pid = pid
  result.started = pid > 0
  if (!result.started) result.error = '子进程未能创建（未返回 pid）'
  return result
}