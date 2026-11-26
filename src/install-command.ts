/**
 * 注册本机为 Grape worker 的安装命令（跨平台）+ 执行器。
 *
 * 服务端已提供两套等价端点：
 *   GET /api/runtime/install       → install-worker.sh（Linux / macOS）
 *   GET /api/runtime/install.ps1   → install-worker.ps1（Windows）
 * 这里按宿主 OS 选其中一套，避免给 Windows 用户一条 `| bash` 的死命令。
 */

import { spawn } from 'node:child_process'

import type { HostInfo } from './host-os.js'

/** 下载安装包 + 建 venv + pip 安装，慢网常见 5 分钟以上，留 10 分钟。 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
/** 只保留输出尾部（失败诊断用），安装脚本全程可达数 MB，不能无限留在内存里。 */
const OUTPUT_TAIL_CHARS = 200_000
/** 失败时回传 stderr/stdout 尾部行数（面板直接展示，便于定位）。 */
const FAILURE_TAIL_LINES = 20

/** 允许出现在 token / device 里的字符（token 常为 base64url/URL-safe，不含空格与 shell 元字符）。 */
const SAFE_TOKEN = /^[A-Za-z0-9._~+/=-]{1,512}$/
const SAFE_DEVICE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * baseUrl 只接受 http(s)、无用户名密码、无空白/引号 —— 它会被拼进 shell 命令，
 * 不能让 `"; rm -rf ~ #` 这类值混进去。返回去掉尾部斜杠的规范化 URL。
 */
