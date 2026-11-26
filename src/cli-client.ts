/**
 * Grape CLI 子进程客户端。
 * 替代原 GrapeClient（fetch HTTP），改为 spawn grape CLI 子进程。
 *
 * 所有工具的 execute 最终都通过这个客户端调 grape CLI。
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** Grape CLI 配置 */
export interface GrapeCliConfig {
  /** grape 可执行文件路径（默认从 PATH 查找） */
  bin: string
  /** Grape 服务端地址 */
  baseUrl: string
  /** Grape API token（grape_ 前缀） */
  token: string
  /** 请求超时秒数（传给 grape --timeout） */
  timeout: number
}

/** CLI 执行结果 */
interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** live 覆盖源：每次读取都重新求值，用于 `.volatile()` 配置的热生效 */
export interface GrapeCliLiveOverrides {
  bin?: () => string | undefined
  baseUrl?: () => string | undefined
  token?: () => string | undefined
  timeout?: () => number | undefined
}

/**
 * 宽松解析 grape CLI 配置：**只读配置、不做校验**。
 *
 * 宿主挂载阶段必须用它 —— 缺 `baseUrl` / `token` 时如果直接抛，整个插件（33 个工具 +
 * `/grape-worker-api/*` 路由）都注册不上，用户连「去设置页填写」的入口都看不到。
 * 校验交给调用点：
 *   · 工具调用 → {@link grapeConfigError} 在 {@link execGrape} 入口抛可读错误；
 *   · 面板 / 接入 → `workerApiAuth()` 返回 error，面板直接展示。
 *
 * 返回对象**带 getter**：每次读取重新解析，所以 `.volatile()` 配置热改后
 * 立即生效、无需重挂插件（这是配置 UI 的核心价值）。
 *
 * @param overrides 静态覆盖（配置值）
 * @param live 动态覆盖源（优先于静态覆盖）
 */
export function resolveGrapeCliConfigLenient(
  overrides?: Partial<GrapeCliConfig>,
  live?: GrapeCliLiveOverrides,
): GrapeCliConfig {
  return {
    get bin() {
      return live?.bin?.() || overrides?.bin || process.env.GRAPE_CLI_BIN || 'grape'
    },
    // Grape 服务地址**只认插件 config**（即 profile 的 cordis.patch.yml →
    // grape-tools.config.baseUrl）：既不读 GRAPE_BASE_URL / GRAPE_SERVER_URL，也不兜底
    // localhost。环境必须显式配置 —— 否则「插件连 A 环境、本机 worker 连 B 环境」这类
    // 串环境问题无法被发现（2026-11-20 用户要求）。
    get baseUrl() {
      return String(live?.baseUrl?.() || overrides?.baseUrl || '').trim().replace(/\/+$/, '')
    },
    // token 与 baseUrl 同一原则：只认插件 config，不读 GRAPE_API_TOKEN ——
    // 否则会出现「地址连 A 环境、令牌却属于 B 环境」的静默串线。
    get token() {
      return String(live?.token?.() || overrides?.token || '').trim()
    },
    get timeout() {
      return live?.timeout?.() || overrides?.timeout
        || parseInt(process.env.GRAPE_TIMEOUT || '30', 10)
    },
  }
}

/**
 * 校验 CLI 配置是否齐备，返回可读错误（空串 = 齐备）。
 *
 * 单独抽出来是为了让「配置缺失」在工具调用时有一条和设置页一致的提示，
 * 而不是拼出 `--base-url ''` 让 CLI 报一个看不懂的错。
 */
export function grapeConfigError(config: GrapeCliConfig): string {
  if (!config.baseUrl) {
    return '[grape-dsh] baseUrl 未配置：请在 profile 的 cordis.patch.yml 里 '
      + 'grape-tools.config.baseUrl 填写 Grape 服务地址（插件不会从环境变量或内置默认值推断环境）。'
  }
  if (!config.token) {
    return '[grape-dsh] token 未配置：请在 profile 的 cordis.patch.yml 里 '
      + 'grape-tools.config.token 填写 Grape API Key（插件不会从 GRAPE_API_TOKEN 推断凭证）。'
  }
  return ''
}

/**
 * 解析并校验 grape CLI 配置：配置不全时抛可读错误。
 *
 * 适合「调用方确实需要一个能用的 CLI」的场景（脚本、测试、一次性调用）；
 * 宿主挂载请用 {@link resolveGrapeCliConfigLenient}。
 */
export function resolveGrapeCliConfig(
  overrides?: Partial<GrapeCliConfig>,
  live?: GrapeCliLiveOverrides,
): GrapeCliConfig {
  const cfg = resolveGrapeCliConfigLenient(overrides, live)
  const error = grapeConfigError(cfg)
  if (error) throw new Error(error)
  return cfg
}

