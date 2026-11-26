/**
 * 「本机」面板 —— 把当前这台机器接入为 Grape Worker（E 方案，CLI 重构版）。
 *
 * 状态机：
 *   loading   → 检查中
 *   found     → 本机已安装/已接入（显示设备卡 + 注销按钮）
 *   not_found → 确实未接入（显示接入按钮）
 *   read_error → 本机信息读不出来（**不是**未接入：禁用接入按钮，否则会诱导重装）
 *   working   → 接入/注销中
 *   error     → 失败
 *
 * 🔴 两条硬规矩（2026-11-13 事故直接产物）：
 *   ① 展示**本地事实优先**（deviceName / 进程 / 版本都来自宿主的只读探测），服务端数据只做补全；
 *   ② 「读取失败」与「未接入」必须是两个状态 —— 前者禁用接入，后者才允许点。
 *
 * 前端不接触任何凭据：签发和吊销都由宿主侧完成。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

import { formatTime } from '../time-format.js'
import { redactSensitiveText } from '../repo-diagnostics.js'

type Phase = 'loading' | 'found' | 'not_found' | 'read_error' | 'working' | 'error'

interface CredentialInfo {
  id: number
  name: string
  status: string
  device_name: string
  last_seen_at: string | null
  created_at: string
}

/** 本机只读事实（与 /check 响应字段一一对应） */
interface LocalFacts {
  installed: boolean
  processAlive: boolean
  source: string
  deviceName: string
  serverUrl: string
  workerVersion: string
  tokenPresent: boolean
  installDir: string
  /** 配置里指定的设备名（不同环境可不同，`dsh` 开头）；空 = 未配置 */
  configuredDeviceName?: string
  /** 插件配置的环境地址（cordis.patch.yml），用于判断本机 worker 是否属于本环境 */
  configuredServerUrl?: string
  /** true = 本机 worker 的 RUNTIME_SERVER_URL 与配置的 baseUrl 不一致（本环境视同没有 Worker） */
  serverMismatch?: boolean
  /** 配置的设备名与本机 runtime.env 不一致（需先注销再接入；接入时按配置名注册） */
  deviceNameMismatch?: boolean
  /** 插件配置缺失原因（baseUrl / token 未填） */
  configError?: string
}

/** 进程探测元数据（判定依据） */
interface ProbeView {
  method?: string
  command?: string
  timeoutMs?: number
  ok?: boolean
  status?: number | null
  error?: string
  stderrLines?: string[]
  matched?: Array<{ pid: number; command: string }>
}

/** 上次拉起结果（pid / 退出码 / stderr 摘要 / 拉起后核对） */
interface StartView {
  at?: string
  pid?: number
  exitCode?: number | null
  error?: string
  stderrLines?: string[]
  deviceName?: string
  tokenPresent?: boolean
  verifyState?: string
  verifyDetail?: string
}

/** 服务端设备行（health / last_seen_at / worker_version） */
interface ServerDeviceView {
  credential_id?: number
  device_name?: string
  name?: string
  credential_status?: string
  health?: string
  last_seen_at?: string | null
  worker_version?: string
}

/** 安装进度（宿主在接入事务进行中回传；异步安装期间 /check 仍然可用） */
interface OnboardProgress {
  stage: string
  elapsedMs: number
  lines: string[]
}

interface CheckBody {
  ok?: boolean
  found?: boolean
  installed?: boolean
  processAlive?: boolean
  source?: string
  deviceName?: string
  serverUrl?: string
  configuredDeviceName?: string
  configuredServerUrl?: string
  serverMismatch?: boolean
  deviceNameMismatch?: boolean
  configError?: string
  workerVersion?: string
  tokenPresent?: boolean
  installDir?: string
  envFile?: string
  readError?: string
  /** 安装进度（仅接入进行中非 null） */
  onboard?: OnboardProgress | null
  grapeAvailable?: boolean
  grapeVersion?: string
  /** CLI 探测诊断（宿主返回）：实际探测的路径、来源分层、失败原因 */
  bin?: string
  binSource?: string
  probeError?: string
  credential?: CredentialInfo | null
  device?: ServerDeviceView | null
  heartbeatIntervalSec?: number
  probe?: ProbeView
  processes?: Array<{ pid: number; command: string }>
  lastStart?: StartView | null
  error?: string
}

