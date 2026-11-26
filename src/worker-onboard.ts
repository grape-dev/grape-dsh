/**
 * 本机接入 Worker —— 宿主侧动作通道（E 方案，2026-10-26）
 *
 * 为什么这件事必须由插件做、而且只能由宿主半做：
 *   · 浏览器点不了"在用户自己机器上装东西"（跨机器，无本地执行权）；
 *     但 dsh 就跑在**要被接入的那台机器上**，插件宿主半既有用户 token、
 *     又能通过 ctx.terminalController 在本机起进程 —— 所以这件事只有它能做。
 *
 * 为什么把"接入"做成一条【可见的终端命令】而不是后台静默安装：
 *   · 侧栏终端里用户能**亲眼看到**命令与输出，随时可以打断 —— 这是最后一道、
 *     也是最实在的一道确认（见设计文档 §4.5.6「(c) 终端可见」）；
 *   · 安装器本身是平台既有的 install-worker.sh（幂等），不新增安装逻辑。
 *
 * ⚠️ 鉴权（设计文档 §4.5.6 的硬约束，实测过：插件 webServer 路由【默认没有鉴权】）：
 *   本文件所有 POST 动作都必须同时满足三条，缺一不可：
 *     ① 同源校验：Sec-Fetch-Site 必须是 same-origin，且 Origin 与 Host 一致；
 *     ② 一次性 nonce，放在**自定义请求头**里 —— 自定义头会让浏览器必须先发 CORS
 *        预检，而我们不回应预检，于是跨站"简单请求"根本到不了这里（CSRF 直接死掉）；
 *     ③ nonce 单次消费 + 5 分钟过期。
 *   读接口（nonce 本身）同样要过①，避免给任何来路不明的调用者发凭据。
 *   本地恶意进程可以伪造以上头 —— 但它本就有本机执行权，伪造不带来任何提权，
 *   故这三条针对的是"用户访问了别的网站被借用浏览器"这一类真实风险。
 */
import { detectHostInfo } from './host-os.js'
import { workerInstallCommand } from './install-command.js'
import { normalizeServerUrl, serverUrlMismatch, type LocalWorkerFacts } from './local-runtime.js'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'

/** 只声明用到的宿主服务最小面，避免 import dsh 内部包类型 */
export interface WorkerOnboardDeps {
  /** 终端控制器（ctx.terminalController，已实测可用） */
  terminalController?: {
    create?: (agent: unknown, request: unknown, signal: AbortSignal) => Promise<unknown>
    follow?: (agent: unknown, id: string, attachmentId: string, signal: AbortSignal) => AsyncIterable<unknown>
    write?: (agent: unknown, id: string, attachmentId: string, data: string) => Promise<void>
  }
  /** agent 注册表（ctx.agents，取"当前会话的 agent"） */
  agents?: { currentInitiator?: () => unknown; list?: () => unknown[] }
  /** 插件配置（baseUrl / token / timeout） */
  getConfig: () => { baseUrl?: string; token?: string; timeout?: number }
  /** 日志（可选） */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void }
}

/** 动作通道前缀：与只读的 panel-api 分开，读/写两条路径不混 */
export const WORKER_API_PREFIX = '/grape-worker-api'

const NONCE_TTL_MS = 5 * 60 * 1000
/** follow 排空的兜底上限：安装过程一般 1-3 分钟，留 15 分钟余量后收手 */
const FOLLOW_BUDGET_MS = 15 * 60 * 1000

const NONCES = new Map<string, number>()

function pruneNonces(): void {
  const now = Date.now()
  for (const [k, exp] of NONCES) if (exp <= now) NONCES.delete(k)
}

function issueNonce(): string {
  pruneNonces()
  const n = randomBytes(24).toString('base64url')
  NONCES.set(n, Date.now() + NONCE_TTL_MS)
  return n
}

function consumeNonce(n: unknown): boolean {
  pruneNonces()
  if (typeof n !== 'string' || !n) return false
  const exp = NONCES.get(n)
  if (!exp || exp <= Date.now()) return false
  NONCES.delete(n)   // 一次性：消费即失效
  return true
}

interface ReqLike {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
}

/**
 * 同源校验：见文件头 ①。
 *
 * ⚠️ 实测踩过的坑（2026-10-26）：**浏览器对同源 GET 不带 `Origin` 头**
 * （`Origin` 只在 POST / 跨站请求时发），第一版写成"没有 Origin 就拒"，
 * 结果把面板自己那发合法的 GET 也拒了。正确判定：
 */
