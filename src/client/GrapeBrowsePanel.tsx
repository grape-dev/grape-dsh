/**
 * 右栏「资源浏览」面板 —— 仓库 → issue → 流水线 三级钻取。
 *
 * 与 `GrapeFocusPanel`（实时观察窗）互补：
 *   观察窗  被动：AI 调工具 → 结果里的焦点标记
 *   浏览器  主动：用户点击 → 宿主代理（/grape-panel-api）取数
 *
 * ── 样式铁律（同 GrapeFocusPanel）──
 *  · 只用官方 UI 原语 + `--dsw-*` 设计 token；不写死色值、不用 emoji。
 *  · 行悬停**只做微妙底色变化**（用户明确要求：不要位移/阴影/变形）。
 *
 * ── 数据形状（宿主原样透传 CLI JSON，这里只窄化读取，缺字段显示占位）──
 *   repos    : { repos: [{ full_name, repo_key, role, status, branch, webhook_ok, has_bot_token }] }
 *   issues   : { issues:[{ issue_number, title, status, stage, scene_name, owner_agent,
 *                         events_count, latest_event:{seq,status,title,created_at}, is_running }] }
 *   pipeline : { issue:{number}, summary, status,
 *                segments:[{ seq, agent, event_type, status, output:{conclusion} }] }
 */

import { Fragment, useEffect, useState, type ReactNode } from 'react'
import {
  Button,
  Input,
  StateDot,
  Tag,
  IconChevronRightOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconSearchOutlineRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GrapeFocusNode } from '../focus.js'
import { normalizeIssueNumber } from '../issue-number.js'
import { normalizeIssueSearchQ } from '../issue-search.js'
import { autoOpenOrSwitch, openInSidebarBrowser } from './panel-control.js'
import { addPin, MAX_PINS, setNotice, togglePinFor, usePins } from './pins-store.js'
import { createIssue, createIssueAndTakeover } from './create-issue-flow.js'
import { CreateIssueForm, type CreateIssueFormValue } from './CreateIssueForm.js'
import { setMode } from './tab-mode.js'
import { grapeAppUrl, platformLabel } from '../focus.js'
import { derivePipelineViewFromData } from '../pipeline-model.js'
import { parseServerTime } from '../time-format.js'
import { statusLabel } from '../status-label.js'
import { NodeChain, evLabel } from './GrapeFocusPanel.js'
import {
  dashboardState,
  ensureDashboard,
  ensureEvents,
  ensureFreshRoot,
  ensureIssuesLoaded,
  ensureRootLoaded,
  eventsFor,
  getBaseUrl,
  popView,
  pushView,
  refresh,
  rootSavedAt,
  useBrowse,
  useViewState,
  type BrowseView,
} from './browse-store.js'
import {
  REPO_EMPTY_REASONS,
  buildReposDiagnostics,
  renderReposDiagnostics,
  reposEmptyKind,
} from '../repo-diagnostics.js'

const CARD_RADIUS = 'var(--dsw-radius-lg, 10px)'

// ─────────────────────────── 窄化读取小工具 ───────────────────────────

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown, fb = ''): string => (typeof v === 'string' ? v : v == null ? fb : String(v))
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** 状态文字 → Tag 色调 */
const TONE_BY_STATUS: Record<string, TagTone> = {
  completed: 'success', done: 'success', success: 'success',
  processing: 'info', running: 'info', active: 'info', in_progress: 'info',
  pending: 'quiet', queued: 'quiet',
  failed: 'danger', error: 'danger',
  cancelled: 'warning', canceled: 'warning',
  awaiting_input: 'warning',
}

const toneOf = (status: string): TagTone => TONE_BY_STATUS[status.toLowerCase()] ?? 'neutral'

/** 状态码 → Tag 色调（6 = 待审核） */
const TONE_BY_CODE: Record<number, TagTone> = {
  0: 'quiet', 1: 'info', 2: 'success', 3: 'danger', 4: 'warning', 5: 'neutral', 6: 'warning',
}

// ─────────────────────── 代码平台（repo_key 前缀）───────────────────────
//
// 托管仓库的 `repo_key` 形如 `gitcode:owner/repo` / `github:owner/repo`，
// **冒号前就是代码平台**。同一个 owner/repo 可能同时存在于两个平台，
// 所以平台既是展示维度、也是钻取路径的必要组成部分（见 store 的 viewKey）。

/**
 * Grape 当前**支持**的代码平台 —— 一律作为一级目录列出（即使暂无仓库）。
 *
 * 这是「产品支持什么」而不是「我托管了什么」：空的 GitHub 目录本身是信息
 * （"这个平台支持，但我还没往这托管项目"），也让平台维度可见，
 * 而不是要用户从 repo_key 前缀去推断。
 *
 * 数据里若出现列表外的平台（如将来的 gitlab），按出现顺序自动补在后面分组。
 */
const SUPPORTED_PLATFORMS: readonly string[] = ['gitcode', 'github']

/** 拆 `platform:owner/repo` */
function splitRepoKey(key: string): { platform: string; full: string } {
  const i = key.indexOf(':')
  if (i <= 0) return { platform: '', full: key }
  return { platform: key.slice(0, i).toLowerCase(), full: key.slice(i + 1) }
}

/** 相对时间（最近事件）；服务端时间无时区后缀时按 UTC 解析，避免整体差一个时区 */
function relTime(iso: string): string {
  if (!iso) return ''
  const t = parseServerTime(iso)
  if (Number.isNaN(t)) return ''
  return relAge(t)
}

/** 相对时间（毫秒时间戳）：持久化快照首屏渲染时展示「数据时间」 */
function relAge(ms: number): string {
  const d = Date.now() - ms
  if (!Number.isFinite(d) || d < 0) return '刚刚'
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return `${Math.floor(d / 86_400_000)} 天前`
}

// ─────────────────────────── 通用外壳 ───────────────────────────

/**
 * 单选筛选 chip 行。
 *
 * 取值域**从已加载数据里推导**（后端只有 `--status` / `--assignees` 两个过滤参数，
 * 没有 `--scene`），所以一律前端过滤：一次拉全量、之后零请求、筛选即时。
 * 行内横向滚动，取值域大了也不会把面板撑高。
 *
 * 选中态用品牌色低透明底色 —— 只做颜色变化，不做位移（用户明确要求）。
 */
function ChipRow(props: {
  label: string
  /** 可选值（含计数，用于展示） */
  options: Array<{ value: string; count: number }>
  /** 当前选中（'' = 全部） */
  value: string
  onChange: (v: string) => void
}): ReactNode {
  if (props.options.length <= 1) return null
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, marginBottom: 6, minWidth: 0 }}>
      {/* 组标签。
          ⚠️ 必须 flex-start + paddingTop 3px，不能用 center：
          chip 换行成两排时（场景/指派 取值多，实测会换行），center 会把标签
          垂直居中到两排**之间**，与第一排差 19px —— 看起来就是"没对齐"。
          paddingTop 取 chip 的 border(1) + padding(2) = 3px，首行文字与第一排 chip 齐平。 */}
      <span style={{
        flex: 'none', width: CHIP_LABEL_WIDTH, fontSize: 12, fontWeight: 500, lineHeight: 1.6, paddingTop: 3,
        color: 'var(--dsw-alias-label-secondary, #6e6e73)',
      }}>
        {props.label}
      </span>
      {/* 换行而不是横向滚动：滚出视野的 chip 等于把取值藏起来，用户不知道还有别的 */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', minWidth: 0 }}>
        <Chip label="全部" count={props.options.reduce((a, o) => a + o.count, 0)} active={props.value === ''} onClick={() => props.onChange('')} />
        {props.options.map((o) => (
          <Chip
            key={o.value}
            label={o.value}
            count={o.count}
            active={props.value === o.value}
            onClick={() => props.onChange(props.value === o.value ? '' : o.value)}
          />
        ))}
      </div>
    </div>
  )
}