const REFRESH_MS = 20000
/** 拉起失败后的重试间隔：与服务端 5 分钟/设备节流保持一致 */
const AUTO_START_RETRY_MS = 5 * 60 * 1000

const MUTED: React.CSSProperties = {
  color: 'var(--dsw-alias-text-secondary, #4b4546)', fontSize: 12, lineHeight: '19px',
}
const SMALL: React.CSSProperties = {
  fontSize: 11, lineHeight: '17px', color: 'var(--dsw-alias-text-tertiary, #7a7583)',
}
const DANGER: React.CSSProperties = {
  color: 'var(--dsw-alias-text-danger, #c33)', fontSize: 12, lineHeight: '19px',
}
const CARD: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-subtle, #e0dde0)',
  borderRadius: 8,
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}
const ROW: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: 12,
  lineHeight: '18px',
}

/** 探测来源的中文说明（与宿主 `readLocalWorker` 的 source 对应） */
function sourceLabel(source: string): string {
  switch (source) {
    case 'runtime-env': return '本机配置（runtime.env）'
    case 'process': return '本机进程'
    case 'install-dir': return '安装目录'
    default: return '未检测到'
  }
}

/** 接入阶段的中文说明（宿主 /check 的 onboard.stage） */
const STAGE_LABEL: Record<string, string> = {
  mint: '签发凭据',
  install: '下载并安装 worker',
  verify: '等待 worker 上线',
}