function isSameOrigin(req: ReqLike): boolean {
  const h = req.headers ?? {}
  const pick = (k: string): string => {
    const v = h[k]
    return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
  }
  const sfs = pick('sec-fetch-site').toLowerCase()
  const origin = pick('origin')
  const host = pick('host')
  // ① 现代浏览器必带 Sec-Fetch-Site，且值最可信：
  //    same-origin 放行；cross-site / same-site / none 一律拒。
  if (sfs) return sfs === 'same-origin'
  // ② 没有该头（老浏览器 / 非浏览器）：退回 Origin 与 Host 比对。
  //    注意 GET 可能没有 Origin —— 那就落到 ③。
  if (origin) {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  // ③ 两个头都没有：不是浏览器同源请求（本地脚本 / curl）→ 拒。
  return false
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function json(res: unknown, status: number, body: unknown): void {
  const r = res as { writeHead?: (s: number, h: Record<string, string>) => void; end?: (s: string) => void }
  r.writeHead?.(status, { 'content-type': 'application/json; charset=utf-8' })
  r.end?.(JSON.stringify(body))
}

/** 用用户 token 直接调平台签发接口（CLI 没有这个写命令，故此处走 HTTPS）。 */
export async function mintCredential(cfg: { baseUrl?: string; token?: string; timeout?: number }, name: string): Promise<{ token: string; id: number; name: string }> {
  const base = String(cfg.baseUrl ?? '').replace(/\/+$/, '')
  const token = String(cfg.token ?? '')
  if (!base) throw new Error('未配置 baseUrl')
  if (!token) throw new Error('未配置 token（插件配置里的 Grape API Key）')
  const url = `${base}/api/settings/runtime-credentials`
  const timeoutMs = Math.max(5, Number(cfg.timeout ?? 30)) * 1000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      // scope 默认个人（user）；owner 由平台取当前登录用户，不可选
      body: JSON.stringify({ name, scope: 'user', repo_key: '' }),
      signal: ac.signal,
    })
    const text = await resp.text()
    let data: Record<string, unknown> = {}
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      /* 非 JSON 响应，下面统一报错 */
    }
    if (!resp.ok) {
      const detail = (data.detail ?? data.message ?? text) as unknown
      const msg = typeof detail === 'object' && detail !== null
        ? String((detail as { message?: unknown }).message ?? JSON.stringify(detail))
        : String(detail)
      throw new Error(`签发凭据失败 HTTP ${resp.status}: ${msg.slice(0, 200)}`)
    }
    const rta = String(data.token ?? '')
    if (!rta) throw new Error('签发凭据成功但响应里没有 token 字段')
    return { token: rta, id: Number(data.id ?? 0), name: String(data.name ?? name) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 列出已有凭据（不含明文）：用来判断"这台机器是否已经接入过"。
 *
 * 失败必须抛错，不能返回 `[]` —— 空数组会把「服务端不可达 / 鉴权失败」伪装成
 * 「没有凭据」，调用方据此重复签发，正是本次事故的形态。上层统一按 `unknown` 处理。
 */
export async function listCredentials(cfg: { baseUrl?: string; token?: string; timeout?: number }): Promise<Array<{ id: number; name: string; status: string; device_name: string }>> {
  const base = apiBase(cfg)
  const token = String(cfg.token ?? '')
  if (!base) throw new Error('未配置 baseUrl')
  if (!token) throw new Error('未配置 token（插件配置里的 Grape API Key）')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.max(5, Number(cfg.timeout ?? 30)) * 1000)
  try {
    const resp = await fetch(`${base}/api/settings/runtime-credentials`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: ac.signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`读取凭据失败 HTTP ${resp.status}: ${text.slice(0, 200)}`)
    }
    const data = (await resp.json()) as { credentials?: Array<Record<string, unknown>> }
    return (data.credentials ?? []).map((c) => ({
      id: Number(c.id ?? 0),
      name: String(c.name ?? ''),
      status: String(c.status ?? ''),
      device_name: String(c.device_name ?? ''),
    }))
  } finally {
    clearTimeout(timer)
  }
}

/** 读 POST body（小 JSON，限长）。 */
function readJsonBody(req: unknown, maxBytes = 4096): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const r = req as { on?: (e: string, cb: (c?: unknown) => void) => void }
    if (typeof r.on !== 'function') return resolve({})
    let size = 0
    const chunks: Buffer[] = []
    r.on('data', (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c ?? ''))
      size += buf.length
      if (size > maxBytes) return resolve({})   // 超长直接放弃解析
      chunks.push(buf)
    })
    r.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
    r.on('error', () => resolve({}))
  })
}

