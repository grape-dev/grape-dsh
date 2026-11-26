/**
 * Grape 插件配置页（`plugins.bundle.config` slot，keyed by 包名）。
 *
 * 契约（实测确认，与文档有出入）：
 *   - slot: `plugins.bundle.config`，keyed by **包名**（`@grape-dev/grape-dsh`）
 *   - 组件收到的 props：`{ view: 'summary' | 'page', ...标准 props }`
 *     ⚠️ 文档写的 `form` owner prop 在**当前 dsh 版本里没有传**（实测 formPresent=false）
 *   - 因此配置值要走 `ctx.configForms.get(entryId)`
 *   - **entryId 是 cordis entry id（`grape-tools`），不是包名**——用包名会得到
 *     `status: 'unavailable'`，用 entry id 才是 `ready` + 真实值
 *   - 访问 `ctx.configForms` 必须在 client `inject` 里声明（否则 cordis 抛
 *     "cannot get property configForms without inject"）
 *   - `.role('secret')` 的字段（token）**不会回传**，只能写不能读
 */

import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { getClientCtx } from './panel-control.js'

/** 必须与 cordis.patch.yml 的 `id` 一致 */
const ENTRY_ID = 'grape-tools'

/** 可热改的配置字段（token 是 write-only，单列） */
interface Cfg {
  bin?: string
  baseUrl?: string
  deviceName?: string
  timeout?: number
  confirmWrites?: boolean
  grapeTheme?: boolean
}

interface ConfigFormLike {
  getSnapshot: () => {
    status: 'loading' | 'ready' | 'unavailable'
    value?: Cfg
    revision?: number
    writable: boolean
    mode: 'host' | 'memory'
  }
  subscribe: (l: () => void) => () => void
  set: (field: string, value: unknown) => Promise<boolean>
}

const label: React.CSSProperties = { fontSize: 12, color: '#6e6e73', marginBottom: 4, display: 'block' }
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '7px 10px',
  border: '1px solid #d2d2d7', borderRadius: 8, background: '#fff', color: '#1d1d1f',
}
const row: React.CSSProperties = { marginBottom: 14 }