export function GrapeMachinePanel(): ReactNode {
  const [phase, setPhase] = useState<Phase>('loading')
  const [detail, setDetail] = useState('')
  const [cred, setCred] = useState<CredentialInfo | null>(null)
  const [facts, setFacts] = useState<LocalFacts | null>(null)
  const [grapeAvailable, setGrapeAvailable] = useState(false)
  const [grapeVersion, setGrapeVersion] = useState('')
  /** CLI 探测诊断：失败时把「探测的路径 / 来源 / 原因」显示出来，避免只说「未检测到」 */
  const [cliHint, setCliHint] = useState('')
  /** 进程探测与命中进程（只用于折叠区/诊断，不参与界面判定） */
  const [probe, setProbe] = useState<ProbeView | null>(null)
  const [procList, setProcList] = useState<Array<{ pid: number; command: string }>>([])
  const [serverDevice, setServerDevice] = useState<ServerDeviceView | null>(null)
  const [lastStart, setLastStart] = useState<StartView | null>(null)
  const [envFilePath, setEnvFilePath] = useState('')
  const [heartbeatSec, setHeartbeatSec] = useState(15)
  const [copyHint, setCopyHint] = useState('')
  /** 接入安装进度：安装是异步流式执行的，所以 working 期间面板仍能刷到进度 */
  const [onboard, setOnboard] = useState<OnboardProgress | null>(null)
  /** 接入/注销进行中：暂停自动刷新，避免把 working 覆盖成 found */
  const busy = useRef(false)

  const checkStatus = useCallback(async (): Promise<CheckBody | null> => {
    try {
      const url = new URL('grape-worker-api/check', document.baseURI).toString()
      const resp = await fetch(url, { headers: { accept: 'application/json' } })
      const body = (await resp.json().catch(() => ({}))) as CheckBody
      // 接入进行中（busy）：只更新进度与事实，不覆盖 working 状态
      const applyPhase = (next: Phase): void => {
        if (!busy.current) setPhase(next)
      }
      if (!resp.ok || !body.ok) {
        applyPhase('error')
        setDetail(body.error ? String(body.error) : `HTTP ${resp.status}`)
        return null
      }
      setGrapeAvailable(!!body.grapeAvailable)
      setGrapeVersion(body.grapeVersion ?? '')
      setCliHint(
        body.grapeAvailable
          ? ''
          : [body.probeError, body.bin ? `探测路径：${body.bin}（来源：${body.binSource || '未知'}）` : '']
            .filter(Boolean).join(' · ').slice(0, 400),
      )
      setProbe(body.probe ?? null)
      setProcList(Array.isArray(body.processes) ? body.processes : [])
      setServerDevice(body.device ?? null)
      setLastStart(body.lastStart ?? null)
      setEnvFilePath(String(body.envFile ?? ''))
      setHeartbeatSec(Number(body.heartbeatIntervalSec) > 0 ? Number(body.heartbeatIntervalSec) : 15)
      setOnboard(body.onboard ?? null)
      // 宿主仍在安装（例如切到「浏览」再切回来、组件重新挂载）：直接恢复「接入中」。
      // 否则会落到 not_found，进度块不渲染、按钮还变回可点，看起来像"状态丢了"。
      if (body.onboard) {
        setPhase('working')
        return body
      }
      setFacts({
        installed: !!body.installed,
        processAlive: !!body.processAlive,
        source: String(body.source ?? 'none'),
        deviceName: String(body.deviceName ?? ''),
        serverUrl: String(body.serverUrl ?? ''),
        workerVersion: String(body.workerVersion ?? ''),
        tokenPresent: !!body.tokenPresent,
        installDir: String(body.installDir ?? ''),
        // 环境隔离：这两个字段缺一个，「环境不匹配」状态和引导就永远渲染不出来
        configuredDeviceName: String(body.configuredDeviceName ?? ''),
        configuredServerUrl: String(body.configuredServerUrl ?? ''),
        serverMismatch: !!body.serverMismatch,
        deviceNameMismatch: !!body.deviceNameMismatch,
        configError: String(body.configError ?? ''),
      })
      setCred(body.credential ?? null)
      if (body.configError) setDetail(String(body.configError))
      // 读取失败 ≠ 未接入：先判 readError，再判 found（found = 本环境有这台设备）
      if (body.readError) {
        applyPhase('read_error')
        setDetail(String(body.readError))
        return body
      }
      applyPhase(body.found ? 'found' : 'not_found')
      return body
    } catch (err) {
      if (!busy.current) {
        setPhase('error')
        setDetail(`检查失败：${String(err instanceof Error ? err.message : err)}`)
      }
      return null
    }
  }, [])

  // 接入进行中：每 3s 拉一次安装进度。安装已改为异步流式执行，安装期间 /check 仍能正常返回
  // （早期用 execFileSync 会阻塞宿主事件循环，那时再怎么轮询也只是排队）。
  useEffect(() => {
    if (phase !== 'working') return
    const timer = setInterval(() => { void checkStatus() }, 3000)
    return () => clearInterval(timer)
  }, [phase, checkStatus])

  // 首次检查 + 定时刷新。不做自动拉起（Issue #25 收敛：只展示设备信息 + 手动接入）
  useEffect(() => {
    void checkStatus()
    let timer: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (timer) return
      timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return
        void checkStatus()
      }, REFRESH_MS)
    }
    const stop = (): void => {
      if (!timer) return
      clearInterval(timer)
      timer = null
    }
    const onVisibility = (): void => {
      if (typeof document !== 'undefined' && document.hidden) stop()
      else { void checkStatus(); start() }
    }
    start()
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [checkStatus])

  const onInstallGrape = useCallback(async () => {
    setPhase('working')
    setDetail('正在下载安装 grape CLI...')
    busy.current = true
    try {
      const url = new URL('grape-worker-api/install-grape', document.baseURI).toString()
      const resp = await fetch(url, { method: 'POST', headers: { accept: 'application/json' } })
      const body = (await resp.json().catch(() => ({}))) as { ok?: boolean; version?: string; error?: string }
      if (!resp.ok || !body.ok) {
        setPhase('error')
        setDetail(body.error ? String(body.error) : `HTTP ${resp.status}`)
        return
      }
      // 安装成功 → 重新检查状态
      await checkStatus()
    } catch (err) {
      setPhase('error')
      setDetail(`安装失败：${String(err instanceof Error ? err.message : err)}`)
    } finally {
      busy.current = false
    }
  }, [checkStatus])

  const onOnboard = useCallback(async (confirm = false) => {
    setPhase('working')
    void confirm
    setDetail('')
    busy.current = true
    try {
      const url = new URL('grape-worker-api/onboard', document.baseURI).toString()
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ confirm }),
      })
      const body = (await resp.json().catch(() => ({}))) as {
        ok?: boolean; message?: string; needsConfirm?: boolean; error?: string
        credentialId?: number; credentialName?: string; online?: boolean; pending?: boolean
      }
      if (!resp.ok || !body.ok) {
        setPhase('error')
        setDetail(body.message ? String(body.message) : (body.error ? String(body.error) : `HTTP ${resp.status}`))
        return
      }
      // 接入/拉起成功 → 重新检查状态显示卡片
      await checkStatus()
      if (body.message) setDetail(String(body.message))
      if (body.pending) setDetail('已安装，等待本机 Worker 首次心跳…（面板会自动刷新）')
    } catch (err) {
      setPhase('error')
      setDetail(`接入失败：${String(err instanceof Error ? err.message : err)}`)
    } finally {
      busy.current = false
    }
  }, [checkStatus])

  const onRevoke = useCallback(async () => {
    if (!cred) return
    setPhase('working')
    setDetail('')
    busy.current = true
    try {
      const url = new URL('grape-worker-api/revoke', document.baseURI).toString()
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ cid: String(cred.id) }),
      })
      const body = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!resp.ok || !body.ok) {
        setPhase('error')
        setDetail(body.error ? String(body.error) : `HTTP ${resp.status}`)
        return
      }
      setCred(null)
      setPhase('not_found')
    } catch (err) {
      setPhase('error')
      setDetail(`注销失败：${String(err instanceof Error ? err.message : err)}`)
    } finally {
      busy.current = false
    }
  }, [cred, checkStatus])

  const deviceName = facts?.deviceName || cred?.device_name || ''
  const lastSeen = serverDevice?.last_seen_at ?? cred?.last_seen_at ?? null
  const deviceHealth = String(serverDevice?.health || '')

  /**
   * 本机 worker 五态（此前只有「已接入/未接入」两态，中间态靠猜）：
   *   未安装        → 安装目录/配置都没有
   *   已安装未接入  → 已安装，但 runtime.env 里没有有效 token（注销过 / 从未接入）→ 只能「接入本机」
   *   已安装未启动  → 有有效 token，但本机没有 worker 进程在跑（刷新后点「启动 Worker」即可）
   *   运行中        → 进程在跑（在线/离线由服务端心跳判定）
   *   环境不匹配    → 本机 worker 连的是**别的环境**（runtime.env 与服务地址不一致）：
   *                   本环境视同没有 Worker，只能「接入本机」重装，不许启动/重启它
   */
  const workerStage: '未安装' | '已安装未接入' | '已安装未启动' | '运行中' | '环境不匹配'
    = facts?.serverMismatch ? '环境不匹配'
      : !facts?.installed ? '未安装'
        : !facts.tokenPresent ? '已安装未接入'
          : facts.processAlive ? '运行中' : '已安装未启动'

  /**
   * 启动 / 重启本机 worker。
   * 走宿主 `/worker-control`（显式动作，不受 ensure-worker 的自动拉起节流限制）：
   *   start   → 已安装未启动时拉起
   *   restart → 杀掉现有进程，交给守护脚本重启；12s 没回来则宿主兜底再拉起
   */
  const onWorkerControl = useCallback(async (action: 'start' | 'restart') => {
    const verb = action === 'restart' ? '重启' : '启动'
    setPhase('working')
    setDetail(`正在${verb} Worker…`)
    busy.current = true
    try {
      const url = new URL('grape-worker-api/worker-control', document.baseURI).toString()
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action }),
      })
      const body = (await resp.json().catch(() => ({}))) as {
        ok?: boolean; restarted?: boolean; started?: boolean; alreadyRunning?: boolean
        pid?: number; error?: string
      }
      if (!resp.ok || !body.ok) {
        setPhase('error')
        setDetail(body.error ? String(body.error) : `HTTP ${resp.status}`)
        return
      }
      setDetail(
        body.alreadyRunning ? 'Worker 已在运行'
          : body.restarted ? '已重启，等待重新注册…'
            : `已${verb}${body.pid ? `（pid=${body.pid}）` : ''}，等待首次心跳…`,
      )
      // 给进程一点启动时间，再拉一次状态（面板也会每 20s 自动刷新）
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await checkStatus()
    }
    catch (err) {
      setPhase('error')
      setDetail(`${verb}失败：${String(err instanceof Error ? err.message : err)}`)
    }
    finally {
      busy.current = false
    }
  }, [checkStatus])

  /** 生成可复制的诊断文本（末尾统一脱敏） */
  const buildDiagnostics = (): string => {
    const lines = [
      'Grape 面板「本机 Worker」诊断',
      `生成时间: ${new Date().toISOString()}`,
      `接入状态: ${phase === 'found' ? '本环境已登记该设备' : (phase === 'not_found' ? '本环境未登记该设备' : phase)}`,
      `本机 Worker: ${workerStage}`,
      `设备名: ${deviceName || '未知'}`,
      `服务地址: ${facts?.serverUrl || ''}`,
      `配置环境: ${facts?.configuredServerUrl || '（未配置）'} · 一致=${facts?.serverMismatch ? '否（本环境视同无 Worker）' : '是'}`,
      `配置设备名: ${facts?.configuredDeviceName || '（未配置，按 dsh-<host>）'}`,
      ...(facts?.deviceNameMismatch
        ? [`设备名不一致: 配置=${facts?.configuredDeviceName} 运行=${facts?.deviceName}（先注销本机，再接入本机会按配置名注册）`]
        : []),
      ...(facts?.configError ? [`配置错误: ${facts.configError}`] : []),
      `runtime.env: ${envFilePath}`,
      `安装目录: ${facts?.installDir || ''}`,
      `心跳间隔: ${heartbeatSec}s`,
      `worker 版本: ${facts?.workerVersion || '未知'}`,
      `进程探测: method=${probe?.method ?? '未知'} ok=${String(probe?.ok)} timeout=${probe?.timeoutMs ?? 0}ms status=${probe?.status ?? 'null'}`,
      `探测命令: ${probe?.command || ''}`,
      ...(probe?.error ? [`探测错误: ${probe.error}`] : []),
      ...(probe?.stderrLines?.length ? ['探测 stderr 摘要:', ...probe.stderrLines.slice(0, 20).map((l) => `  ${l}`)] : []),
      `命中进程: ${procList.length ? procList.map((x) => `${x.pid} ${x.command}`).join(' | ') : '无'}`,
      `本环境设备行: ${serverDevice
        ? `health=${serverDevice.health ?? '未知'} last_seen_at=${serverDevice.last_seen_at ?? 'null'} worker_version=${serverDevice.worker_version || '未知'} credential_status=${serverDevice.credential_status ?? '未知'}`
        : '未查到'}`,
      `凭据: ${cred ? `${cred.name} #${cred.id} status=${cred.status}` : '不可读'}`,
    ]
    return redactSensitiveText(lines.join('\n'))
  }

  const onCopyDiagnostics = (): void => {
    const text = buildDiagnostics()
    try {
      void navigator.clipboard?.writeText(text).then(
        () => setCopyHint('已复制（已脱敏）'),
        () => setCopyHint('复制失败：请手动选择下方文本'),
      )
    } catch {
      setCopyHint('复制失败：请手动选择下方文本')
    }
  }

  return (
    <div style={{ padding: '14px 16px 10px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>本机 Worker</span>
        {phase === 'found' ? <Tag>已接入</Tag> : null}
        {workerStage !== '未安装' ? <Tag>{workerStage}</Tag> : null}
        {phase === 'working' ? <Tag>执行中</Tag> : null}
        {phase === 'read_error' ? <Tag>读取失败</Tag> : null}
        <span style={{ flex: 1 }} />
        {/* 任何状态都能手动重查：安装状态/进程/服务端设备行一次拉全 */}
        <Button
          variant="ghost"
          size="sm"
          disabled={phase === 'working'}
          onClick={() => void checkStatus()}
        >
          刷新
        </Button>
      </div>

      {phase === 'loading' ? <div style={MUTED}>正在检查接入状态…</div> : null}

      {/* grape CLI 不可用 → 安装入口 + 探测诊断 */}
      {!grapeAvailable && phase !== 'loading' && phase !== 'working' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={DANGER}>
            未检测到 grape CLI。接入 Worker 需要 grape CLI 来签发凭据和管理连接。
          </div>
          {cliHint ? <div style={SMALL}>{cliHint}</div> : null}
          <div>
            <Button variant="primary" size="sm" onClick={() => void onInstallGrape()}>自动安装 grape CLI</Button>
          </div>
        </div>
      ) : null}

      {/* 读取失败：不是「未接入」——禁用接入，避免诱导重装 */}
      {phase === 'read_error' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={DANGER}>设备信息读取失败</div>
          <div style={MUTED}>{detail}</div>
          <div style={SMALL}>为避免误重装，已禁用「接入本机」。请修复本机配置权限或路径后重试。</div>
          <div>
            <Button variant="outline" size="sm" onClick={() => void checkStatus()}>重试</Button>
          </div>
        </div>
      ) : null}

      {/* 已接入：只展示本环境登记的这台设备 */}
      {phase === 'found' && facts ? (
        <>
          <div style={CARD}>
            <div style={ROW}>
              <span style={MUTED}>设备</span>
              <span>{deviceName || '（未读到设备名）'}</span>
            </div>
            <div style={ROW}>
              <span style={MUTED}>本机 Worker</span>
              <span>
                {workerStage}
                {workerStage === '已安装未启动' ? '（点下方「启动 Worker」）' : ''}
                {workerStage === '已安装未接入' ? '（需重新「接入本机」）' : ''}
              </span>
            </div>
            <div style={ROW}>
              <span style={MUTED}>状态</span>
              <span>
                {deviceHealth === 'online' ? '在线' : deviceHealth === 'offline' ? '离线' : (deviceHealth || '未知')}
                {facts.processAlive ? '（本机有进程）' : '（本机未检测到进程）'}
              </span>
            </div>
            {lastSeen ? (
              <div style={ROW}>
                <span style={MUTED}>最后在线</span>
                <span title={String(lastSeen)}>{formatTime(lastSeen)}</span>
              </div>
            ) : null}
            <div style={ROW}>
              <span style={MUTED}>Worker 版本</span>
              <span>{facts.workerVersion || serverDevice?.worker_version || '未知'}</span>
            </div>
            <div style={ROW}>
              <span style={MUTED}>服务地址</span>
              <span style={{ wordBreak: 'break-all' }}>{facts.serverUrl || '未读到'}</span>
            </div>
            {cred ? (
              <>
                <div style={ROW}>
                  <span style={MUTED}>凭据</span>
                  <span>{cred.name}（#{cred.id}）· {cred.status}</span>
                </div>
                {cred.created_at ? (
                  <div style={ROW}>
                    <span style={MUTED}>创建时间</span>
                    <span title={String(cred.created_at)}>{formatTime(cred.created_at)}</span>
                  </div>
                ) : null}
              </>
            ) : (
              <div style={SMALL}>本环境未查到该设备的凭据。</div>
            )}
          </div>

          {/* 判定依据（折叠，默认收起；排障用） */}
          <details style={{ ...SMALL }}>
            <summary style={{ cursor: 'pointer', color: 'var(--dsw-alias-text-secondary, #4b4546)' }}>判定依据</summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
              <div>
                本环境设备行：{serverDevice
                  ? `health=${serverDevice.health ?? '未知'} · last_seen_at=${serverDevice.last_seen_at ?? 'null'} · worker_version=${serverDevice.worker_version || '未知'} · credential_status=${serverDevice.credential_status ?? '未知'}`
                  : '未查到'}
              </div>
              <div>runtime.env：{envFilePath || '未读到'}</div>
              <div>安装目录：{facts.installDir || '未读到'}</div>
              <div>
                进程探测：{probe?.method ?? '未知'} · ok={String(probe?.ok)} · 超时 {probe?.timeoutMs ?? 0}ms
                {probe?.error ? ` · ${probe.error}` : ''}
              </div>
              {probe?.command ? <div style={{ wordBreak: 'break-all' }}>探测命令：{probe.command}</div> : null}
              <div>
                命中进程：{procList.length
                  ? procList.map((x) => `PID ${x.pid}`).join(' / ')
                  : (probe?.ok ? '无' : '探测不可用')}
              </div>
              {probe?.stderrLines?.length ? (
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  stderr 摘要：{probe.stderrLines.slice(0, 20).join('\n')}
                </div>
              ) : null}
              <div>
                上次拉起：{lastStart
                  ? `${lastStart.at ?? ''} · pid=${lastStart.pid ?? 0} · 核对=${lastStart.verifyState ?? 'unverified'}`
                  : '无'}
              </div>
              {lastStart?.error ? <div style={DANGER}>上次拉起错误：{lastStart.error}</div> : null}
            </div>
          </details>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button variant="ghost" size="sm" onClick={onCopyDiagnostics}>复制诊断信息</Button>
            {copyHint ? <span style={SMALL}>{copyHint}</span> : null}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {workerStage === '已安装未启动' && facts.tokenPresent ? (
              <Button variant="primary" size="sm" onClick={() => void onWorkerControl('start')}>启动 Worker</Button>
            ) : null}
            {workerStage === '运行中' ? (
              <Button variant="outline" size="sm" onClick={() => void onWorkerControl('restart')}>重启 Worker</Button>
            ) : null}
            {cred ? <Button variant="outline" size="sm" onClick={() => void onRevoke()}>注销本机</Button> : null}
            {/* 这里不再放「刷新」：标题栏右上角已有一颗，功能完全一致（2026-11-20 反馈） */}
          </div>
        </>
      ) : null}

      {/* 本环境未登记该设备 / 正在接入（onboard 非空 = 宿主仍在安装，切 tab 回来也要能续上） */}
      {(phase === 'not_found' || phase === 'working' || Boolean(onboard)) ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {onboard ? (
            <div style={SMALL}>
              接入中：{STAGE_LABEL[onboard.stage] ?? onboard.stage} · 已用 {Math.round(onboard.elapsedMs / 1000)}s
              {onboard.lines.length > 0 ? (
                <div style={{ marginTop: 4, wordBreak: 'break-all' }}>
                  最近输出：{onboard.lines[onboard.lines.length - 1]}
                </div>
              ) : null}
              <div style={{ marginTop: 4 }}>安装期间可以切到别的页面，回来会继续显示进度。</div>
            </div>
          ) : (
            <>
              {phase === 'not_found' ? (
                <div style={SMALL}>本环境尚未登记设备。</div>
              ) : null}
            </>
          )}
          {!onboard && facts?.configError ? (
            <div style={DANGER}>
              插件配置不完整：{facts.configError}
              <div style={{ marginTop: 4 }}>
                到 Settings → Plugins → Grape 里填写 baseUrl 与 token（两项都只从 cordis.patch.yml 读取）。
              </div>
            </div>
          ) : null}
          {!onboard && workerStage === '环境不匹配' ? (
            <div style={DANGER}>
              本机 Worker 连接的是 {facts?.serverUrl || '未知环境'}，与插件配置的
              {' '}{facts?.configuredServerUrl || '（未配置）'} 不一致 —— 本环境视同没有 Worker。
              请点「接入本机」重新安装（会重写 runtime.env，并按配置的设备名重新签发凭据）。
            </div>
          ) : null}
          {!onboard && phase === 'not_found' && workerStage === '已安装未启动' ? (
            <div style={SMALL}>
              本机已安装 Worker 但目前没有进程在跑：可以先「启动 Worker」，也可以直接「接入本机」重新签发凭据。
            </div>
          ) : null}
          {!onboard && phase === 'not_found' && workerStage === '已安装未接入' ? (
            <div style={SMALL}>
              本机接入凭据已注销（runtime.env 中无有效 token），需重新「接入本机」。
            </div>
          ) : null}
          {!onboard && facts?.deviceNameMismatch ? (
            <div style={SMALL}>
              配置的设备名是 {facts?.configuredDeviceName}，运行中的是 {facts?.deviceName}：
              {facts?.processAlive
                ? '本机 worker 正在运行，请先「注销本机」停掉旧身份，再「接入本机」——会按配置的设备名重新签发凭据并重写 runtime.env（运行中不能热改名，否则旧进程会带着旧名字继续心跳）。'
                : 'worker 未在运行：点「接入本机」会按配置的设备名重新签发凭据并重写 runtime.env（无需先注销）。'}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              variant="primary"
              size="sm"
              disabled={phase === 'working' || Boolean(onboard)}
              onClick={() => void onOnboard(false)}
            >
              {phase === 'working' || onboard ? '正在接入…' : '接入本机'}
            </Button>
            {!onboard && workerStage === '已安装未启动' && facts?.tokenPresent ? (
              <Button
                variant="outline"
                size="sm"
                disabled={phase === 'working'}
                onClick={() => void onWorkerControl('start')}
              >
                启动 Worker
              </Button>
            ) : null}
            {/* 同上：不重复放「刷新」，右上角已有一处 */}
          </div>
        </div>
      ) : null}

      {/* 错误 */}
      {phase === 'error' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={DANGER}>{detail || '失败'}</div>
          <div>
            <Button variant="outline" size="sm" onClick={() => void checkStatus()}>重试</Button>
          </div>
        </div>
      ) : null}

      {phase === 'found' && detail ? <div style={MUTED}>{detail}</div> : null}

      <div style={MUTED}>
        把当前这台机器接入 Grape。接入后，流水线可以按场景把任务路由到本机引擎 ——
        本机已安装的引擎（dsh / opencode / codex / hermes 等）会被自动发现并注册。
      </div>

      <div style={SMALL}>
        设备名原样沿用本机配置里的名字（不会因重试而改变）。本环境查不到该设备时，点「接入本机」会签发凭据并写入 runtime.env。
        {grapeVersion ? ` grape CLI ${grapeVersion}` : ''}
      </div>
    </div>
  )
}