export function createWorkerOnboardHandler(deps: WorkerOnboardDeps) {
  const log = (m: string) => deps.logger?.info?.(`[grape-dsh] ${m}`)
  const warn = (m: string) => deps.logger?.warn?.(`[grape-dsh] ${m}`)

  /** GET …/nonce —— 发一次性 nonce（同样要过同源校验） */
  async function handleNonce(req: ReqLike, res: unknown): Promise<void> {
    if (!isSameOrigin(req)) {
      const h = (req.headers ?? {}) as Record<string, unknown>
      warn(`nonce 请求未通过同源校验，已拒绝（sfs=${String(h['sec-fetch-site'] ?? '-')} origin=${String(h['origin'] ?? '-')} host=${String(h['host'] ?? '-')}）`)
      json(res, 403, { ok: false, error: 'forbidden: cross-site request rejected' })
      return
    }
    json(res, 200, { ok: true, nonce: issueNonce() })
  }

  /** POST …/install —— 签发凭据 + 在侧栏终端里执行平台既有安装器 */
  async function handleInstall(req: ReqLike, res: unknown): Promise<void> {
    if (!isSameOrigin(req)) {
      const h = (req.headers ?? {}) as Record<string, unknown>
      warn(`install 请求未通过同源校验，已拒绝（sfs=${String(h['sec-fetch-site'] ?? '-')} origin=${String(h['origin'] ?? '-')} host=${String(h['host'] ?? '-')}）`)
      json(res, 403, { ok: false, error: 'forbidden: cross-site request rejected' })
      return
    }
    const h = req.headers ?? {}
    const nonce = Array.isArray(h['x-grape-nonce']) ? h['x-grape-nonce'][0] : h['x-grape-nonce']
    if (!consumeNonce(nonce)) {
      warn('install 请求 nonce 无效或已用，已拒绝')
      json(res, 403, { ok: false, error: 'forbidden: invalid or spent nonce' })
      return
    }

    const tc = deps.terminalController
    const agents = deps.agents
    if (!tc?.create || !tc.follow || !tc.write || !agents?.list) {
      json(res, 501, {
        ok: false,
        error: 'terminalController/agents 不可用：本部署没有交互终端（headless 部署无此能力）',
      })
      return
    }

    let agent: unknown
    try {
      agent = agents.currentInitiator?.() ?? (agents.list?.() ?? [])[0]
    } catch {
      /* 下面统一按取不到处理 */
    }
    if (!agent) {
      json(res, 409, { ok: false, error: '当前没有活动会话（终端是 Session 级资源），请先在本窗口发一条消息' })
      return
    }

    const host = (() => {
      try {
        return hostname()
      } catch {
        return 'unknown-host'
      }
    })()
    const baseName = `dsh-${host}`.slice(0, 88)

    // 0）先看这台机器是不是已经签过凭据。凭据名全局唯一，重复签发会 400，
    //    所以这里主动查一次，把"已接入"变成一个正常状态而不是报错。
    //    ⚠️ 语义边界：凭据存在 ≠ 本机真的装过 worker（可能只是签了没装），
    //       所以文案只说"已存在同名凭据"，并同时给出"重新签发"这条路。
    const body = (req as { method?: string; headers?: unknown; on?: unknown }).on
      ? await readJsonBody(req)
      : {}
    const reissue = body.reissue === true
    let existing: Awaited<ReturnType<typeof listCredentials>>
    try {
      existing = await listCredentials(deps.getConfig())
    } catch (err) {
      // 读不到已有凭据就无法安全去重：宁可失败，也不能当成「没有凭据」重复签发。
      warn(`读取已有凭据失败: ${String(err)}`)
      json(res, 502, { ok: false, error: `读取已有凭据失败: ${String(err instanceof Error ? err.message : err)}` })
      return
    }
    const same = existing.find((c) => c.name === baseName && c.status === 'active')
    if (same && !reissue) {
      log(`本机已存在同名凭据 #${same.id}（${same.name}），不重复签发`)
      json(res, 200, {
        ok: true,
        alreadyExists: true,
        credentialId: same.id,
        credentialName: same.name,
        deviceName: same.device_name || baseName,
      })
      return
    }

    // ① 签发凭据（明文仅此一次）。reissue 时用唯一后缀，避免撞名。
    let cred: { token: string; id: number; name: string }
    try {
      let name = baseName
      if (same) {
        for (let i = 2; i <= 20; i += 1) {
          const candidate = `${baseName}-${i}`
          if (!existing.some((c) => c.name === candidate)) {
            name = candidate
            break
          }
        }
      }
      cred = await mintCredential(deps.getConfig(), name)
    } catch (err) {
      warn(`签发凭据失败: ${String(err)}`)
      json(res, 502, { ok: false, error: String(err instanceof Error ? err.message : err) })
      return
    }

    // ② 组装平台既有安装命令（按宿主 OS 选 install.sh / install.ps1，见 install-command.ts）
    const base = String(deps.getConfig().baseUrl ?? '').replace(/\/+$/, '')
    const command = workerInstallCommand(base, cred.token, baseName, detectHostInfo())

    // ③ 在本机开一个终端（id / attachmentId 均由调用方生成），并把命令送进去
    const tid = `grape-worker-${Date.now().toString(36)}`
    const att = `${tid}-att`
    try {
      await tc.create(agent, { id: tid, cols: 100, rows: 26 }, AbortSignal.timeout(15000))
      // ⚠️ 顺序不能反：follow 才取得【独占输入附件】，先 write 会被拒
      //    （实测报错 "Terminal input is controlled by another attachment"）
      const ctl = new AbortController()
      const deadline = Date.now() + FOLLOW_BUDGET_MS
      void (async () => {
        try {
          for await (const _frame of tc.follow!(agent, tid, att, ctl.signal)) {
            if (Date.now() > deadline) break
          }
        } catch {
          /* 流结束/被打断都正常 */
        } finally {
          ctl.abort()
        }
      })()
      await sleep(400)   // 等 follow 建立、拿到输入控制
      // ⚠️ 有意**不加换行**：命令写进终端、停在提示符前，由用户按回车执行。
      //    两个理由：
      //    ① 这是最实在的确认 —— 用户先看到完整命令（含它要装什么），再决定执行；
      //       鉴权那两道（同源 + nonce）防的是外部调用者，这一道防的是"手滑点一下"。
      //    ② 本机可能**已经**是 worker（安装器默认装到 ~/grape，换目录会装出第二份）。
      //       自动回车等于"误点一次多一个 worker"，代价太大，不值得为省一次回车。
      await tc.write(agent, tid, att, command)
    } catch (err) {
      warn(`写入终端失败: ${String(err)}`)
      json(res, 500, { ok: false, error: `终端写入失败: ${String(err instanceof Error ? err.message : err)}` })
      return
    }

    log(`已把接入命令写入本机终端（凭据 #${cred.id} name=${cred.name}，等待用户按回车执行）`)
    // 不回传 rta_ 明文：命令已经进了终端，前端不需要也不该拿到它
    json(res, 200, { ok: true, terminalId: tid, credentialId: cred.id, credentialName: cred.name, deviceName: baseName })
  }

  /**
   * 单一入口：webServer.register 按前缀只给一个 handler，故在这里按
   * method + path 派发。只有两个动作，不做通用路由框架。
   */
  async function handle(req: ReqLike, res: unknown): Promise<void> {
    const method = String(req.method ?? 'GET').toUpperCase()
    const path = String(req.url ?? '').split('?')[0].replace(WORKER_API_PREFIX, '') || '/'
    if (method === 'GET' && (path === '/nonce' || path === '/nonce/')) {
      await handleNonce(req, res)
      return
    }
    if (method === 'POST' && (path === '/install' || path === '/install/')) {
      await handleInstall(req, res)
      return
    }
    json(res, 404, { ok: false, error: `unknown route: ${method} ${path}` })
  }

  return { handle }
}