/** 单个 chip（自建：官方没有 chip/select 原语；仍只用 `--dsw-*` token 上色） */
function Chip(props: { label: string; count: number; active: boolean; onClick: () => void }): ReactNode {
  const [hover, setHover] = useState(false)
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={props.active}
      onClick={props.onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onClick() } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 'none',
        padding: '2px 8px',
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 4,
        fontSize: 12,
        lineHeight: 1.6,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        color: props.active
          ? 'var(--dsw-alias-brand-primary, #0071e3)'
          : 'var(--dsw-alias-label-secondary, #6e6e73)',
        background: props.active
          ? 'var(--dsw-alias-interactive-bg-hover-accent, rgba(0,113,227,.12))'
          : hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))' : 'transparent',
        border: `1px solid ${props.active
          ? 'var(--dsw-alias-brand-primary, #0071e3)'
          : 'var(--dsw-alias-border-l2, rgba(0,0,0,.08))'}`,
        transition: 'background .12s, color .12s, border-color .12s',
      }}
    >
      <span>{props.label}</span>
      {props.count > 0 ? (
        // 计数弱化 + 前置分隔点：仅靠灰度/字号差在截图分辨率下几乎看不出，
        // 同色同重又会读成「已完成 18」一整串，所以补一个分隔符
        <>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #86868b)' }}>·</span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>{props.count}</span>
        </>
      ) : null}
    </div>
  )
}

/**
 * 一级目录头（代码平台）。
 *
 * ⚠️ 为什么不用官方 `DisclosureRow`：它的定位是「24px 进程行，
 * tertiary 文字与图标，hover 转 secondary」（见其类型注释），
 * 用在目录头上会把文件夹图标和标题都压成灰调、读不出层级。
 * 官方原语该用在它设计意图吻合处 —— 这里保留**官方文件夹/箭头图标 + `--dsw-*` token**，
 * 但自己控制字重与色阶，让目录头明显重于条目行。
 *
 * 展开箭头放**左侧**（树形惯例）：右侧的箭头在条目行上表示"钻进去"，
 * 两者放同侧会歧义。
 */
function GroupHeader(props: {
  open: boolean
  label: string
  count: number
  onToggle: () => void
}): ReactNode {
  const [hover, setHover] = useState(false)
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={props.open}
      title={props.label}
      onClick={props.onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onToggle() }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 10px',
        borderRadius: CARD_RADIUS,
        cursor: 'pointer',
        background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))' : 'transparent',
        transition: 'background .12s',
      }}
    >
      <span
        style={{
          display: 'flex',
          flex: 'none',
          color: 'var(--dsw-alias-label-secondary, #6e6e73)',
          transform: props.open ? 'rotate(90deg)' : 'none',
          transition: 'transform .15s',
        }}
        aria-hidden
      >
        <IconChevronRightOutlineRegular />
      </span>
      <span style={{ display: 'flex', flex: 'none', color: 'var(--dsw-alias-label-secondary, #6e6e73)' }} aria-hidden>
        {props.open ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #1d1d1f)' }}>
        {props.label}
      </span>
      <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
        {props.count > 0 ? props.count : '暂无'}
      </span>
    </div>
  )
}

/**
 * 可点击行：悬停只换底色（不做位移/阴影）。
 *
 * 缩进/引导线由**父容器**负责（见 RepoList 的二级容器），
 * 行本身不自带 margin —— 否则「容器缩进 + 行缩进」会叠加成双重缩进。
 */
function Row(props: {
  /** 缺省 = 不可点击：编号缺失的 issue 行钻取不了（Issue #39） */
  onClick?: () => void
  children: ReactNode
  title?: string
}): ReactNode {
  const [hover, setHover] = useState(false)
  const clickable = typeof props.onClick === 'function'
  const activate = (): void => { props.onClick?.() }
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={props.title}
      onClick={clickable ? activate : undefined}
      onKeyDown={clickable
        ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() } }
        : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 10px',
        borderRadius: CARD_RADIUS,
        cursor: clickable ? 'pointer' : 'default',
        background: hover && clickable ? 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))' : 'transparent',
        transition: 'background .12s',
      }}
    >
      {props.children}
    </div>
  )
}

/**
 * 列表行里的「观察」切换（pin ↔ 浏览 联动）。
 *
 * 两个刻意的实现决定：
 *  ① `stopPropagation()` 必须加 —— 外层 `Row` 是 role=button，点它会钻取到流水线详情；
 *     在行内做切换却不吃掉事件，用户每次都想钉、结果每次都被带进下一页。
 *  ② **反馈就是图标本身**（实心/空心切换），不弹提示文案 —— 提示只由实时面板渲染
 *     （见 pins-store 里的说明），在浏览面板弹提示等于让用户看不到。
 *     到达上限时改为**置灰 + tooltip**，而不是点完再解释。
 */
function PinToggle(props: {
  owner: string
  repo: string
  number: string
  title: string
  platform?: string
}): ReactNode {
  const pins = usePins()
  const [hover, setHover] = useState(false)
  const pinned = pins.some((p) => p.owner === props.owner && p.repo === props.repo && p.number === props.number)
  /**
   * 编号缺失（Gitee `"0"` 占位/脏数据）时不可 pin：`togglePinFor` 只会返回 `invalid`，
   * 点了却毫无反馈等于坏按钮，所以直接置灰 + 说明（Issue #39）。
   */
  const noNumber = !props.number
  const atCap = !pinned && pins.length >= MAX_PINS
  const inactive = noNumber || atCap

  const label = noNumber
    ? '该 issue 无编号，无法观察'
    : atCap
      ? `观察已满 ${MAX_PINS} 个，请先取消一些`
      : (pinned ? `取消跟随 #${props.number}` : `跟随 #${props.number}`)

  const act = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    if (inactive) return
    togglePinFor(props)
  }

  return (
    <span
      role="button"
      // 到达上限时保持可聚焦：置灰 + tabIndex=-1 会让键盘/触屏用户完全收不到原因
      tabIndex={0}
      aria-label={label}
      aria-disabled={inactive}
      aria-pressed={pinned}
      title={noNumber ? label : (atCap ? `最多同时观察 ${MAX_PINS} 个，请先取消一些` : (pinned ? '取消跟随' : '加入观察'))}
      onClick={act}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          if (!inactive) togglePinFor(props)
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 18, height: 18, borderRadius: 999,
        cursor: inactive ? 'default' : 'pointer',
        opacity: inactive ? 0.35 : 1,
        color: pinned
          ? 'var(--dsw-alias-brand-primary, #6f6cff)'
          : (hover ? 'var(--dsw-alias-label-secondary, #6e6e73)' : 'var(--dsw-alias-label-secondary, #6e6e73)'),
        background: hover && !inactive ? 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))' : 'transparent',
      }}
    >
      {pinned ? <IconPinFillRegular /> : <IconPinOutlineRegular />}
      {/* Issue #28 R4：到达上限时给可见标记，不只靠 hover tooltip（触屏/键盘收不到） */}
      {atCap ? (
        <span
          style={{
            position: 'absolute', right: -6, top: -6,
            padding: '0 3px', borderRadius: 6, fontSize: 9, lineHeight: '12px',
            background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.06))',
            color: 'var(--dsw-alias-label-secondary, #6e6e73)',
            pointerEvents: 'none',
          }}
        >满</span>
      ) : null}
    </span>
  )
}