export function safeBaseUrl(raw: string): string {
  const input = String(raw || '').trim()
  let parsed: URL
  try {
    parsed = new URL(input)
  }
  catch {
    throw new Error('worker 安装：baseUrl 不是合法 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`worker 安装：baseUrl 只支持 http(s)，收到 ${parsed.protocol}`)
  }
  if (!parsed.hostname) throw new Error('worker 安装：baseUrl 缺少主机名')
  if (parsed.username || parsed.password) throw new Error('worker 安装：baseUrl 不允许携带用户名/密码')
  if (/[\s"'`;$&|<>(){}\\]/.test(input)) throw new Error('worker 安装：baseUrl 含非法字符')
  return parsed.toString().replace(/\/+$/, '')
}

export function safeToken(token: string): string {
  const t = String(token || '')
  if (!SAFE_TOKEN.test(t)) throw new Error('worker 安装：token 含非法字符（只允许字母数字与 . _ ~ + / = -）')
  return t
}

export function safeDevice(device: string): string {
  const d = String(device || '').trim()
  if (!d) return ''
  if (!SAFE_DEVICE.test(d)) throw new Error('worker 安装：device 含非法字符（只允许字母数字与 . _ -）')
  return d
}

/** POSIX shell 单引号转义：' -> '\'' */
export function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** PowerShell 单引号转义：' -> '' */
export function psQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** 安装命令从环境变量读 token 时使用的变量名（避免 token 出现在进程命令行里）。 */
export const INSTALL_TOKEN_ENV = 'GRAPE_INSTALL_TOKEN'

export function workerInstallCommand(
  baseUrl: string,
  token: string,
  device: string,
  host: HostInfo,
  serverOverride = '',
): string {
  const base = safeBaseUrl(serverOverride || baseUrl || '')
  const tok = safeToken(token)
  const dev = safeDevice(device)
  return buildInstallCommand(base, tok, dev, host, false)
}

/**
 * 执行用命令：token 不进命令行，改为在命令里引用环境变量，调用方把值放进 spawn 的 env。
 * 这样 `ps`/任务管理器看不到 token，也不会有任何值被拼进 shell 字符串。
 */
export function workerInstallCommandWithEnv(
  baseUrl: string,
  token: string,
  device: string,
  host: HostInfo,
  serverOverride = '',
): { command: string; env: Record<string, string> } {
  const base = safeBaseUrl(serverOverride || baseUrl || '')
  const tok = safeToken(token)
  const dev = safeDevice(device)
  return { command: buildInstallCommand(base, '', dev, host, true), env: { [INSTALL_TOKEN_ENV]: tok } }
}

function buildInstallCommand(
  base: string,
  token: string,
  dev: string,
  host: HostInfo,
  fromEnv: boolean,
): string {
  const tokenExpr = fromEnv
    ? (host.isWindows ? `$env:${INSTALL_TOKEN_ENV}` : `"$${INSTALL_TOKEN_ENV}"`)
    : (host.isWindows ? psQuote(token) : shQuote(token))
  const devExpr = dev ? ` -Device ${psQuote(dev)}` : ''
  if (host.isWindows) {
    return `& ([scriptblock]::Create((irm ${psQuote(`${base}/api/runtime/install.ps1`)})))`
      + ` -Token ${tokenExpr} -Server ${psQuote(base)}${devExpr}`
  }
  const devSh = dev ? ` --device ${shQuote(dev)}` : ''
  return `curl -sSL ${shQuote(`${base}/api/runtime/install`)}`
    + ` | bash -s -- --token ${tokenExpr} --server ${shQuote(base)}${devSh}`
}

/** 给 UI 显示的一行人类可读说明 */
export function workerInstallHint(host: HostInfo): string {
  return host.isWindows
    ? 'Windows：在 PowerShell 里执行（脚本走 install.ps1，后台 Start-Process 启动）'
    : `macOS/Linux：在终端里执行（脚本走 install.sh，${host.os === 'darwin' ? 'launchd/nohup' : 'systemd/nohup'} 启动）`
}

export interface InstallRunOptions {
  /** 每收到一行输出回调一次（面板用于显示安装进度） */
  onLine?: (line: string) => void
  /** 额外环境变量（执行用命令从 INSTALL_TOKEN_ENV 读 token，避免出现在命令行里） */
  env?: Record<string, string>
}

/**
 * 在当前宿主机上执行 workerInstallCommand() 生成的安装命令（**异步流式**）。
 *
 * 为什么必须异步：安装脚本要下载 80MB+ 的包、建 venv、pip 安装，动辄 1~5 分钟。
 * 早期实现用 `execFileSync` —— 那是同步调用，会**阻塞宿主 Node 事件循环**：
 * 安装期间面板的 `/check`、`/onboard` 等全部请求一起挂起，用户看到的就是
 * 「正在检查接入状态…」长时间假死（2026-11-19 实测）。改为 `spawn` + 流式读取后，
 * 事件循环保持可用，面板可以持续刷新并显示安装进度。
 *
 * 平台差异（两个坑都实际踩过）：
 *   1. Windows：命令是 PowerShell 片段（`& ([scriptblock]::Create((irm ...))) ...`）。
 *      交给 cmd.exe 会报「此时不应有 &。」——`&` 是 cmd 的命令分隔符，脚本一行都不会执行。
 *      所以走 `powershell.exe -EncodedCommand`（base64 / UTF-16LE），绕开引号与中文路径解析。
 *   2. macOS / Linux：命令是 POSIX 片段（`curl … | bash -s -- …`），显式交给 `/bin/sh -c`，
 *      不依赖默认 shell，也不受用户登录 shell（zsh）的别名/配置影响。
 *
 * 流式收集天然没有 `maxBuffer` 上限（早期曾因默认 1MB 触发 `ENOBUFS` 把安装中途杀掉），
 * 这里只保留输出尾部用于失败诊断。
 */
export function runWorkerInstallCommand(
  command: string,
  options: InstallRunOptions = {},
): Promise<{ stdout: string }> {
  const isWindows = process.platform === 'win32'
  const bin = isWindows ? 'powershell.exe' : '/bin/sh'
  const args = isWindows
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]
    : ['-c', command]

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(options.env ?? {}) },
      })
    }
    catch (error) {
      reject(toInstallError(error))
      return
    }

    let outText = ''
    let errText = ''
    let pendingOut = ''
    let pendingErr = ''
    let timedOut = false
    let spawnError: Error | null = null

    const emitLine = (line: string): void => {
      const text = line.trim()
      if (text && options.onLine) options.onLine(text)
    }
    const consume = (chunk: string, isErr: boolean): void => {
      if (isErr) {
        errText = `${errText}${chunk}`.slice(-OUTPUT_TAIL_CHARS)
        pendingErr += chunk
        const parts = pendingErr.split(/\r?\n/)
        pendingErr = parts.pop() ?? ''
        for (const line of parts) emitLine(line)
        return
      }
      outText = `${outText}${chunk}`.slice(-OUTPUT_TAIL_CHARS)
      pendingOut += chunk
      const parts = pendingOut.split(/\r?\n/)
      pendingOut = parts.pop() ?? ''
      for (const line of parts) emitLine(line)
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      }
      catch { /* 已退出 */ }
    }, INSTALL_TIMEOUT_MS)

    child.stdout?.on('data', (data: Buffer) => consume(data.toString('utf-8'), false))
    child.stderr?.on('data', (data: Buffer) => consume(data.toString('utf-8'), true))
    child.on('error', (error) => {
      spawnError = error
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      emitLine(pendingOut)
      emitLine(pendingErr)
      if (spawnError) {
        reject(toInstallError(spawnError))
        return
      }
      if (timedOut) {
        reject(new Error(
          `worker 安装命令超时（${Math.round(INSTALL_TIMEOUT_MS / 60000)} 分钟）`
          + `${tailText(errText || outText) ? `\n${tailText(errText || outText)}` : ''}`,
        ))
        return
      }
      if (code === 0) {
        resolve({ stdout: outText })
        return
      }
      reject(toInstallError({ message: `exit code ${code ?? 'null'}`, stdout: outText, stderr: errText }))
    })
  })
}

function tailText(text: string): string {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-FAILURE_TAIL_LINES)
    .join('\n')
}

/** 把子进程失败包装成人类可读的错误：保留原因 + 输出尾部（面板会直接显示这段）。 */
function toInstallError(error: unknown): Error {
  const e = error as { message?: string; stdout?: string; stderr?: string } | undefined
  const tail = tailText(String(e?.stderr ?? '')) || tailText(String(e?.stdout ?? ''))
  const message = ['worker 安装命令执行失败', String(e?.message ?? error)]
    .concat(tail ? [tail] : [])
    .join('\n')
  return new Error(message)
}