// ── 接入判定与事务化（Issue #2）──────────────────────────────────────────────
//
// 事故根因：`/onboard` 过去**无条件**签发新凭据再重装。服务端 runtime / engine 行归属
// credential，换凭据即产生新 `runtime_id`，场景 `nodes[].engine_runtime_ids` 绑定随之失效，
// 旧 `rta_` 不可恢复。这里把「要不要动服务端」收敛成一个纯函数（{@link decideOnboard}），
// 铁律：**本地已安装就绝不安装、绝不新建凭据**（只有「同设备名重建」且用户确认才例外）。

/** 服务端视角的接入状态（由 {@link listCredentials} / {@link listServerDevices} 汇总） */
export interface OnboardServerState {
  /** 与本机匹配到的凭据（按 device_name 优先、name 兜底） */
  credential?: { id: number; name: string; status: string; device_name: string } | null
  /** 服务端设备行（`settings runtime devices` 中同名设备） */
  device?: { device_name: string; health?: string } | null
  /** 服务端不可达 / 未配置 → 无法判定（此时以本地事实为准，绝不产生副作用） */
  unknown?: boolean
}

/** `/onboard` 的动作（Issue #25 收敛 + 2026-11-20 环境隔离） */
export type OnboardAction =
  | 'read-error'
  | 'initialize'
  | 'already-connected'
  | 'conflict'
  /** 本机 worker 属于**别的环境**（runtime.env 的 RUNTIME_SERVER_URL ≠ 插件 config.baseUrl） */
  | 'server-mismatch'

