/**
 * `/grape-worker-api/*` 同源 / CSRF 守卫（Issue #40 P0）。
 *
 * 为什么需要：该 prefix 下有 16 条写路由（onboard / takeover / revoke / redispatch …），
 * 但此前**没有任何** Origin / Sec-Fetch-Site 校验 —— 任意网页都能用一条
 * `Content-Type: text/plain` 的「简单请求」跨站打进来（浏览器不发预检），
 * 实测 evil Origin 也被业务层受理。守卫把判定收敛成一个纯函数，在 prefix 入口
 * **一次覆盖全量**（含以后新增的写路由），而不是每条路由各写一遍必漏。
 *
 * 判定顺序（顺序即错误码优先级，跨站优先于同源不一致）：
 *   ① `Sec-Fetch-Site: cross-site` → cross_site；
 *   ② 有 Origin：`null` / 无法解析 / 与请求 Host（缺省 x-forwarded-host 首值）不一致
 *      → cross_origin；两者都缺 → fail-closed（cross_origin）；
 *   ③ 非 GET/HEAD 且带 Content-Type：媒体类型必须是 application/json，否则 bad_content_type；
 *   ④ 无 Origin 且无 Content-Type（CLI / 宿主内部调用）→ 放行。
 *
 * 纯模块：不 import 任何 Node 内置 / React，宿主可直接用，`node:test` 可直接覆盖。
 */

/** 请求头取值（Node `req.headers` 形态；值可能是数组，如 `x-forwarded-host`） */
export type WorkerApiHeaders = Record<string, string | string[] | number | undefined>

/** 守卫输入 */
export interface WorkerApiGuardInput {
  /** HTTP 方法（大小写不敏感） */
  method?: string
  /** 请求头（键大小写不敏感；缺失视为 CLI 调用） */
  headers?: WorkerApiHeaders
}

/** 拒绝原因码（面板/日志可直接引用） */
export type WorkerApiGuardCode = 'cross_site' | 'cross_origin' | 'bad_content_type'

/** 守卫结果 */
export type WorkerApiGuardResult =
  | { allow: true }
  | { allow: false; status: 403; code: WorkerApiGuardCode; message: string }

/** 拒因 → 可读文案（面板直接展示，不暴露内部实现） */
const DENY_MESSAGE: Record<WorkerApiGuardCode, string> = {
  cross_site: '拒绝跨站请求（Sec-Fetch-Site: cross-site）',
  cross_origin: '拒绝跨源请求（Origin 与请求 Host 不一致或无法判定）',
  bad_content_type: '写操作只接受 application/json 请求体',
}

function deny(code: WorkerApiGuardCode): WorkerApiGuardResult {
  return { allow: false, status: 403, code, message: DENY_MESSAGE[code] }
}

/**
 * 读一个 header 的首值：键大小写不敏感，数组取第一项，trim 后返回。
 * 返回 `''` 同时表示「不存在」与「空值」——两者在守卫里语义一致。
 */
function headerValue(headers: WorkerApiHeaders | undefined, name: string): string {
  if (!headers || typeof headers !== 'object') return ''
  const wanted = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue
    const raw = headers[key]
    const first = Array.isArray(raw) ? raw[0] : raw
    if (first === undefined || first === null) return ''
    return String(first).trim()
  }
  return ''
}

/** 解析 Origin 的 host(:port)；失败返回 `''`（调用方按 fail-closed 处理） */
function originHost(origin: string): { host: string; scheme: string } {
  // 协议相对（`//host`）按 https 解析 —— 浏览器不会这样发 Origin，但代理/测试会。
  const normalized = origin.startsWith('//') ? `https:${origin}` : origin
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return { host: '', scheme: '' }
  try {
    const u = new URL(normalized)
    // URL 的 host 已小写且会吃掉默认端口（https:443 / http:80）—— 与请求 Host 的
    // 默认端口归一在同一口径上。
    return { host: u.host.toLowerCase(), scheme: u.protocol.replace(':', '').toLowerCase() }
  } catch {
    return { host: '', scheme: '' }
  }
}

/** 请求 Host：优先 `host`，缺失取 `x-forwarded-host` 首值，再取 HTTP/2 的 `:authority`；仍缺返回 `''` */
function requestHost(headers: WorkerApiHeaders | undefined): string {
  const direct = headerValue(headers, 'host')
  if (direct) return direct.toLowerCase()
  const forwarded = headerValue(headers, 'x-forwarded-host')
  if (forwarded) {
    // `dsh.example.com, proxy.internal` → 首值
    return (forwarded.split(',')[0] ?? '').trim().toLowerCase()
  }
  // HTTP/2 用伪头 `:authority` 代替 Host：不兜底会让同源 POST 因「Host 缺失」被 fail-closed 403
  const authority = headerValue(headers, ':authority')
  if (authority) return authority.toLowerCase()
  return ''
}

/** 去掉请求 Host 上与该 scheme 等价的默认端口，便于和 URL.host 比较 */
function stripDefaultPort(host: string, scheme: string): string {
  if (scheme === 'https' && host.endsWith(':443')) return host.slice(0, -4)
  if (scheme === 'http' && host.endsWith(':80')) return host.slice(0, -3)
  return host
}

/**
 * 判定一次请求是否允许进入 `/grape-worker-api/*` 路由。
 *
 * 纯函数、无副作用：宿主在解析 `method/url` 后调用一次，返回 `allow:false` 即 403 并 return。
 */
export function checkWorkerApiRequest(input: WorkerApiGuardInput): WorkerApiGuardResult {
  const method = String(input?.method ?? 'GET').trim().toUpperCase()
  const headers = input?.headers

  // ① 浏览器跨站提示：最明确的信号，优先于 Origin 比对（同站但不同源也会被这条挡）
  const secFetchSite = headerValue(headers, 'sec-fetch-site').toLowerCase()
  if (secFetchSite === 'cross-site') return deny('cross_site')

  // ② Origin：有就必须同源；`null`（沙箱 / opaque origin）一律拒绝
  const origin = headerValue(headers, 'origin')
  if (origin) {
    if (origin.toLowerCase() === 'null') return deny('cross_origin')
    const parsed = originHost(origin)
    if (!parsed.host) return deny('cross_origin')
    const host = requestHost(headers)
    // Host 缺失 fail-closed：宁可误杀（反向代理没传 Host），也不放宽成「无法判定就放行」
    if (!host) return deny('cross_origin')
    if (stripDefaultPort(host, parsed.scheme) !== parsed.host) return deny('cross_origin')
  }

  // ③ 写方法带 Content-Type：只接受 application/json（挡 simple-form / text/plain CSRF）
  if (method !== 'GET' && method !== 'HEAD') {
    const contentType = headerValue(headers, 'content-type')
    if (contentType) {
      const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase()
      if (mediaType !== 'application/json') return deny('bad_content_type')
    }
  }

  // ④ 无 Origin 且无 Content-Type：CLI / 宿主内部调用（curl、agent、面板代理）
  return { allow: true }
}