/** 三态包装：loading / error（原文 + 重试）/ empty */
function States(props: {
  loading: boolean
  error: string | null
  empty: boolean
  emptyText: string
  /** 空态自定义内容（如仓库列表的原因提示 + 诊断）；缺省回退 `emptyText` */
  emptyContent?: ReactNode
  /** 错误态附加动作（如搜索态「清除搜索」）；与「重试」并排 */
  errorAction?: ReactNode
  onRetry: () => void
  children: ReactNode
}): ReactNode {
  if (props.error) {
    return (
      <div style={{ padding: '12px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <StateDot state="error" size={8} />
          <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary, #1d1d1f)' }}>取数失败</span>
        </div>
        {/* 错误原样展示：例如那 403「仅支持会话级临时 token」的文案 */}
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.55,
            color: 'var(--dsw-alias-label-secondary, #6e6e73)',
            background: 'var(--dsw-alias-markdown-code-block, rgba(0,0,0,.04))',
            border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
            borderRadius: CARD_RADIUS,
            padding: '8px 10px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {props.error}
        </div>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Button variant="outline" size="sm" onClick={props.onRetry}>重试</Button>
          {props.errorAction}
        </div>
      </div>
    )
  }
  if (props.loading) {
    return (
      <div style={{ padding: '12px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <StateDot state="ongoing" size={8} />
        <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>加载中…</span>
      </div>
    )
  }
  if (props.empty) {
    if (props.emptyContent !== undefined) return <>{props.emptyContent}</>
    return (
      <div style={{ padding: '12px 10px', fontSize: 13, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
        {props.emptyText}
      </div>
    )
  }
  return <>{props.children}</>
}

// ─────────────────── 空态：原因提示 + 诊断（Issue #6）───────────────────

/** 剪贴板兜底：`navigator.clipboard` 不可用（非 https / 权限拒绝）时用隐藏 textarea。 */
function copyPlainText(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * 仓库列表空态。
 *
 * 三类原因必须能区分；「诊断」默认折叠，展开后给出查询端点/参数、原始条数、
 * `total`、`org_id` 推断值，并支持一键复制**脱敏**文本。
 */
function RepoEmptyState(props: { data: unknown }): ReactNode {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const diag = buildReposDiagnostics(props.data)

  const copy = (): void => {
    const text = renderReposDiagnostics(diag)
    const done = (): void => {
      setCopied(true)
      setNotice('诊断信息已复制（已脱敏）', 20000)
      window.setTimeout(() => setCopied(false), 2000)
    }
    const fallback = (): void => {
      if (copyPlainText(text)) done()
      else setNotice('复制失败：当前环境不支持剪贴板，请手动选择诊断内容', 30000)
    }
    try {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).then(done).catch(fallback)
      } else {
        fallback()
      }
    } catch {
      fallback()
    }
  }

  const rows: Array<[string, string]> = [
    ['查询端点', diag.endpoint],
    ['插件代理', diag.proxy],
    ['CLI 查询', diag.cli],
    ['查询参数', diag.paramsText],
    ['原始返回条数', String(diag.rawCount)],
    ['total', diag.totalText],
    ['角色分布', diag.rolesText],
    ['org_id 推断', diag.orgIdText],
    ['当前账号', diag.viewerText],
    ['账号组织角色', diag.viewerOrgsText],
    ['账号托管权限', diag.viewerReposText],
    ['生成时间', diag.generatedAt],
  ]

  return (
    <div style={{ padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StateDot state="idle" size={8} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #1d1d1f)' }}>
          当前账号未查询到已托管仓库
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>可能原因：</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {REPO_EMPTY_REASONS.map((reason, i) => (
          <div
            key={reason}
            style={{
              display: 'flex', gap: 6, fontSize: 12, lineHeight: 1.6,
              color: 'var(--dsw-alias-label-secondary, #6e6e73)',
            }}
          >
            <span style={{ flex: 'none', color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>{i + 1}.</span>
            <span>{reason}</span>
          </div>
        ))}
      </div>
      <div>
        <button
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0',
            border: 'none', background: 'transparent', cursor: 'pointer',
            fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)',
          }}
        >
          <span
            style={{
              display: 'flex',
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform .15s',
            }}
            aria-hidden
          >
            <IconChevronRightOutlineRegular />
          </span>
          诊断
        </button>
      </div>
      {open ? (
        <div
          style={{
            border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
            borderRadius: CARD_RADIUS,
            padding: '8px 10px',
            fontSize: 12,
            background: 'var(--dsw-alias-markdown-code-block, rgba(0,0,0,.04))',
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 4 }}>
            {rows.map(([k, v]) => (
              <Fragment key={k}>
                <div style={{ color: 'var(--dsw-alias-label-secondary, #6e6e73)', whiteSpace: 'nowrap' }}>{k}</div>
                <div style={{ color: 'var(--dsw-alias-label-primary, #1d1d1f)', wordBreak: 'break-word' }}>{v}</div>
              </Fragment>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Button variant="outline" size="sm" onClick={copy}>{copied ? '已复制' : '复制诊断信息'}</Button>
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
              仅复制白名单诊断字段，不含 token / key
            </span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ─────────────────────────── ① 仓库列表 ───────────────────────────

function RepoList(props: {
  data: unknown
  loading: boolean
  error: string | null
  /** 数据时间（持久化快照 / 最近一次成功取数）；用于标注旧数据 */
  savedAt?: number
}): ReactNode {
  const repos = asArr(asObj(props.data).repos)

  /** 仓库搜索（前端过滤：repos managed 一次给全量） */
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const searching = needle !== ''
  const matchRepo = (r: unknown): boolean => {
    if (!searching) return true
    const o = asObj(r)
    const full = str(o.full_name) || str(o.repo_key)
    return full.toLowerCase().includes(needle)
  }
  const hitCount = repos.filter(matchRepo).length
  // 非空列表 → 'none'（保持原渲染）；搜索无命中 → 'search'（维持原文案）；
  // 真无仓库 → 'list'（原因提示 + 诊断）。
  const emptyKind = reposEmptyKind(repos.length, searching, hitCount)

  /** 平台 → 该平台下的仓库（一级目录） */
  const byPlatform = new Map<string, unknown[]>()
  for (const r of repos) {
    const p = splitRepoKey(str(asObj(r).repo_key)).platform
    const list = byPlatform.get(p)
    if (list) list.push(r)
    else byPlatform.set(p, [r])
  }
  // 一级目录 = Grape 支持的平台（固定列出，含暂无仓库的）+ 数据里出现的其他平台。
  const ordered: string[] = [...SUPPORTED_PLATFORMS]
  for (const k of byPlatform.keys()) if (!ordered.includes(k)) ordered.push(k)

  /** 展开状态：有仓库的平台默认展开；空平台默认收起；**搜索时一律展开**（否则命中结果被藏在收起目录里） */
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({})
  const isOpen = (p: string): boolean =>
    openMap[p] ?? (searching ? true : (byPlatform.get(p)?.length ?? 0) > 0)

  return (
    <>
      {props.savedAt && !props.loading && !props.error ? (
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #86868b)', marginBottom: 6 }}>
          数据时间：{relAge(props.savedAt)}
        </div>
      ) : null}
      {repos.length > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <Input
            icon={<IconSearchOutlineRegular />}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索仓库名"
          />
          {searching ? (
            <span style={{ flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
              {hitCount} / {repos.length}
            </span>
          ) : null}
        </div>
      ) : null}
    <States
      loading={props.loading}
      error={props.error}
      empty={emptyKind !== 'none'}
      emptyText={searching ? '没有匹配的仓库。' : '没有已托管的仓库。'}
      emptyContent={emptyKind === 'list' ? <RepoEmptyState data={props.data} /> : undefined}
      onRetry={refresh}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {ordered.map((p) => {
          const allItems = byPlatform.get(p) ?? []
          const items = allItems.filter(matchRepo)
          // 搜索时隐藏没有命中的平台目录；不搜索时保留空平台（"支持但未托管"也是信息）
          if (searching && items.length === 0) return null
          const label = platformLabel(p) || p || '其他'
          const open = isOpen(p)
          return (
            <div key={p || 'none'}>
              <GroupHeader
                open={open}
                label={label}
                count={items.length}
                onToggle={() => setOpenMap((m) => ({ ...m, [p]: !open }))}
              />
              {open ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    // 竖直引导线：仅靠缩进在长列表里不易看出父子归属
                    marginLeft: 22,
                    paddingLeft: 6,
                    borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))',
                  }}
                >
                {items.map((r, i) => {
                  const o = asObj(r)
                  const full = str(o.full_name) || splitRepoKey(str(o.repo_key)).full
                  const [owner, repo] = full.includes('/') ? full.split('/') : ['', full]
                  return (
                    <Row
                      key={`${p}-${full}-${i}`}
                      title={full}
                      onClick={() => {
                        if (owner && repo) pushView({ kind: 'issues', owner, repo, platform: p || undefined })
                      }}
                    >
                      <StateDot state={str(o.webhook_ok) === 'true' || o.webhook_ok === true ? 'done' : 'idle'} size={8} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary, #1d1d1f)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {full}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)', marginTop: 3 }}>
                          {[str(o.role), str(o.status), str(o.branch)].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <span style={{ flex: 'none', display: 'flex', color: 'var(--dsw-alias-label-secondary, #6e6e73)' }} aria-hidden>
                        <IconChevronRightOutlineRegular />
                      </span>
                    </Row>
                  )
                })}
                {items.length === 0 ? (
                  <div style={{ padding: '4px 10px 8px 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
                    该平台还没有托管仓库
                  </div>
                ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </States>
    </>
  )
}

// ─────────────────────── 仓库概览卡（P4）───────────────────────

/** 一行指标（值 + 标签） */
function Metric(props: { value: string; label: string; tone?: 'error' | 'ok' }): ReactNode {
  const color = props.tone === 'error'
    ? 'var(--dsw-alias-state-error, #f87171)'
    : props.tone === 'ok' ? 'var(--dsw-alias-state-success, #10b981)' : 'var(--dsw-alias-label-primary, #1d1d1f)'
  return (
    // `nowrap` + 不收缩：像「有执行记录的 issue」这种长标签在窄 flex 项里会被压成一列字，
    // 看起来又淡又碎（2026-11-20 反馈）。宁可整项换行到下一排，也不要把标签挤断。
    <div style={{ minWidth: 62, flex: 'none', whiteSpace: 'nowrap' }}>
      <div style={{ fontSize: 14, fontWeight: 600, color }}>{props.value}</div>
      {/* 标签用 secondary（#6e6e73）而不是 tertiary（#86868b）：11px + 三级灰在深色背景下偏淡，
          与 DSH 自身正文的次要文字色对齐后又清楚又不抢数值。 */}
      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)', marginTop: 1 }}>{props.label}</div>
    </div>
  )
}

/**
 * 仓库概览卡（`dashboard repo`）。
 *
 * 默认**收起**成一行摘要：面板竖向空间有限，概览是"进仓库顺手看一眼"的信息，
 * 不该把 issue 列表挤下去（评审在 P2 就提过控件堆太高的问题）。
 * 数据随进入仓库就拉（摘要行本身要用），宿主已把 64KB 投影成几 KB。
 */
function RepoOverviewCard(props: { owner: string; repo: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const st = dashboardState(props.owner, props.repo)

  useEffect(() => { ensureDashboard(props.owner, props.repo) }, [props.owner, props.repo])

  const d = asObj(st.data)
  const m = asObj(d.metrics)
  const role = str(d.role)
  const dev = str(d.dev_scene)
  const branch = str(d.work_branch)
  const scenes = asArr(d.scenes)
  const agents = asArr(d.agents)
  const totalIssues = num(m.total_issues)
  const failed = num(m.failed_events)
  const pending = num(m.pending_events)

  // 摘要行只放**这里独有的**信息。
  // 不放 role / issue 总数：紧邻的仓库行与头部已有，且实测 `dashboard repo` 的
  // role（Maintainer）与 `repos managed` 的 role（Admin）、metrics.total_issues（2）
  // 与 `issues list` 的条数（3）**口径不一致** —— 同一界面摆两个冲突数字会被当成 bug。
  // 这些字段留在展开后的指标区（明确属于"平台统计口径"）。
  const bits = [
    dev ? `dev 场景 ${dev}` : '',
    branch ? `分支 ${branch}` : '',
  ].filter(Boolean)
  const summary = st.error ? '概览加载失败' : (bits.join(' · ') || '—')

  return (
    <div style={{
      border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-layer-3, rgba(255,255,255,.6))',
      marginBottom: 10,
      overflow: 'hidden',
    }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) } }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', flexWrap: 'wrap',
          background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))' : 'transparent',
        }}
      >
        <span style={{
          flex: 'none', display: 'flex', color: 'var(--dsw-alias-label-secondary, #6e6e73)',
          transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s',
        }} aria-hidden>
          <IconChevronRightOutlineRegular />
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #1d1d1f)' }}>概览</span>
        <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {st.loading && !st.data ? '加载中…' : summary}
        </span>
        {/* 失败/待处理是这里独有的，且值得在收起态就能看见 */}
        {failed ? <Tag tone="danger">{failed} 失败</Tag> : null}
        {pending ? <Tag tone="warning">{pending} 待处理</Tag> : null}
      </div>

      {open ? (
        <div style={{ padding: '2px 10px 10px' }}>
          {/* 指标（平台统计口径）。
              ⚠️ 不再展示 `metrics.total_events`：服务端取的是「最近事件列表长度」
              （`ORDER BY seq DESC LIMIT 5`），叫「总事件」会与「本周事件」打架
              ——2026-11-20 实测 5 对 70，被当成算错。 */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: '6px 0 4px' }}>
            <Metric value={String(num(m.events_week) ?? 0)} label="本周事件" />
            <Metric value={String(num(m.active_agents) ?? 0)} label="活跃 Agent" />
            <Metric value={String(num(m.auto_resolution) ?? 0) + '%'} label="自动解决" tone="ok" />
            <Metric value={String(num(m.avg_response) ?? 0)} label="平均响应" />
            <Metric value={String(failed ?? 0)} label="失败事件" tone={failed ? 'error' : undefined} />
            {totalIssues !== undefined ? <Metric value={String(totalIssues)} label="有执行记录的 issue" /> : null}
          </div>

          {/* 流水线场景（骨架链） */}
          {scenes.length > 0 ? (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--dsw-alias-label-secondary, #6e6e73)', marginBottom: 5 }}>
                流水线场景 {scenes.length}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {scenes.slice(0, 8).map((s) => {
                  const so = asObj(s)
                  const nodes = asArr(so.nodes)
                  return (
                    <div key={str(so.id)} style={{ fontSize: 11 }}>
                      <div style={{ color: 'var(--dsw-alias-label-primary, #1d1d1f)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span>{str(so.name)}</span>
                        {str(so.id) === str(d.dev_scene) ? <Tag tone="info">dev</Tag> : null}
                        {str(so.work_branch) ? (
                          <span style={{ color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>{str(so.work_branch)}</span>
                        ) : null}
                      </div>
                      <div style={{ color: 'var(--dsw-alias-label-secondary, #6e6e73)', marginTop: 2 }}>
                        {nodes.map((n) => str(asObj(n).tag)).filter(Boolean).join(' → ')}
                      </div>
                    </div>
                  )
                })}
                {scenes.length > 8 ? (
                  <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>…还有 {scenes.length - 8} 个</div>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Agent */}
          {agents.length > 0 ? (
            <div>
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--dsw-alias-label-secondary, #6e6e73)', marginBottom: 5 }}>
                Agent
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {agents.map((a) => {
                  const ao = asObj(a)
                  const type = str(ao.agent_type)
                  const enabled = ao.enabled_in_scene === true
                  return (
                    <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                      <StateDot state={enabled ? 'done' : 'idle'} size={7} />
                      <span style={{ color: 'var(--dsw-alias-label-primary, #1d1d1f)', minWidth: 52 }}>{type}</span>
                      <span style={{ color: 'var(--dsw-alias-label-secondary, #6e6e73)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {str(ao.skill_display_name) || str(ao.backend)}
                      </span>
                      {!enabled ? <span style={{ color: 'var(--dsw-alias-label-tertiary, #86868b)' }}>未启用</span> : null}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ─────────────────────────── ② issue 列表 ───────────────────────────

/** 每页条数。默认列表由后端一次返回全量（实测 grape-dev/grape 504 条）→ 前端分页兜底。
 *  搜索列表（Issue #41）改由服务端按 `per_page=50` 分页，翻页走 `has_more`。 */
const ISSUE_PAGE_SIZE = 30

/** 搜索输入防抖：300ms 内的连续输入只发一次服务端检索 */
const ISSUE_SEARCH_DEBOUNCE_MS = 300

/**
 * 按取值器统计，用于派生筛选 chip 的取值域与计数。
 *
 * @param emptyLabel 传入时把空值也列成一个桶（如「未指派」）——
 *   实测 `grape-dev/grape-admin` 70 个 issue 里 34 个没有指派，
 *   不给空值一个落点就等于这部分永远筛不出来。
 */
function tally(
  items: unknown[],
  pick: (o: Record<string, unknown>) => string,
  emptyLabel?: string,
): Array<{ value: string; count: number }> {
  const m = new Map<string, number>()
  for (const it of items) {
    const v = pick(asObj(it)) || (emptyLabel ?? '')
    if (!v) continue
    m.set(v, (m.get(v) ?? 0) + 1)
  }
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * ② issue 列表：服务端搜索 + 状态/场景/指派筛选 + 分页。
 *
 * 搜索（Issue #41）走服务端 `q`：输入 300ms 防抖 → browse-store 按 q/page 分视图键取数；
 * 服务端返回前用本地过滤作过渡（首屏不闪空），但「无结果」只能由服务端结果下结论。
 * 状态/场景/指派筛选仍在前端（后端无 `--scene` 过滤，且取值域要能覆盖当前结果集）。
 */
function IssueList(props: { view: Extract<BrowseView, { kind: 'issues' }>; data: unknown; loading: boolean; error: string | null }): ReactNode {
  const localAll = asArr(asObj(props.data).issues)
  const pLabel = platformLabel(props.view.platform)

  const [q, setQ] = useState('')
  const [searchQ, setSearchQ] = useState('')
  const [searchPage, setSearchPage] = useState(1)
  const [fStatus, setFStatus] = useState('')
  const [fScene, setFScene] = useState('')
  const [fAssignee, setFAssignee] = useState('')
  const [limit, setLimit] = useState(ISSUE_PAGE_SIZE)
  /** 三个筛选 chip 行默认收起：面板竖向空间有限，控件堆太高列表就只剩一两行可看 */
  const [showFilters, setShowFilters] = useState(false)

  // Issue #41：输入 300ms 防抖后才走服务端检索；清空搜索立即回到默认列表（不等防抖）。
  // 复审 Optional：换词与重置页码必须落在**同一次**状态更新里 —— 否则新词会带着旧
  // page=2 先发一包、再由 effect 纠正到 page=1，白白多打一次请求。
  useEffect(() => {
    const term = normalizeIssueSearchQ(q)
    if (!term) { setSearchQ(''); setSearchPage(1); return }
    const timer = setTimeout(() => {
      setSearchQ(term)
      setSearchPage(1)
    }, ISSUE_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [q])

  const searching = searchQ !== ''
  /** 搜索视图（q/page 进键）：只有搜索时才偏离导航栈的默认列表视图 */
  const searchView: BrowseView = {
    kind: 'issues',
    owner: props.view.owner,
    repo: props.view.repo,
    platform: props.view.platform,
    q: searching ? searchQ : undefined,
    page: searching && searchPage > 1 ? searchPage : undefined,
  }
  const searchState = useViewState(searchView)

  // 搜索取数：按 q+page 分键缓存，重复渲染不会重复打
  useEffect(() => {
    if (!searching) return
    ensureIssuesLoaded(props.view.owner, props.view.repo, props.view.platform, searchQ, searchPage)
  }, [searching, searchQ, searchPage, props.view.owner, props.view.repo, props.view.platform])

  const searchData = asObj(searchState.data)
  const hits = asArr(searchData.issues)
  const searchHasMore = searchData.has_more === true
  const typed = normalizeIssueSearchQ(q)
  /**
   * 服务端结果是否可展示：防抖已落定 + 请求成功。未落定/首包未回时用本地过滤作过渡，
   * 但**不得**把「本地 20 条无匹配」当成「无结果」—— 判定要等服务端返回。
   */
  const serverReady = searching && typed === searchQ && searchState.data != null && !searchState.error
  const baseAll = serverReady ? hits : localAll
  const needle = serverReady ? '' : (typed || searchQ).toLowerCase()

  // 任一筛选/搜索变化 → 回到第一页
  useEffect(() => { setLimit(ISSUE_PAGE_SIZE) }, [q, searchQ, fStatus, fScene, fAssignee, baseAll.length])

  // 取值域从**当前结果集**派生：不随筛选塌缩（否则选中一个 chip 后其他 chip 会消失）
  const statusOpts = tally(baseAll, (o) => statusLabel(str(o.status)))
  const sceneOpts = tally(baseAll, (o) => str(o.scene_name), '未设置')
  const assigneeOpts = tally(baseAll, (o) => str(o.assignee), '未指派')

  const rows = baseAll.filter((it) => {
    const o = asObj(it)
    if (fStatus && statusLabel(str(o.status)) !== fStatus) return false
    if (fScene && (str(o.scene_name) || '未设置') !== fScene) return false
    if (fAssignee && (str(o.assignee) || '未指派') !== fAssignee) return false
    if (!needle) return true
    const hay = [
      str(o.title),
      '#' + (str(o.issue_number) || str(o.number)),
      str(o.assignee), str(o.scene_name), statusLabel(str(o.status)),
    ].join(' ').toLowerCase()
    return hay.includes(needle)
  })
  // 服务端已按 50 条分页：搜索态直接展示本页全部命中，翻页交给上一页/下一页；
  // 默认列表仍是「一次全量 + 前端分页」。
  const shown = serverReady ? rows : rows.slice(0, limit)
  const activeCount = [fStatus, fScene, fAssignee].filter(Boolean).length
  const hasFilter = typed !== '' || activeCount > 0
  const searchBusy = searching && searchState.loading
  // 首包未回才整块 loading；已缓存过该 q（如搜回旧词）则保留列表、只做轻提示
  const loading = searching ? (searchBusy && searchState.data == null) : props.loading
  const error = searching && typed === searchQ ? searchState.error : searching ? null : props.error
  const retry = (): void => {
    if (searching) ensureIssuesLoaded(props.view.owner, props.view.repo, props.view.platform, searchQ, searchPage, true)
    else refresh()
  }
  const clearAll = (): void => {
    setQ(''); setSearchQ(''); setSearchPage(1)
    setFStatus(''); setFScene(''); setFAssignee('')
  }

  return (
    <>
      {/* 仓库概览卡（P4）：默认收起成一行摘要，不挤占 issue 列表的竖向空间 */}
      <RepoOverviewCard owner={props.view.owner} repo={props.view.repo} />

      {/* 头部：当前仓库（含代码平台）+ 条数（搜索命中 / 筛选后 / 总数） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        {pLabel ? <Tag tone="quiet">{pLabel}</Tag> : null}
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
          {props.view.owner}/{props.view.repo}
        </span>
        {!loading && !error ? (searching ? (
          serverReady ? (
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
              匹配 {hits.length} 条{searchHasMore ? '（还有更多）' : ''}
              {searchPage > 1 ? ` · 第 ${searchPage} 页` : ''}
              {activeCount > 0 ? ` · 筛选后 ${rows.length}（仅当前页）` : ''}
            </span>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
              {searchBusy ? '检索中…' : '输入中…'}
            </span>
          )
        ) : localAll.length > 0 ? (
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
            {hasFilter ? `${rows.length} / ${localAll.length} 个 issue` : `${localAll.length} 个 issue`}
          </span>
        ) : null) : null}
      </div>

      {/* 筛选区：搜索态始终渲染（含错误态）—— 搜索报错时仍要能改词、清空、退出搜索；
          仅默认列表的 loading / error 才隐藏筛选区 */}
      {searching || (!loading && !error && localAll.length > 0) ? (
        <div style={{ marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <Input
                icon={<IconSearchOutlineRegular />}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索标题 / #编号（全量服务端检索）"
              />
            </div>
            {/* 活动筛选数做徽标：收起时也知道有几个筛选在生效 */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFilters((v) => !v)}
            >
              {showFilters ? '收起筛选' : activeCount > 0 ? `筛选 · ${activeCount}` : '筛选'}
            </Button>
            {hasFilter ? (
              <Button variant="ghost" size="sm" onClick={clearAll}>清除筛选</Button>
            ) : null}
            {/* 复审 Optional：搜索视图有缓存后也要能主动刷新（TTL 之外的手动入口） */}
            {searching ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => ensureIssuesLoaded(props.view.owner, props.view.repo, props.view.platform, searchQ, searchPage, true)}
              >
                刷新
              </Button>
            ) : null}
          </div>
          {showFilters ? (
            <>
              <ChipRow label="状态" options={statusOpts} value={fStatus} onChange={setFStatus} />
              <ChipRow label="场景" options={sceneOpts} value={fScene} onChange={setFScene} />
              <ChipRow label="指派" options={assigneeOpts} value={fAssignee} onChange={setFAssignee} />
            </>
          ) : null}
        </div>
      ) : null}

      <States
        loading={loading}
        error={error}
        empty={rows.length === 0}
        emptyText={
          serverReady
            ? (activeCount > 0
                ? '没有符合筛选条件的匹配结果，可清除筛选。'
                : `服务端检索无匹配：没有标题或编号包含「${searchQ}」的 issue。`)
            : searching
              ? '正在检索…'
              : hasFilter ? '没有符合条件的 issue。' : '该仓库暂无 issue。'
        }
        onRetry={retry}
        errorAction={searching ? <Button variant="outline" size="sm" onClick={clearAll}>清除搜索</Button> : undefined}
      >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {shown.map((it, i) => {
          const o = asObj(it)
          // 编号统一为字符串（GitCode 整数 / Gitee 字母数字），缺失时为空串而非 0（Issue #39）
          const number = normalizeIssueNumber(str(o.issue_number)) || normalizeIssueNumber(str(o.number))
          // 无编号的行钻取不了（宿主 /pipeline 收空 number 只会 400），也不可 pin
          const drillable = number !== ''
          const title = str(o.title)
          const status = str(o.status)
          const stage = str(o.stage)
          const scene = str(o.scene_name)
          const assignee = str(o.assignee)
          const evCount = num(o.events_count) ?? 0
          const latest = asObj(o.latest_event)
          const running = o.is_running === true || str(o.is_running) === 'true' || status === 'processing'
          return (
            <Row
              key={`${number || 'none'}-${i}`}
              title={drillable ? title : `${title}（无编号，无法展开）`}
              onClick={drillable
                ? () => pushView({
                  kind: 'pipeline', owner: props.view.owner, repo: props.view.repo,
                  number, title, platform: props.view.platform,
                })
                : undefined}
            >
              <StateDot state={running ? 'ongoing' : 'idle'} size={8} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary, #1d1d1f)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {drillable ? `#${number}` : '—'} {title}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, flexWrap: 'wrap' }}>
                  {/* stage 与 status 相同时不重复显示（例如都是 pending_review） */}
                  {stage && stage !== status ? <Tag tone="quiet">{stage}</Tag> : null}
                  <Tag tone={toneOf(status)}>{statusLabel(status) || '未知'}</Tag>
                  {scene ? <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>{scene}</span> : null}
                  {/* 指派为空时也标出来：否则这行看起来比别的行少了东西 */}
                  <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #86868b)' }}>
                    {assignee ? `@${assignee}` : '未指派'}
                  </span>
                  {evCount > 0 ? (
                    <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>{evCount} 事件</span>
                  ) : null}
                  {latest.created_at ? (
                    <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #86868b)' }}>{relTime(str(latest.created_at))}</span>
                  ) : null}
                </div>
              </div>
              {/* 观察切换：放在钻取箭头**之前**，让箭头始终是行末的"钻进去"语义 */}
              <PinToggle
                owner={props.view.owner}
                repo={props.view.repo}
                number={number}
                title={title}
                platform={props.view.platform}
              />
              <span style={{ flex: 'none', display: 'flex', color: 'var(--dsw-alias-label-secondary, #6e6e73)' }} aria-hidden>
                <IconChevronRightOutlineRegular />
              </span>
            </Row>
          )
        })}

        {/* 默认列表前端分页：后端一次给全量，这里按页揭示（搜索态用服务端翻页，不叠加） */}
        {!searching && rows.length > limit ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', justifyContent: 'center' }}>
            <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + ISSUE_PAGE_SIZE)}>
              加载更多
            </Button>
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
              {limit} / {rows.length}
            </span>
          </div>
        ) : null}
      </div>
    </States>

    {/* 搜索翻页：平台 q 响应 total=null，只能靠 has_more 判断还有没有下一页。
        复审 Optional：放在 States 外，本页为空（rows=0）时也保留「上一页」可退。 */}
    {serverReady && (searchPage > 1 || searchHasMore) ? (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', justifyContent: 'center', flexWrap: 'wrap' }}>
        {searchPage > 1 ? (
          <Button variant="outline" size="sm" onClick={() => setSearchPage((p) => Math.max(1, p - 1))}>上一页</Button>
        ) : null}
        <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
          第 {searchPage} 页 · 本页 {hits.length} 条{searchHasMore ? ' · 还有更多' : ' · 已到最后一页'}
        </span>
        {searchHasMore ? (
          <Button variant="outline" size="sm" onClick={() => setSearchPage((p) => p + 1)}>下一页</Button>
        ) : null}
      </div>
    ) : null}
    </>
  )
}

// ─────────────────────────── ③ 流水线详情 ───────────────────────────

function PipelineDetail(props: { view: Extract<BrowseView, { kind: 'pipeline' }>; data: unknown; loading: boolean; error: string | null }): ReactNode {
  const root = asObj(props.data)
  const pipeView = derivePipelineViewFromData(props.data)
  const nodes: GrapeFocusNode[] = pipeView.nodes.map((n) => ({
    tag: n.tag,
    status: n.status,
    seq: n.seq,
    ev: n.ev,
    retries: n.retries,
    outsideScene: n.outsideScene,
  }))
  const overallTone: TagTone = TONE_BY_CODE[pipeView.overallCode] ?? 'neutral'
  const summary = str(root.summary)
  const base = getBaseUrl()
  const view = props.view
  // 深链把仓库写进**路径**（`/app/<owner>/<repo>/#pipe/<N>`）：
  // 前端按路径应用仓库，同号不同仓库才不会互相串
  const url = base ? grapeAppUrl(base, { view: 'pipe', owner: view.owner, repo: view.repo, number: view.number }) : ''

  /**
   * 跟随 = **加入观察列表**（多卡并行观察），不再是「设为主焦点」。
   *
   * 语义澄清（这也是 multi-pin 设计的 Q1 决策）：
   *   AI 焦点卡 = **被动**槽位（AI 调工具才有内容）
   *   pin      = **主动**槽位（用户明确要看）
   * 用主动动作去覆盖被动槽位属于语义混用，所以两者同屏并列、互不干扰。
   *
   * 三种结果都**一律切到实时**：要么看到新卡，要么看到提示。
   * ⚠️ 提示必须交给 pins-store、由**实时面板**渲染 —— 写在浏览面板里的提示会因为
   * 「切换模式 → 浏览面板卸载」而永远看不到（实测踩到过这个坑）。
   */
  const onFollow = (): void => {
    const { owner, repo, number } = props.view
    const r = addPin({ owner, repo, number, title: props.view.title, platform: props.view.platform })
    if (r === 'added') setNotice(`已加入观察：#${number}${props.view.title ? ` ${props.view.title}` : ''}`)
    else if (r === 'exists') setNotice(`#${number} 已在观察中`)
    else if (r === 'full') setNotice(`最多同时观察 ${MAX_PINS} 个，请先取消一些`)
    else setNotice('无法跟随：issue 信息不完整')

    setMode('live')
    // 侧栏被收起时顺带展开
    autoOpenOrSwitch()
  }

  return (
    <States
      loading={props.loading}
      error={props.error}
      empty={pipeView.total === 0}
      emptyText="该 issue 还没有流水线记录。"
      onRetry={refresh}
    >
      {/* issue 标题行：标题 / 状态 / 仓库名 分三行，不挤在同一基线 */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #1d1d1f)' }}>
          #{props.view.number}{props.view.title ? ` ${props.view.title}` : ''}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <StateDot state={pipeView.executing ? 'ongoing' : 'idle'} size={8} />
          {/* 整体状态取业务字段（完成 / 待审核 / 进行中…），不再读 pipeline 顶层 status */}
          <Tag tone={overallTone}>{pipeView.overallLabel || '未知'}</Tag>
          {pipeView.stage ? <Tag tone="quiet">{pipeView.stage}</Tag> : null}
        </div>
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          {platformLabel(props.view.platform) ? <Tag tone="quiet">{platformLabel(props.view.platform)}</Tag> : null}
          <span>{props.view.owner}/{props.view.repo}</span>
        </div>
        {pipeView.overallDetail ? (
          <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)', marginTop: 4 }}>{pipeView.overallDetail}</div>
        ) : null}
        {pipeView.sceneUnknown ? (
          <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)', marginTop: 4 }}>
            场景未知，按事件推断（节点链取事件段首次出现顺序）
          </div>
        ) : null}
      </div>

      <NodeChain nodes={nodes} />

      {pipeView.total > 0 ? (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
          {pipeView.done}/{pipeView.total} 已完成
        </div>
      ) : null}

      {summary ? (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
          {summary}
        </div>
      ) : null}

      {/* 事件明细（P5）：节点链是骨架，这里是全过程 —— 实测同 issue 5 个节点 vs 17 条事件 */}
      <EventList owner={props.view.owner} repo={props.view.repo} number={props.view.number} />

      {/* 动作栏：不依赖 url 是否取到 —— 「跟随」走宿主代理，与 baseUrl 无关 */}
      <div
        style={{
          display: 'flex', gap: 8, marginTop: 14, paddingTop: 12,
          borderTop: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))', flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <Button variant="primary" size="sm" onClick={onFollow}>
          跟随此 issue
        </Button>
        {url ? (
          <>
            <Button variant="outline" size="sm" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>
              在官网打开
            </Button>
            <Button variant="outline" size="sm" onClick={() => openInSidebarBrowser(url)}>
              在侧栏浏览器打开
            </Button>
          </>
        ) : null}
        {null}
      </div>
    </States>
  )
}

// ─────────────────── 事件明细（P5，`issues events`）───────────────────

/** 事件明细每页条数（事件多的 issue 可达上百条） */
const EVENT_PAGE = 30

/**
 * 筛选 chip 行的**标签列宽**（定宽）。
 *
 * 为什么定宽而不是让标签自适应：标签文案长度不一（「状态」24px、「Agent」约 40px），
 * 自适应会让**各处的 chip 起始位置不一致** —— 同屏多个 ChipRow（issue 列表的
 * 状态/场景/指派 + 事件明细的 Agent）看起来就参差不齐。
 * 定宽后 chip 一律从行首 +48px 开始（间距也收进这个宽度里，故行 gap 为 0）。
 * 48px 对现有全部标签都够（最长的是拉丁字母「Agent」）。
 */
const CHIP_LABEL_WIDTH = 48

/**
 * issue 的事件明细列表。
 *
 * 与节点链的分工（P5 的立论依据，实测 `grape-admin#11`）：
 *   pipeline 的 `segments` = **阶段节点**（5 个）—— 骨架，看当前走到哪
 *   events 的 `events`    = **每个事件**（17 条）—— 全过程，看发生过什么
 * 两者同时存在于 `issues events` 的返回里（实测 `segments` 与 `events` 内容完全相同，
 * 前者只是别名），所以统一读 `events`。
 *
 * 默认**展开**（这就是 P5 要交付的东西，不该再藏一层），超出 30 条才分页。
 */
function EventList(props: { owner: string; repo: string; number: string }): ReactNode {
  const st = eventsFor(props.owner, props.repo, props.number)
  const all = asArr(asObj(st.data).events)

  const [fAgent, setFAgent] = useState('')
  const [limit, setLimit] = useState(EVENT_PAGE)

  useEffect(() => {
    ensureEvents(props.owner, props.repo, props.number)
  }, [props.owner, props.repo, props.number])

  // 筛选变化 / 新数据到达 → 回到第一页
  useEffect(() => { setLimit(EVENT_PAGE) }, [fAgent, all.length])

  // 取值域从全量派生（与 issue 列表同理：不随当前筛选塌缩）
  const agentOpts = tally(all, (o) => str(o.agent_type))
  const rows = fAgent ? all.filter((e) => str(asObj(e).agent_type) === fAgent) : all
  const shown = rows.slice(0, limit)

  if (st.error) {
    return (
      <div style={{ marginTop: 14, fontSize: 12, color: 'var(--dsw-alias-state-error, #f87171)' }}>
        事件明细加载失败：{st.error}
      </div>
    )
  }
  if (all.length === 0) {
    return st.loading ? (
      <div style={{ marginTop: 14, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>事件明细加载中…</div>
    ) : null
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #1d1d1f)' }}>
          事件明细
        </span>
        {/* 明确「显示 N / 共 M 条」：光写 `5 / 17` 会被误读成分页 */}
        <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
          {fAgent ? `显示 ${rows.length} / 共 ${all.length} 条` : `共 ${all.length} 条`}
        </span>
      </div>

      {/* 按 agent 筛选：17 条以上时没有它就很难读 */}
      {agentOpts.length > 1 ? (
        <ChipRow label="Agent" options={agentOpts} value={fAgent} onChange={setFAgent} />
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {shown.map((e, i) => {
          const o = asObj(e)
          const seq = num(o.seq)
          const agent = str(o.agent_type)
          const type = str(o.event_type)
          const status = str(o.status)
          const actor = str(o.actor)
          const skill = str(o.skill) || str(o.runtime)
          const created = str(o.created_at)
          return (
            <div
              key={`${seq ?? i}`}
              style={{
                display: 'flex', gap: 8, padding: '7px 10px', alignItems: 'flex-start',
                borderRadius: 8,
              }}
            >
              {/* 序号：等宽 + 定宽，纵向对齐便于扫读 */}
              <span style={{
                flex: 'none', width: 46, fontSize: 11,
                fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
                color: 'var(--dsw-alias-label-secondary, #6e6e73)',
              }}>
                {seq ?? '—'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                  {/* 已按该 agent 筛选时不再重复打标签 —— 整屏都是同一个值，纯噪音 */}
                  {agent && !fAgent ? <Tag tone="quiet">{agent}</Tag> : null}
                  <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-primary, #1d1d1f)' }}>
                    {evLabel(type) || type || '事件'}
                  </span>
                  {status ? <Tag tone={toneOf(status)}>{statusLabel(status)}</Tag> : null}
                  {skill ? (
                    <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>{skill}</span>
                  ) : null}
                </div>
                <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {str(o.summary) || str(o.title)}
                </div>
                {actor || created ? (
                  <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #86868b)', marginTop: 2 }}>
                    {[actor ? `@${actor}` : '', created ? relTime(created) : ''].filter(Boolean).join(' · ')}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}

        {rows.length > limit ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', justifyContent: 'center' }}>
            <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + EVENT_PAGE)}>加载更多</Button>
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>{limit} / {rows.length}</span>
          </div>
        ) : null}
        {rows.length === 0 && fAgent ? (
          <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
            没有该 Agent 的事件。
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ─────────────────────────── 顶层面板 ───────────────────────────

/** 面包屑文案 */
function crumbLabel(v: BrowseView): string {
  switch (v.kind) {
    case 'repos': return '仓库'
    case 'issues': return v.repo
    case 'pipeline': return `#${v.number}`
  }
}

// ─────────────────────────── 快速创建需求（Issue #40）───────────────────────────
//
// 只在**进入仓库后**出现（issue 列表 / 流水线详情）；仓库根列表不显示 —— 建需求必须有
// 明确仓库上下文，在根列表给入口只会多一步「再选仓库」。表单里的仓库取自当前浏览视图，
// 只读展示（不做仓库选择器）；提交中三按钮同禁，双击不会建出两条。

/** 建单表单（按钮在浏览页工具条里，0.5.4 用户要求：紧跟「仓库」面包屑）。共享表单见 CreateIssueForm */
function CreateIssueBar({ view, onClose }: { view: Extract<BrowseView, { kind: 'issues' | 'pipeline' }>; onClose: () => void }): ReactNode {
  // 0.5.4 优化 #1：「创建需求」入口只保留一个；「创建并接管」在表单里选。
  const [submitting, setSubmitting] = useState<'' | 'create' | 'takeover'>('')
  const [error, setError] = useState('')

  const submit = (value: CreateIssueFormValue, action: 'create' | 'takeover' | 'copy'): void => {
    if (submitting || action === 'copy') return   // 单飞：双击 / 二次点击都不再发请求
    setSubmitting(action)
    setError('')
    const payload = {
      owner: view.owner,
      repo: view.repo,
      platform: view.platform,
      title: value.title,
      description: value.description || undefined,
    }
    const done = (): void => onClose()

    if (action === 'takeover') {
      // 创建并接管：建单 → addPin → setMode('live') → 等首节点 → 接管（编排在 create-issue-flow）
      void createIssueAndTakeover(payload, { addPin, setMode, setNotice }).then((r) => {
        if (!r.created) { setError(r.message || '创建需求失败'); return }
        // 已建单但平台没回编号：不能再点一次（会重复建单），关表单并提示刷新列表
        if (!r.number) { setNotice(r.message || '已创建需求，但平台未返回编号，请刷新列表确认'); done(); return }
        done()
      }).finally(() => setSubmitting(''))
      return
    }

    void createIssue(payload).then((r) => {
      if (!r.ok) { setError(r.message || '创建需求失败'); return }
      // 建单成功但平台没回编号：不重建、不加 pin，关表单并提示刷新列表（避免重复提交）
      if (!r.number) { setNotice(r.message || '已创建需求，但平台未返回编号，请刷新列表确认'); done(); return }
      addPin({ owner: view.owner, repo: view.repo, number: r.number, title: value.title, platform: view.platform })
      setMode('live')
      setNotice(`已创建 #${r.number}，已加入观察`)
      done()
    }).finally(() => setSubmitting(''))
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <CreateIssueForm
        mode="create"
        owner={view.owner}
        repo={view.repo}
        submitting={submitting}
        error={error}
        onCancel={onClose}
        onSubmit={submit}
      />
    </div>
  )
}

/** 资源浏览面板（挂到侧栏 Tab 的「浏览」模式） */
export function GrapeBrowsePanel(): ReactNode {
  ensureRootLoaded()
  // 切回「浏览」时若数据已超过 60s，静默重取一次 —— 否则取消/新建的 issue 永远停在旧快照
  useEffect(() => { ensureFreshRoot() }, [])
  const { view, state, stack } = useBrowse()
  // 0.5.4：建单表单的开合提到面板级 —— 按钮放工具条「仓库」面包屑后面，表单仍在下方展开
  const [creating, setCreating] = useState(false)
  useEffect(() => { setCreating(false) }, [viewKeyOf(view)])

  return (
    <div style={{ padding: '12px 14px 16px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* 工具条：面包屑（只放祖先层）+ 右侧成组动作（返回/刷新）── 当前实体由下方标题承载，
          避免面包屑末尾与标题重复同一个 #号 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
          {(stack.length > 1 ? stack.slice(0, -1) : stack).map((v, i, arr) => (
            <span key={`${viewKeyOf(v)}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
              {i > 0 ? (
                <span style={{ display: 'flex', color: 'var(--dsw-alias-label-secondary, #6e6e73)' }} aria-hidden>
                  <IconChevronRightOutlineRegular />
                </span>
              ) : null}
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--dsw-alias-label-secondary, #6e6e73)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  maxWidth: arr.length === 1 && stack.length === 1 ? 200 : 130,
                }}
              >
                {crumbLabel(v)}
              </span>
            </span>
          ))}
        </div>
        {/* 0.5.4：建单入口紧跟在「仓库」面包屑后面（同一行），不再单独占一行；
            用户要求做成黑底白字的主按钮（0.5.4 反馈） */}
        {view.kind !== 'repos' && !creating ? (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>创建需求</Button>
        ) : null}
        {stack.length > 1 ? (
          <Button variant="ghost" size="sm" onClick={popView}>返回</Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={refresh}>刷新</Button>
      </div>

      {/* 仓库内快捷建单（Issue #40）：仅进入仓库后出现，根列表不给入口 */}
      {view.kind !== 'repos' && creating ? (
        <CreateIssueBar view={view} onClose={() => setCreating(false)} />
      ) : null}

      {/* 分类标题（第一层） */}
      {view.kind === 'repos' && stack.length === 1 ? (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
            已托管仓库 · 点击查看 issue
          </span>
          {rootSavedAt() ? (
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #86868b)' }}>
              数据 {new Date(rootSavedAt() as number).toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
          ) : null}
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0 }}>
        {view.kind === 'repos'
          ? <RepoList data={state.data} loading={state.loading} error={state.error} savedAt={state.savedAt} />
          : view.kind === 'issues'
            ? <IssueList view={view} data={state.data} loading={state.loading} error={state.error} />
            : <PipelineDetail view={view} data={state.data} loading={state.loading} error={state.error} />}
      </div>
    </div>
  )
}

/** 面包屑 key 用（避免把 viewKey 从 store 引入造成循环语义混乱） */
function viewKeyOf(v: BrowseView): string {
  switch (v.kind) {
    case 'repos': return 'repos'
    case 'issues': return `i-${v.owner}/${v.repo}`
    case 'pipeline': return `p-${v.number}`
  }
}