/** 状态机输出（`status` 直接作为 HTTP 状态码） */
export interface OnboardDecision {
  action: OnboardAction
  status: number
  /** 面向用户的一句话（前端原样展示） */
  message: string
}

/**
 * `/onboard` 状态机（纯函数，可单测）—— **按「本环境有没有这台设备」判定**。
 *
 * 用户口径（2026-11-19 收敛）：
 *   本环境查到设备行  → already-connected，只展示
 *   本环境查不到设备行 → initialize（签发凭据 + 写 runtime.env + 启动），
 *                        不管本机现在是否装着/跑着别的环境的 worker
 *   本环境有同名 active 凭据但没有设备行 → conflict（token 拿不回来，重复签发会撞唯一键）
 *   本机信息读不出来 → read-error（禁用接入，避免诱导重装）
 *
 * 不再做设备名比对；**服务地址比对保留且是硬判据**（2026-11-20 用户要求）：
 * 本机 `RUNTIME_SERVER_URL` 与本插件 `config.baseUrl` 对不上 → 本环境视同「没有 worker」，
 * 必须重装（重写 runtime.env + 重新签发凭据），不允许拿别的环境的 worker 顶替。
 *
 * ⚠️ 这里看到的 `server` 必须是**按目标设备名**查出来的（见 {@link resolveOnboardDeviceName}）；
 * 否则「用 004 查、用 003 装」会让 `initialize` 与实际签发名不一致。
 */
export function decideOnboard(
  local: LocalWorkerFacts,
  server: OnboardServerState,
  opts: { confirm?: boolean; baseUrl?: string } = {},
): OnboardDecision {
  if (local.readError) {
    return { action: 'read-error', status: 500, message: `设备信息读取失败：${local.readError}` }
  }
  // 环境串线：本机 worker 连的是别的环境。必须最优先判 —— 否则本环境里那条「历史设备行」
  // 会把状态推到 already-connected，用户永远看不到「需要重装」。
  if (local.installed && opts.baseUrl && serverUrlMismatch(local.serverUrl, opts.baseUrl)) {
    return {
      action: 'server-mismatch',
      status: 200,
      message: `本机 worker 连接的是 ${local.serverUrl || '（runtime.env 未记录地址）'}，`
        + `与插件配置的 ${opts.baseUrl} 不一致：本环境视同没有 Worker，需要重新接入`
        + '（会重写 runtime.env 并重装 worker）。',
    }
  }
  if (server.device) {
    return { action: 'already-connected', status: 200, message: '本环境已登记该设备，无需重新接入。' }
  }
  // 服务端状态读不出来（凭据列表 401/403、网络不可达等）：本机已装 worker 时**绝不猜**。
  // 猜成 initialize 就会再签发一条凭据 → 新 runtime_id → 场景节点绑定失效（事故同形）。
  // 未安装的情况保持 initialize（没有可保护的既有身份，且签发本身也会因同一原因报错）。
  if (server.unknown && local.installed) {
    return {
      action: 'conflict',
      status: 409,
      message: '服务端状态读取失败（凭据 / 设备列表不可读），本机已安装 worker：'
        + '无法确认本环境是否已登记该设备，为避免重复签发凭据，已阻止接入；'
        + '请检查插件 API Key 与网络后重试。',
    }
  }
  if (server.credential && server.credential.status === 'active') {
    return {
      action: 'conflict',
      status: 409,
      message: `本环境已存在同名凭据 #${server.credential.id}（active），但其 token 无法取回；`
        + '请在该环境吊销后重新接入，或换一个设备名。',
    }
  }
  return { action: 'initialize', status: 200, message: '本环境尚未登记设备。' }
}

/** 在线校验结果：`online` 已注册上线；`pending` 安装成功但注册未在预算内完成；`failed` 明确失败 */
export type VerifyState = 'online' | 'pending' | 'failed'