/**
 * 执行 grape CLI 命令，返回解析后的 JSON。
 *
 * @param config - CLI 配置
 * @param args - 命令参数（如 ['issues', 'list', '--owner', 'o', '--repo', 'r', '--json-out']）
 * @param signal - AbortSignal（用于取消）
 * @returns CLI 输出的 JSON 解析结果
 */
export async function execGrape(
  config: GrapeCliConfig,
  args: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  // 配置不全时直接给可读错误（与设置页文案一致），不拼 `--base-url ''` 让 CLI 报怪错。
  const configError = grapeConfigError(config)
  if (configError) throw new Error(configError)

  // 构建完整参数：全局选项 + 子命令
    // token 不进 argv（否则 `ps` / 任务管理器能看到）：改由 GRAPE_API_TOKEN 环境变量传给子进程
    const fullArgs = [
      '--base-url', config.baseUrl,
      '--timeout', String(config.timeout),
      ...args,
    ]

    const result = await spawnGrape(config.bin, fullArgs, signal, config.token)

  // 解析输出
  if (result.exitCode !== 0) {
    const errMsg = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
    throw new Error(`grape CLI: ${errMsg}`)
  }

  const out = result.stdout.trim()
  if (!out) {
    return null
  }

  try {
    return JSON.parse(out)
  } catch {
    // 非 JSON 输出（如 --raw 模式），直接返回文本
    return out
  }
}

/**
 * 轮询 grape events detail 直到终态或超时。
 * 每次轮询时同时查 issues pipeline，返回完整流水线快照。
 * 用于 wait_task 工具。
 *
 * @param config - CLI 配置
 * @param seq - event sequence number
 * @param timeoutSec - 超时秒数
 * @param intervalSec - 轮询间隔秒数
 * @param signal - AbortSignal
 * @param repoInfo - 仓库信息（owner/repo/number），用于查 issues pipeline
 */
export async function pollGrapeUntilTerminal(
  config: GrapeCliConfig,
  seq: number,
  timeoutSec: number,
  intervalSec: number,
  signal?: AbortSignal,
  repoInfo?: { owner: string; repo: string; number: string },
): Promise<unknown> {
  const terminal = new Set(['completed', 'failed', 'cancelled'])
  const deadline = Date.now() + timeoutSec * 1000

  let lastEvent: unknown = null
  let lastStatus = 'unknown'

  while (true) {
    if (signal?.aborted) throw new Error('Aborted')

    // 查单个事件状态
    lastEvent = await execGrape(config, ['events', 'detail', '--seq', String(seq), '--json-out'], signal)

    const status = (lastEvent as Record<string, unknown>)?.status as string | undefined
    lastStatus = status || 'unknown'

    // 如果有仓库信息，同时查完整流水线状态
    if (repoInfo) {
      try {
        const pipelineData = await execGrape(config, [
          'issues', 'pipeline',
          '--owner', repoInfo.owner,
          '--repo', repoInfo.repo,
          '--number', repoInfo.number,
          '--json-out',
        ], signal)

        // 把事件状态合并到 pipeline 数据里
        const pipelineObj = pipelineData as Record<string, unknown>
        if (pipelineObj && typeof pipelineObj === 'object') {
          pipelineObj._event_detail = lastEvent
          pipelineObj._event_seq = seq
          pipelineObj._event_status = lastStatus
        }
        lastEvent = pipelineData
      } catch {
        // pipeline 查询失败时回退到纯事件数据
      }
    }

    if (terminal.has(lastStatus) || Date.now() >= deadline) {
      return lastEvent
    }

    await new Promise(resolve => setTimeout(resolve, intervalSec * 1000))
  }
}

/**
 * spawn grape 子进程，收集 stdout/stderr，处理取消和超时。
 */
function spawnGrape(bin: string, args: string[], signal?: AbortSignal, token = ''): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess
    try {
      proc = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GRAPE_CLI_MODE: 'USER',
          // 令牌只走环境变量：不进 argv，进程列表里看不到
          ...(token ? { GRAPE_API_TOKEN: token } : {}),
        },
      })
    } catch (err) {
      reject(new Error(`grape CLI not found: ${bin} (${err})`))
      return
    }

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    const cleanup = () => {
      proc.stdout?.removeAllListeners()
      proc.stderr?.removeAllListeners()
      proc.removeAllListeners()
    }

    // 处理调用方取消
    const onAbort = () => {
      try { proc.kill('SIGTERM') } catch { /* already exited */ }
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    proc.on('error', (err) => {
      cleanup()
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(new Error(`grape CLI spawn error: ${err.message}`))
    })

    proc.on('close', (code) => {
      cleanup()
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      })
    })
  })
}