export function GrapeConfigPanel(props: Record<string, unknown>): ReactNode {
  const ctx = getClientCtx() as { configForms?: { get: (id: string) => ConfigFormLike } } | null
  const form = useMemo(() => ctx?.configForms?.get(ENTRY_ID), [ctx])

  const subscribe = useCallback((l: () => void) => (form ? form.subscribe(l) : () => {}), [form])
  const getSnapshot = useCallback(() => form?.getSnapshot(), [form])
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const isPage = props.view !== 'summary'

  if (!form) {
    return <p style={{ fontSize: 12, color: '#86868b' }}>配置服务不可用（configForms 未注入）。</p>
  }

  if (!isPage) {
    // summary：插件列表里的一行说明
    if (snap?.status === 'unavailable' || (snap?.mode as string | undefined) === 'memory') {
      return <span style={{ fontSize: 12, color: '#86868b' }}>Grape: 需用 localhost 页面才能配置</span>
    }
    const v = (snap?.value ?? {}) as Cfg
    return (
      <span style={{ fontSize: 12, color: '#6e6e73' }}>
        {v.baseUrl ? `Grape: ${v.baseUrl}` : 'Grape: 未配置服务地址'}
        {v.confirmWrites === false ? ' · 写操作免确认' : ' · 写操作需确认'}
      </span>
    )
  }

  if (snap?.status === 'loading') {
    return <p style={{ fontSize: 12, color: '#86868b' }}>加载配置中…</p>
  }
  const modeText: string | undefined = snap?.mode
  if (snap?.status === 'unavailable' || modeText === 'memory') {
    // dsh 只让 localhost / 127.0.0.1 的页面读写 Host 配置（安全设计）：
    //   isLoopback = isLoopbackHostname(pageLocation.hostname)
    //   非 loopback → persistence = 'memory' → namespace 永不暴露、也永不接受写入
    // 这是 dsh 自身设置页同样的行为，不是本插件的问题。
    return (
      <div style={{ fontSize: 12, color: '#ff9f0a', lineHeight: 1.7 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>配置在当前页面不可用</div>
        <div style={{ color: '#6e6e73' }}>
          dsh 只允许<b>本地页面</b>（<code>localhost</code> / <code>127.0.0.1</code>）
          读写 Host 配置；其他地址会被降级为"仅本进程"模式，配置既不暴露也不可写。
        </div>
        <div style={{ color: '#6e6e73', marginTop: 6 }}>
          请改用 <code>http://127.0.0.1:3001/</code> 访问；远程环境可用 SSH 端口转发：
          <br />
          <code>ssh -L 3001:127.0.0.1:3001 &lt;user&gt;@&lt;host&gt;</code>
          ，然后在本机开 <code>http://127.0.0.1:3001/</code>。
        </div>
        <div style={{ color: '#a1a1a6', marginTop: 6 }}>
          注：dsh 自带的「Settings → General / Models」等页面在此地址下同样不可写。
        </div>
      </div>
    )
  }

  const saved = (snap?.value ?? {}) as Cfg
  const val = <K extends keyof Cfg>(k: K): Cfg[K] =>
    (k in draft ? draft[k as string] : saved[k]) as Cfg[K]

  const setField = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }))

  const dirty = Object.keys(draft).filter((k) => draft[k] !== undefined)

  const save = async () => {
    if (!dirty.length) return
    setBusy(true)
    setMsg(null)
    try {
      const results = await Promise.all(dirty.map((k) => form.set(k, draft[k])))
      if (results.every(Boolean)) {
        setDraft({})
        setMsg('已保存 ✓')
      } else {
        setMsg('部分写入被主机拒绝，已回读最新值')
      }
    } catch (e) {
      setMsg(`保存失败：${String(e)}`)
    } finally {
      setBusy(false)
      setTimeout(() => setMsg(null), 4000)
    }
  }

  return (
    <div style={{ fontSize: 13, color: '#1d1d1f' }}>
      {/* 标题：settings.section 是独立一页，需要自带标题 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Grape 插件配置</div>
        <div style={{ fontSize: 11, color: '#a1a1a6', marginTop: 2 }}>
          baseUrl 与 token 必填（唯一来源）—— 插件不再读取环境变量 GRAPE_BASE_URL / GRAPE_API_TOKEN
        </div>
      </div>

      <div style={row}>
        <label style={label}>Grape 服务地址（baseUrl）</label>
        <input
          style={input}
          value={val('baseUrl') ?? ''}
          placeholder="https://www.grapedev.cn"
          onChange={(e) => setField('baseUrl', e.target.value)}
        />
        <div style={{ fontSize: 11, color: '#a1a1a6', marginTop: 4 }}>
          必填；留空插件无法工作（不再回退环境变量或内置默认地址）
        </div>
      </div>

      <div style={row}>
        <label style={label}>本机 Worker 设备名（deviceName）</label>
        <input
          style={input}
          value={val('deviceName') ?? ''}
          placeholder="dsh-worker-001"
          onChange={(e) => setField('deviceName', e.target.value)}
        />
        <div style={{ fontSize: 11, color: '#a1a1a6', marginTop: 4 }}>
          可选；不同环境可不同，必须以 dsh 开头。留空按 dsh-&lt;hostname&gt; 生成
        </div>
      </div>

      <div style={row}>
        <label style={label}>API Token（secret · 只写）</label>
        <input
          style={input}
          type="password"
          value={(draft.token as string) ?? ''}
          placeholder="留空则不修改（当前值不会回传）"
          onChange={(e) => setField('token', e.target.value || undefined)}
        />
        <div style={{ fontSize: 11, color: '#a1a1a6', marginTop: 4 }}>
          出于脱敏，已有值不会显示；只有填写后才会覆盖
        </div>
      </div>

      <div style={row}>
        <label style={label}>写操作需要确认</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={val('confirmWrites') !== false}
            onChange={(e) => setField('confirmWrites', e.target.checked)}
          />
          <span style={{ color: '#6e6e73' }}>
            创建 / 取消 / 触发等写操作执行前弹出确认
          </span>
        </label>
      </div>

      <div style={row}>
        <label style={label}>界面换成 Grape 风格</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={val('grapeTheme') === true}
            onChange={(e) => setField('grapeTheme', e.target.checked)}
          />
          <span style={{ color: '#6e6e73' }}>
            用 Grape 官网配色（深色 + 靛紫 #7170ff）重新着色整个界面；关掉即还原
          </span>
        </label>
      </div>

      <details style={{ marginBottom: 14 }}>
        <summary style={{ fontSize: 12, color: '#6e6e73', cursor: 'pointer' }}>高级</summary>
        <div style={{ marginTop: 10 }}>
          <div style={row}>
            <label style={label}>grape CLI 路径（bin）</label>
            <input
              style={input}
              value={val('bin') ?? ''}
              placeholder="grape（默认走 PATH）"
              onChange={(e) => setField('bin', e.target.value)}
            />
          </div>
          <div style={row}>
            <label style={label}>请求超时（秒）</label>
            <input
              style={input}
              type="number"
              value={val('timeout') ?? 30}
              onChange={(e) => setField('timeout', Number(e.target.value))}
            />
          </div>
        </div>
      </details>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          onClick={save}
          disabled={busy || !dirty.length || !snap?.writable}
          style={{
            fontSize: 13, padding: '6px 16px', borderRadius: 8, cursor: dirty.length ? 'pointer' : 'default',
            border: 'none', background: dirty.length ? '#0071e3' : '#e8e8ed',
            color: dirty.length ? '#fff' : '#a1a1a6',
          }}
        >{busy ? '保存中…' : '保存'}</button>
        {msg ? <span style={{ fontSize: 12, color: '#6e6e73' }}>{msg}</span> : null}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#a1a1a6' }}>
          {snap?.mode === 'memory' ? '仅本进程' : '写入 profile'} · rev {snap?.revision ?? '-'}
        </span>
      </div>
    </div>
  )
}