/** 事务化接入的依赖（全部可注入，便于单测） */
export interface OnboardTransactionDeps {
  /** 目标设备名（新建用默认命名；重建必须沿用本机 `RUNTIME_DEVICE_NAME`） */
  deviceName: string
  /** 签发凭据（返回明文 token，仅本次使用） */
  mint: (name: string) => Promise<{ id: number; token: string; name: string }>
  /** 安装/重装（安装器负责写 runtime.env 与启动 worker） */
  install: (token: string, deviceName: string) => Promise<void>
  /**
   * 在线校验：**必须按本次 `created.id` 精确匹配**，不能按设备名。
   * 同一 `device_name` 可能还有旧凭据行，按名字匹配会读到旧行并把新凭据误判 failed → 撤销刚装好的身份。
   */
  verify: (credentialId: number, deviceName: string) => Promise<VerifyState>
  /** 按本次 created.id 撤销 */
  revoke: (id: number) => Promise<void>
  /**
   * 签发**结果未知**（超时/中断/网络）时按名称回查刚签发的凭据。
   * 只在这种情况下调用：明确失败（HTTP 4xx）时同名凭据可能属于别的机器，绝不能回查撤销。
   */
  lookup?: (name: string) => Promise<{ id: number; name: string } | null>
  log?: (message: string) => void
}

/** 签发失败是否属于「结果不确定」（可能已在服务端建出凭据，需要回查撤销） */
function isUncertainMintFailure(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return true
  const msg = String(e?.message ?? err ?? '')
  return /(abort|timeout|timed out|超时|network|fetch failed|socket hang up|ECONN|ETIMEDOUT)/i.test(msg)
}

/** 事务化接入结果 */
export interface OnboardTransactionResult {
  ok: boolean
  credentialId: number
  credentialName: string
  /** 已确认上线 */
  online: boolean
  /** 安装成功但注册尚未确认（仍算成功，绝不在此时撤销刚装好的凭据） */
  pending: boolean
}

/**
 * credential 事务化：`create → install → verify`，任一步失败按**本次 created.id** 撤销。
 *
 * 为什么失败才撤销：新凭据一旦没被任何 worker 用过，它就是孤儿（占着唯一名、污染设备列表）；
 * 一旦安装已成功，凭据就承载了真实设备身份 —— 此时撤销等于把机器再打离线一次
 * （正是本次事故的形态），所以注册超时只报 `pending`，不撤销。
 */
export async function runOnboardTransaction(deps: OnboardTransactionDeps): Promise<OnboardTransactionResult> {
  const log = deps.log ?? (() => {})
  let created: { id: number; token: string; name: string } | null = null
  try {
    created = await deps.mint(deps.deviceName)
    await deps.install(created.token, deps.deviceName)
    const state = await deps.verify(created.id, deps.deviceName)
    if (state === 'failed') throw new Error(`接入校验失败：设备 ${deps.deviceName} 未能注册上线`)
    return {
      ok: true,
      credentialId: created.id,
      credentialName: created.name,
      online: state === 'online',
      pending: state === 'pending',
    }
  } catch (err) {
    if (created) {
      try {
        await deps.revoke(created.id)
        log(`onboard 失败，已撤销本次凭据 #${created.id}`)
      } catch (revokeErr) {
        // 撤销失败不覆盖原始错误：主错误才是用户要看的
        log(`onboard 失败且撤销凭据 #${created.id} 也失败：${String(revokeErr)}`)
      }
    } else if (deps.lookup && isUncertainMintFailure(err)) {
      // mint 超时/中断时服务端可能已经建出凭据，但拿不到 id；按唯一名称回查找回并撤销，防孤儿。
      try {
        const orphan = await deps.lookup(deps.deviceName)
        if (orphan && Number(orphan.id) > 0) {
          await deps.revoke(orphan.id)
          log(`onboard 签发结果未知，已按名称回查并撤销孤儿凭据 #${orphan.id}`)
        }
      } catch (lookupErr) {
        log(`onboard 签发结果未知，按名称回查/撤销失败：${String(lookupErr)}`)
      }
    }
    throw err
  }
}

/** 服务端设备行（`GET /api/settings/runtime-devices` 的精简面） */
export interface ServerDevice {
  credential_id: number
  name: string
  device_name: string
  credential_status: string
  health: string
  last_seen_at: string | null
  /** worker 版本（服务端上报；缺失为空串） */
  worker_version: string
}

function apiBase(cfg: { baseUrl?: string }): string {
  return String(cfg.baseUrl ?? '').replace(/\/+$/, '')
}

/**
 * 列服务端设备（按 `credential_id` 分组，含健康度与 worker 版本）。
 *
 * 分页是硬约束（线上设备数百台）：按 `total` 翻页聚合，上限 20 页防止无限循环。
 * 拉不到就返回空数组 —— 调用方按「无法判定」处理（绝不当成冲突）。
 */
export async function listServerDevices(
  cfg: { baseUrl?: string; token?: string; timeout?: number },
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<ServerDevice[]> {
  const base = apiBase(cfg)
  const token = String(cfg.token ?? '')
  if (!base || !token) return []
  const pageSize = Math.max(1, Number(opts.pageSize ?? 100))
  const maxPages = Math.max(1, Number(opts.maxPages ?? 20))
  const timeoutMs = Math.max(5, Number(cfg.timeout ?? 30)) * 1000
  const out: ServerDevice[] = []
  for (let page = 1; page <= maxPages; page += 1) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const resp = await fetch(`${base}/api/settings/runtime-devices?page=${page}&page_size=${pageSize}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: ac.signal,
      })
      if (!resp.ok) break
      const data = (await resp.json()) as { devices?: Array<Record<string, unknown>>; total?: unknown }
      const rows = Array.isArray(data.devices) ? data.devices : []
      for (const row of rows) {
        out.push({
          credential_id: Number(row.credential_id ?? 0),
          name: String(row.name ?? ''),
          device_name: String(row.device_name ?? ''),
          credential_status: String(row.credential_status ?? ''),
          health: String(row.health ?? ''),
          last_seen_at: row.last_seen_at ? String(row.last_seen_at) : null,
          worker_version: String(row.worker_version ?? ''),
        })
      }
      const total = Number(data.total ?? 0)
      if (!rows.length || !Number.isFinite(total) || out.length >= total) break
    } catch {
      break
    } finally {
      clearTimeout(timer)
    }
  }
  return out
}

/**
 * 吊销单个凭据（`POST /api/settings/runtime-credentials/{cid}/revoke`）。
 *
 * 只用于「本次接入失败回滚」与用户点「注销本机」两条路径；**只按明确拿到的 id**，
 * 绝不按名字模糊匹配（同名凭据可能属于另一台机器）。
 */
export async function revokeCredential(
  cfg: { baseUrl?: string; token?: string; timeout?: number },
  cid: number,
): Promise<void> {
  const base = apiBase(cfg)
  const token = String(cfg.token ?? '')
  const id = Number(cid)
  if (!base) throw new Error('未配置 baseUrl')
  if (!token) throw new Error('未配置 token（插件配置里的 Grape API Key）')
  if (!Number.isFinite(id) || id <= 0) throw new Error(`凭据 id 非法：${String(cid)}`)
  const timeoutMs = Math.max(5, Number(cfg.timeout ?? 30)) * 1000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const resp = await fetch(`${base}/api/settings/runtime-credentials/${id}/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: ac.signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`吊销凭据失败 HTTP ${resp.status}: ${text.slice(0, 200)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 设备名长度上限（服务端 device_name 列长度约束内取保守值） */
const DEVICE_NAME_MAX = 88

/**
 * 归一化设备名（2026-11-20 用户要求：**不能写死**，不同环境可用不同名字，
 * 但必须 `dsh` 开头，例如 `dsh-worker-001`）。
 *
 * 规则：小写、非法字符转 `-`、合并连续 `-`、去首尾 `-`；缺 `dsh` 前缀则补 `dsh-`；超长截断。
 * 返回空串表示拿不到合法名字 —— 调用方必须报错，不允许回落到写死的设备名。
 */
export function sanitizeDeviceName(raw: string): string {
  let name = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!name) return ''
  if (!name.startsWith('dsh')) name = `dsh-${name}`
  return name.slice(0, DEVICE_NAME_MAX).replace(/-+$/, '')
}

/** 未配置 `deviceName` 时的默认设备名：`dsh-<host>`（同样受 {@link sanitizeDeviceName} 约束） */
export function defaultDeviceName(host: string = hostname()): string {
  return sanitizeDeviceName(`dsh-${host}`) || 'dsh-worker'
}

/**
 * `/onboard` 的**目标设备名**（纯函数，唯一来源）。
 *
 * 2026-11-23 修正：过去 `/onboard` 用 config 名查服务端状态、却用 `runtime.env` 的名字去签发/安装，
 * 于是「配了 `deviceName` 也用不上」——查 004 判成 `initialize`，装的时候又写回旧名 003
 * （撞同名凭据 / 身份回到旧值）。现在查询与安装**必须**用这个函数的返回值。
 *
 * 优先级：
 *   1. `config.deviceName` —— 用户显式意图（跨环境 / 改名都以它为准），经 {@link sanitizeDeviceName} 归一；
 *   2. 本机 `runtime.env` 的 `RUNTIME_DEVICE_NAME` —— 沿用既有身份，**原样保留不二次归一**
 *      （历史设备名不一定 `dsh` 开头，如 `worker-lab-01`；再 sanitize 一次等于凭空换身份）；
 *   3. `dsh-<host>` —— 两者都没有时的默认名。
 */
export function resolveOnboardDeviceName(
  configuredName: string,
  localDeviceName: string,
  host: string = hostname(),
): string {
  const configured = sanitizeDeviceName(configuredName)
  if (configured) return configured
  const local = String(localDeviceName ?? '').trim()
  if (local) return local
  return defaultDeviceName(host)
}

/**
 * 从凭据列表里匹配「本机这条」凭据。
 *
 * 同一 `device_name` 可能存在多行（本事故本身就是重复接入的产物），所以：
 *   · `device_name` 优先、`name` 兜底；
 *   · 命中多行时 **active 优先** —— 存在 active 就说明本机身份仍然有效，
 *     绝不能拿一条旧的 revoked/pending 行把状态机推到 `confirm-reinstall` 再建第二条凭据。
 */
export function matchCredential<T extends { name: string; status: string; device_name: string }>(
  creds: T[],
  deviceName: string,
): T | null {
  const name = String(deviceName || '').trim()
  if (!name) return null
  const candidates = creds.filter((c) => c.device_name === name || c.name === name)
  if (!candidates.length) return null
  return candidates.find((c) => c.status === 'active') ?? candidates[0]
}

/**
 * 汇总服务端视角的接入状态（凭据 + 设备行）。
 *
 * 拿不到（未配置 API Key / 网络失败）一律 `unknown` —— 调用方据此以本地事实为准：
 * 本地在跑就判 already-connected，绝不因为「查不到」去重建凭据。
 */
export async function readServerState(
  cfg: { baseUrl?: string; token?: string; timeout?: number },
  deviceName: string,
): Promise<OnboardServerState> {
  if (!apiBase(cfg) || !String(cfg.token ?? '')) return { unknown: true }
  try {
    const [creds, devices] = await Promise.all([listCredentials(cfg), listServerDevices(cfg)])
    const name = String(deviceName || '').trim()
    const credential = matchCredential(creds, name)
    const device = name ? (devices.find((d) => d.device_name === name) ?? null) : null
    return { credential, device }
  } catch {
    return { unknown: true }
  }
}

/**
 * 安装后的在线校验：轮询服务端设备表，直到**本次凭据**上线或预算耗尽。
 *
 * ⚠️ 必须按 `credentialId` 精确匹配本次 `created.id`：同一 `device_name` 下可能还留着
 * 旧凭据行，按名字匹配会读到旧行（非 active）把新凭据判成 `failed` → 事务撤销刚写进
 * `runtime.env` 的凭据，机器再次离线（与事故同形）。只有拿不到 id 时才退回按设备名匹配。
 *
 * 只有「明确看到本次凭据非 active」才判 `failed`（→ 回滚撤销）；拉不到数据一律 `pending`
 * —— 撤销一条承载真实设备身份的凭据等于把机器再打离线一次，代价高于孤儿风险。
 */
export async function verifyDeviceOnline(
  cfg: { baseUrl: string; token: string; timeout?: number },
  credentialId: number,
  deviceName = '',
  opts: { budgetMs?: number; intervalMs?: number; list?: typeof listServerDevices } = {},
): Promise<VerifyState> {
  const budgetMs = Math.max(0, Number(opts.budgetMs ?? 60000))
  const intervalMs = Math.max(200, Number(opts.intervalMs ?? 3000))
  const list = opts.list ?? listServerDevices
  // 每页超时收到 10s：一次轮询最多 20 页，单页 30s 会让整体预算失去意义
  const listCfg = { ...cfg, timeout: Math.min(Number(cfg.timeout ?? 30), 10) }
  const id = Number(credentialId)
  const name = String(deviceName || '').trim()
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const devices = await list(listCfg)
    const row = id > 0
      ? devices.find((d) => d.credential_id === id)
      : (name ? devices.find((d) => d.device_name === name) : undefined)
    if (row) {
      if (row.credential_status && row.credential_status !== 'active') return 'failed'
      if (row.health === 'online') return 'online'
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return 'pending'
}