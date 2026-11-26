/**
 * 侧栏实时观察窗（`sidebar.right.pane.tab` 的 body）。
 *
 * 展示"AI 当前焦点"的实时状态，三种焦点：
 *   - pipeline：issue 流水线节点链（主态）
 *   - event   ：事件详情
 *   - overview：仓库 / 运维概览
 *
 * 数据来自共享 store（由 GrapeToolView 写入）。
 *
 * ── 样式铁律 ──
 *  · 只用 dsh 官方 UI 原语（`@deepseek-ai/dsh-client-ui-primitives`）与
 *    `--dsw-*` 设计 token。原语的注释明说 "styled only through `--dsw-*` tokens"，
 *    写死 #fff / #1d1d1f 在暗色主题下会直接崩掉观感。
 *  · 图标一律用官方图标组件（`./icons`），不要用 Unicode 箭头/emoji ——
 *    字号、颜色、线宽才能与 dsh 自身一致。
 *  · 面板顶部**不再重复标题**：Tab chip 已经写了「Grape 实时观察窗」。
 */

import { Fragment, useEffect, useState, type ReactNode } from 'react'
import {
  Button,
  StateDot,
  Tag,
  IconChevronRightOutlineRegular,
  IconCloseOutlineRegular,
  IconPinOutlineRegular,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GrapeFocus, GrapeFocusNode, GrapeStatusNum } from '../focus.js'
import { statusNumText, platformLabel } from '../focus.js'
import { statusLabel } from '../status-label.js'
import { formatTime } from '../time-format.js'
import {
  addPin, getNotice, movePin, pinSummary, pinToFocus, platformFor, refreshAllPins, refreshPin, removePin, togglePin, usePins,
  followPin,
  setNotice,
  type Pin,
} from './pins-store.js'
import type { PreviewIssue, PreviewPick } from '../preview-select.js'
import { openBrowse, pinPreview, usePreview } from './preview-store.js'
import { pushView, refresh, resetToRoot } from './browse-store.js'
import { canAutoRecoverPendingTakeover, clearPendingTakeover, getPendingTakeoverId, hasPendingTakeover, localSessionExists, openExistingSession, reconcileTakeoverSessions, tryRecoverPendingTakeover, switchToTakeoverWorkspace } from './takeover-switch.js'
import { postTakeoverList, requestTakeover } from './takeover-flow.js'
import { takeoverStillActive } from '../takeover-plan.js'
import { stopLocalSession } from './session-ctl.js'
import { setTakeoverBusy, setTakeoverSession, useTakeoverState } from './takeover-store.js'
import { autoOpenOrSwitch } from './panel-control.js'
import { setMode } from './tab-mode.js'
import { openInSidebarBrowser, onUserManualAction } from './panel-control.js'
import { createIssue } from './create-issue-flow.js'
import { CreateIssueForm } from './CreateIssueForm.js'
import {
  confirmDone,
  enterChat,
  loadHandoffTargets,
  loadScenes,
  loadTask,
  submitHandoff,
  type ActionTarget,
} from './issue-actions.js'
import { canConfirmDone, canHandoff, copyPrefill, handoffSkipText, issueWebUrl } from '../issue-actions.js'
import type { HandoffTarget, SceneView, TaskView } from '../task-view.js'

/** 事件类型 → 人话（后端是 snake_case 字段名，直接显示会与全中文界面混种） */
const EVENT_LABEL: Record<string, string> = {
  issue_comment: '评论',
  a2a_event: 'A2A 交接',
  issue_opened: '开单',
  issue_created: '开单',
  issue_updated: '状态更新',
  issue_closed: '关单',
  issue_status_changed: '状态变更',
  pull_request_created: '提 PR',
  pull_request_merged: '合并 PR',
  pull_request_closed: '关闭 PR',
  pr_created: '提 PR',
  pr_merged: '合并 PR',
  pr_reviewed: 'PR 评审',
  task_completed: '任务完成',
  deployment: '部署',
  deploy_completed: '部署完成',
}

/** 取事件类型的中文标签（未收录的保留原样，方便排查）。导出给「资源浏览」的事件明细复用同一份映射 */
export function evLabel(ev?: string): string {
  if (!ev) return ''
  return EVENT_LABEL[ev] ?? ev
}

/** 状态码 → Tag 色调 */
const STATUS_TONE: Record<number, TagTone> = {
  0: 'quiet',
  1: 'info',
  2: 'success',
  3: 'danger',
  4: 'warning',
  5: 'neutral',
  6: 'warning',   // 待审核（pending_review）
}

/** 卡片圆角（全部卡片用同一个，避免同屏三种圆角） */
const CARD_RADIUS = 'var(--dsw-radius-lg, 10px)'

function fmtDur(sec?: number): string {
  if (sec === undefined || sec === null) return ''
  if (sec < 60) return `${sec.toFixed(1)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m${s}s`
}

/** 单个节点卡片 */
/** 节点颜色：灰色=未触发，蓝色=已完成，橙色=进行中，红色=失败，黄色=待审核/取消 */
function nodeColor(status: GrapeStatusNum): { bg: string; border: string; text: string } {
  switch (status) {
    case 0: return { bg: 'rgba(0,0,0,.02)', border: 'rgba(0,0,0,.1)', text: '#86868b' }      // 灰色
    case 1: return { bg: 'rgba(255,165,0,.08)', border: '#ff8c00', text: '#1d1d1f' }          // 橙色
    case 2: return { bg: 'rgba(0,113,227,.06)', border: '#0071e3', text: '#1d1d1f' }          // 蓝色
    case 3: return { bg: 'rgba(248,113,113,.06)', border: '#f87171', text: '#1d1d1f' }        // 红色
    case 4: return { bg: 'rgba(255,200,0,.06)', border: '#ffc800', text: '#86868b' }          // 黄色
    case 6: return { bg: 'rgba(255,200,0,.10)', border: '#ffb300', text: '#1d1d1f' }          // 待审核
    default: return { bg: 'rgba(0,0,0,.02)', border: 'rgba(0,0,0,.1)', text: '#86868b' }
  }
}

function NodeBox({ node, onTakeover, activeAgent = '', busyAgent = '' }: {
  node: GrapeFocusNode
  onTakeover?: (agent: string) => void
  /** 已有 active 接管的 agent：该节点显示「接管中」，不可再点 */
  activeAgent?: string
  /** 正在发起接管的 agent：乐观态「接管中…」 */
  busyAgent?: string
}): ReactNode {
  const c = nodeColor(node.status)
  const isActive = Boolean(activeAgent) && node.tag === activeAgent
  const isBusy = Boolean(busyAgent) && node.tag === busyAgent
  // 只有进行中的节点、且尚无 active 接管 / 本次接管请求在途时才给入口（双击不再发两次）
  const canTakeover = node.status === 1 && onTakeover && !isActive && !activeAgent && !isBusy
  // 失败 / 已取消的节点：给人一个"就地救活"的入口（否则只能去官网点重派）
  const canRedispatch = (node.status === 3 || node.status === 4) && typeof node.seq === 'number'
  const [rdBusy, setRdBusy] = useState(false)
  const doRedispatch = (e: { stopPropagation(): void }): void => {
    e.stopPropagation()
    if (!node.seq || rdBusy) return
    setRdBusy(true)
    fetch(new URL('grape-worker-api/event-redispatch', document.baseURI).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ seq: node.seq }),
    })
      .then((r) => r.json().catch(() => ({})))
      .then((d: Record<string, any>) => {
        const detail = (d.detail || {}) as { message?: string; code?: number }
        if (d.status === 'redispatched') {
          setNotice(`已重新派发 ${node.tag.toUpperCase()}（seq ${node.seq}）：task ${String(d.task_id || '').slice(0, 12)}`, 20000)
          refreshAllPins()
        } else {
          setNotice(`重新派发失败：${detail.message || d.message || d.error || `HTTP ${detail.code || '?'}`}`, 30000)
        }
      })
      .catch((err) => setNotice(`重新派发失败：${String(err)}`, 30000))
      .finally(() => setRdBusy(false))
  }
  return (
    <div
      style={{
        flex: '0 0 96px',
        borderRadius: CARD_RADIUS,
        padding: '9px 10px 8px',
        background: c.bg,
        border: `1px solid ${c.border}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        opacity: node.status === 0 ? 0.5 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: c.text }}>
          {node.tag.toUpperCase()}
        </span>
      </div>

      <Tag tone={STATUS_TONE[node.status] ?? 'neutral'}>{statusNumText(node.status)}</Tag>

      {(node.retries ?? 0) > 0 ? (
        <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
          重试 {node.retries} 次
        </span>
      ) : null}
      {node.outsideScene ? (
        <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>场景外</span>
      ) : null}

      <div
        style={{
          fontSize: 11,
          color: 'var(--dsw-alias-label-secondary, #6e6e73)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={[node.ev, node.seq !== undefined ? `seq ${node.seq}` : '', fmtDur(node.dur), node.actor ? `@${node.actor}` : '']
          .filter(Boolean)
          .join(' · ')}
      >
        {evLabel(node.ev) || (node.seq !== undefined ? `seq ${node.seq}` : '') || '\u00a0'}
      </div>
      {fmtDur(node.dur) ? (
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #86868b)' }}>
          {fmtDur(node.dur)}
        </div>
      ) : null}

      {/* 接管按钮：进行中 → 「接管」；已接管 → 「接管中」且不可点；点击后立刻「接管中…」 */}
      {isActive || isBusy || canTakeover ? (
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (isActive || isBusy || !canTakeover) return
            onTakeover!(node.tag)
          }}
          disabled={isActive || isBusy}
          title={isActive ? '该节点已在本地接管中，请用下方「完成 / 放弃 / 打开会话」' : undefined}
          style={{
            marginTop: 4,
            fontSize: 11,
            padding: '2px 6px',
            borderRadius: 'var(--dsw-radius-xs, 4px)',
            border: `1px solid ${isActive ? 'rgba(0,122,255,.45)' : 'var(--dsw-alias-border-l3, rgba(0,0,0,.1))'}`,
            background: isActive ? 'rgba(0,122,255,.08)' : 'transparent',
            color: isActive
              ? 'var(--dsw-alias-state-info-primary, #007aff)'
              : isBusy
                ? 'var(--dsw-alias-label-tertiary, #86868b)'
                : 'var(--dsw-alias-label-secondary, #6e6e73)',
            cursor: isActive || isBusy ? 'default' : 'pointer',
          }}
        >{isActive ? '接管中' : isBusy ? '接管中…' : '接管'}</button>
      ) : null}

      {/* 重新派发：节点失败/已取消时出现 */}
      {canRedispatch ? (
        <button
          onClick={doRedispatch}
          disabled={rdBusy}
          style={{
            marginTop: 4,
            fontSize: 11,
            padding: '2px 6px',
            borderRadius: 'var(--dsw-radius-xs, 4px)',
            border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
            background: 'transparent',
            color: rdBusy ? 'var(--dsw-alias-label-tertiary, #86868b)' : 'var(--dsw-alias-label-secondary, #6e6e73)',
            cursor: rdBusy ? 'default' : 'pointer',
          }}
        >{rdBusy ? '派发中…' : '重新派发'}</button>
      ) : null}
    </div>
  )
}

/** 节点链（横向滚动；卡片等高）。导出给「资源浏览」复用同一套卡片样式。 */
export function NodeChain({ nodes, onTakeover, activeAgent = '', busyAgent = '' }: {
  nodes: GrapeFocusNode[]
  onTakeover?: (agent: string) => void
  activeAgent?: string
  busyAgent?: string
}): ReactNode {
  // 节点链以服务端场景节点为准（去重已在视图模型完成）：这里不再补固定 5 格
  const allNodes = nodes
  if (!allNodes.length) return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 6,
        overflowX: 'auto',
        paddingBottom: 2,
      }}
    >
      {allNodes.map((n, i) => (
        <div
          key={`${n.tag}-${i}`}
          style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}
        >
          <NodeBox node={n} onTakeover={onTakeover} activeAgent={activeAgent} busyAgent={busyAgent} />
          {i < allNodes.length - 1 ? (
            <span
              style={{
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 16,
                color: 'var(--dsw-alias-label-secondary, #6e6e73)',
              }}
              aria-hidden
            >
              <IconChevronRightOutlineRegular />
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/**
 * 需求卡动作区（Issue #42）：2 个逃生舱 + 4 个动作按钮平铺换行。
 *
 * 为什么把 4 个动作集中在**一个**组件里：它们共享同一份 `task`（内部 id / 状态 / 场景 / 描述），
 * 也共享同一个 `busy`（单一字符串 state → 天然单飞：任一动作在途时全部禁用，
 * 连点 / 双击不会造成重复确认或重复移交）。
 *
 * 交互口径：
 *   · 「进入对话」→ 运行中先预检 `/start`（失败不阻断）→ 用系统浏览器打开 Grape 官网聊天深链；
 *   · 「复制需求」→ 预填表单（标题 +（副本）、描述 + Issue 链接、源场景）→ 建单 → pin + 实时；
 *   · 「确认完成」→ 二次确认 → 成功刷新 pin；终态 / 缺 id 时禁用；
 *   · 「移交」→ 目标列表（当前场景打标）→ 成功 / skipped 分别给可读提示。
 */
function IssueActionsBar(props: {
  url?: string
  target: ActionTarget
  onChanged?: () => void
}): ReactNode {
  const { target, url, onChanged } = props
  const [task, setTask] = useState<TaskView | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [taskMsg, setTaskMsg] = useState('')
  const [taskLoading, setTaskLoading] = useState(true)
  const [busy, setBusy] = useState<'' | 'chat' | 'confirm' | 'handoff' | 'copy'>('')
  const [notice, setLocalNotice] = useState('')
  const [error, setError] = useState('')
  const [panel, setPanel] = useState<'' | 'copy' | 'handoff'>('')
  const [confirming, setConfirming] = useState(false)
  const [scenes, setScenes] = useState<SceneView[]>([])
  const [scenesDegraded, setScenesDegraded] = useState(false)
  const [scenesLoading, setScenesLoading] = useState(false)
  const [targets, setTargets] = useState<HandoffTarget[]>([])
  const [targetScene, setTargetScene] = useState('')
  const [targetsLoading, setTargetsLoading] = useState(false)

  // 懒加载：卡片展开才取（不进 20s pin 轮询）
  useEffect(() => {
    let alive = true
    setTaskLoading(true)
    setTaskMsg('')
    void loadTask(target).then((r) => {
      if (!alive) return
      setTask(r.task)
      setBaseUrl(r.baseUrl)
      setTaskMsg(r.message)
      setTaskLoading(false)
    })
    return () => { alive = false }
  }, [target.owner, target.repo, target.number, target.platform])

  /** 动作成功后：精确刷新 task + 让 pin 卡重新取流水线（状态/节点） */
  const afterSuccess = (msg: string): void => {
    setLocalNotice(msg)
    setError('')
    void loadTask(target, { force: true }).then((r) => {
      setTask(r.task)
      setBaseUrl(r.baseUrl || baseUrl)
      setTaskMsg(r.message)
    })
    onChanged?.()
  }

  const openChat = (): void => {
    if (busy) return
    setBusy('chat')
    setError('')
    // 任务取不到时用逃生舱 URL 的 origin 兜底（深链只需要 base）
    const base = baseUrl || (url ? safeOrigin(url) : '')
    void enterChat(target, task, base).then((r) => {
      // 0.5.4：成功不弹提示（打开即打开）；只有失败才给可读原因
      if (!r.ok) setError(r.message || '打开聊天失败')
    }).finally(() => setBusy(''))
  }

  const openCopy = (): void => {
    if (!task) { setError('任务信息未加载，请刷新后重试'); return }
    setPanel('copy')
    setError('')
    setLocalNotice('')
    setScenesLoading(true)
    void loadScenes(target, task.scene_id).then((r) => {
      setScenes(r.scenes)
      setScenesDegraded(r.degraded)
      if (r.message) setError(r.message)
    }).finally(() => setScenesLoading(false))
  }

  const openHandoff = (): void => {
    if (!task || !canHandoff(task)) return
    setPanel('handoff')
    setError('')
    setLocalNotice('')
    setTargets([])
    setTargetScene('')
    setTargetsLoading(true)
    void loadHandoffTargets(task.id).then((r) => {
      setTargets(r.scenes)
      // 0.5.4 优化 #3：默认选中第一个「非当前」目标，省一次点击（当前场景已过滤）
      setTargetScene(r.scenes.find((t) => !t.is_current)?.id ?? '')
      if (r.message) setError(r.message)
    }).finally(() => setTargetsLoading(false))
  }

  // 0.5.4 优化 #3：只列可移交目标（当前场景过滤），下拉与「复制需求」表单同款
  const handoffOptions = targets.filter((t) => !t.is_current)

  const doConfirm = (): void => {
    if (!task || busy) return
    setBusy('confirm')
    setError('')
    void confirmDone(task.id).then((r) => {
      if (!r.ok) { setError(r.message || '确认完成失败'); return }
      setConfirming(false)
      afterSuccess('已标记为完成')
    }).finally(() => setBusy(''))
  }

  const copyPrefillValue = copyPrefill({
    title: task?.title,
    task_description: task?.task_description,
    // Issue 链接 = 平台需求页，不是 focus.url 的流水线深链（Issue #42 复审 Optional）
    url: issueWebUrl(target.platform, target.owner, target.repo, target.number),
  })

  const submitCopy = (value: { title: string; description: string; sceneId: string }): void => {
    if (busy) return
    setBusy('copy')
    setError('')
    void createIssue({
      owner: target.owner,
      repo: target.repo,
      platform: target.platform,
      title: value.title,
      description: value.description || undefined,
      sceneId: value.sceneId || undefined,
    }).then((r) => {
      if (!r.ok) { setError(r.message || '创建需求失败'); return }
      if (!r.number) { setError(r.message || '已创建但未拿到编号，请刷新列表'); return }
      addPin({ owner: target.owner, repo: target.repo, number: r.number, title: value.title, platform: target.platform })
      setMode('live')
      setPanel('')
      setNotice(`已创建 #${r.number}，已加入观察`)
    }).finally(() => setBusy(''))
  }

  const doHandoff = (): void => {
    if (!task || busy || !targetScene) return
    setBusy('handoff')
    setError('')
    void submitHandoff(task.id, targetScene).then((r) => {
      if (r.ok) {
        setPanel('')
        afterSuccess('已移交到目标流水线')
        return
      }
      if (r.skipped) {
        // 正常业务结果：重复移交 / 目标缺节点 —— 用不同措辞，不让用户以为点坏了
        setPanel('')
        setLocalNotice(handoffSkipText(r.skipped))
        return
      }
      setError(r.message || '移交失败')
    }).finally(() => setBusy(''))
  }

  const confirmable = canConfirmDone(task)
  const handoffable = canHandoff(task)
  const disabledHint = taskLoading
    ? '任务信息加载中…'
    : (!task || task.id <= 0)
      ? '缺少需求内部 id，请刷新后重试'
      : '需求已结束'

  return (
    <div
      style={{
        marginTop: 14,
        paddingTop: 12,
        borderTop: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
      }}
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {url ? (
          <Button variant="primary" size="sm" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>
            在官网打开
          </Button>
        ) : null}
        {url ? (
          <Button variant="outline" size="sm" onClick={() => openInSidebarBrowser(url)}>
            在侧栏浏览器打开
          </Button>
        ) : null}
        <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={openChat}>
          {busy === 'chat' ? '打开中…' : '进入对话'}
        </Button>
        <Button variant="outline" size="sm" disabled={Boolean(busy) || !task} onClick={openCopy}>
          复制需求
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={Boolean(busy) || !confirmable}
          title={confirmable ? '' : disabledHint}
          onClick={() => { setConfirming(true); setError(''); setLocalNotice('') }}
        >
          确认完成
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={Boolean(busy) || !handoffable}
          title={handoffable ? '' : disabledHint}
          onClick={openHandoff}
        >
          移交流水线
        </Button>
      </div>

      {notice ? (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-success-primary, #34c759)' }}>{notice}</div>
      ) : null}
      {error ? (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #ff3b30)' }}>{error}</div>
      ) : null}
      {taskMsg ? (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>{taskMsg}</div>
      ) : null}

      {confirming ? (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
            borderRadius: CARD_RADIUS,
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span>确认将该需求标记为完成？此操作会结束当前流水线。</span>
          <Button variant="primary" size="sm" disabled={Boolean(busy)} onClick={doConfirm}>
            {busy === 'confirm' ? '提交中…' : '确认完成'}
          </Button>
          <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => setConfirming(false)}>取消</Button>
        </div>
      ) : null}

      {panel === 'copy' ? (
        <div style={{ marginTop: 10 }}>
          <CreateIssueForm
            mode="copy"
            owner={target.owner}
            repo={target.repo}
            initial={{
              title: copyPrefillValue.title,
              description: copyPrefillValue.description,
              sceneId: task?.scene_id || '',
            }}
            scenes={scenes}
            scenesLoading={scenesLoading}
            scenesDegraded={scenesDegraded}
            submitting={busy === 'copy' ? 'copy' : ''}
            onCancel={() => { setPanel(''); setError('') }}
            onSubmit={(value) => submitCopy(value)}
          />
        </div>
      ) : null}

      {panel === 'handoff' ? (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
            borderRadius: CARD_RADIUS,
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <span style={{ color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
            选择要移交到的流水线{targetsLoading ? '（加载中…）' : ''}
          </span>
          {handoffOptions.length ? (
            <select
              value={targetScene}
              disabled={Boolean(busy)}
              onChange={(e) => setTargetScene(e.target.value)}
              style={{
                font: 'inherit',
                fontSize: 12,
                padding: '6px 8px',
                borderRadius: 'var(--dsw-radius-sm, 6px)',
                border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
                background: 'var(--dsw-alias-bg-layer-3, rgba(255,255,255,.55))',
                color: 'var(--dsw-alias-label-primary, #1d1d1f)',
              }}
            >
              {handoffOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {[t.display_name || t.id, t.work_branch].filter(Boolean).join(' · ')}
                </option>
              ))}
            </select>
          ) : (
            <span style={{ color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
              {targetsLoading ? '正在加载…' : '没有可移交的其他流水线'}
            </span>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <Button variant="primary" size="sm" disabled={Boolean(busy) || !targetScene} onClick={doHandoff}>
              {busy === 'handoff' ? '移交中…' : '移交'}
            </Button>
            <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => { setPanel(''); setError('') }}>取消</Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** 从逃生舱 URL 取 origin（task 视图取不到时的深链 base 兜底） */
function safeOrigin(url: string): string {
  try { return new URL(url).origin } catch { return '' }
}

/** 底部动作栏（带分隔线，动作同一视觉层级；Issue #42 扩为 6 按钮） */
function EscapeHatch({ url, target, onChanged }: {
  url?: string
  target?: ActionTarget
  onChanged?: () => void
}): ReactNode {
  if (target) return <IssueActionsBar url={url} target={target} onChanged={onChanged} />
  if (!url) return null
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        marginTop: 14,
        paddingTop: 12,
        borderTop: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
        flexWrap: 'wrap',
      }}
    >
      <Button variant="primary" size="sm" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>
        在官网打开
      </Button>
      <Button variant="outline" size="sm" onClick={() => openInSidebarBrowser(url)}>
        在侧栏浏览器打开
      </Button>
    </div>
  )
}

/**
 * 主体：按焦点种类渲染
 *
 * `bare` = 只渲染流水线本体，不挂接管条（Issue #28 C1）。预览卡必须用 bare：
 * 接管条一挂载就会 POST takeover-list、起 15s 定时器，并在全局有 pending 接管时
 * 自动恢复会话 —— 预览不该产生任何请求或副作用。
 */
function FocusBody({ focus, bare = false, onChanged }: {
  focus: GrapeFocus | null
  bare?: boolean
  /** 动作成功后的刷新回调（pin 卡传 `refreshPin`；预览不传 → 不产生副作用） */
  onChanged?: () => void
}): ReactNode {
  // hooks 必须在 early-return 之前：接管态由 FocusBody 统一订阅，节点按钮与接管条共用同一份
  const tkRepo = focus?.kind === 'pipeline' && focus.owner && focus.repo ? `${focus.owner}/${focus.repo}` : ''
  const tkIssue = focus?.kind === 'pipeline' ? String(focus.number ?? '') : ''
  // 接管要带对平台（Gitee 的 owner/repo 不能落到 GitCode 同名仓库）：焦点卡没有平台字段，
  // 从本地 pin 取；未知（AI 焦点、未观察过的仓库）传空串，宿主按缺省 gitcode 处理。
  const tkPlatform = focus?.kind === 'pipeline' && focus.owner && focus.repo
    ? platformFor(focus.owner, focus.repo, focus.number ? String(focus.number) : undefined)
    : ''
  const tk = useTakeoverState(tkRepo, tkIssue)
  const pad: React.CSSProperties = {
    padding: '14px 16px',
    fontSize: 13,
    color: 'var(--dsw-alias-label-primary, #1d1d1f)',
  }

  // 没有数据时什么都不渲染（空态占位已按用户要求移除，见面板顶部说明）。
  //
  // ⚠️ 这里原本还有一条"焦点过期就不显示"的判断（30 分钟）。随 AI 焦点卡一起删掉了：
  // 那条判断是为"AI 焦点可能过期"设计的，而现在 `FocusBody` 只被 **pin 卡**调用，
  // 若保留它，一张数据超过 30 分钟没刷新的 pin（例如标签页在后台、轮询暂停后回到前台）
  // 展开后会是**一片空白** —— 显示稍旧的数据远比显示空白好。
  if (!focus) return null

  const title =
    focus.kind === 'pipeline'
      ? `Issue #${focus.number ?? '?'}`
      : focus.kind === 'event'
        ? `事件 seq ${focus.seq ?? '?'}`
        : focus.owner && focus.repo
          ? `${focus.owner}/${focus.repo}`
          : '运维概览'

  const meta = [
    // 用 `owner/repo` 而不是只有 repo：仓库短名在不同 owner 下会重名，
    // 而 pin 卡是跨仓库并行的，"谁的仓库"必须写清
    focus.owner && focus.repo ? `${focus.owner}/${focus.repo}` : (focus.repo ?? ''),
    focus.scene ?? '',
    focus.stage ? `阶段 ${focus.stage}` : '',
  ].filter(Boolean)

  const header = (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StateDot state={focus.executing === true ? 'ongoing' : 'idle'} size={8} />
        <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
        {/* 整体状态以业务字段为准：待审核 / 已完成 / 进行中 / 失败 / 已取消 */}
        {focus.overall ? (
          <Tag tone={STATUS_TONE[focus.overallCode ?? 0] ?? 'neutral'}>{focus.overall}</Tag>
        ) : focus.executing === true ? <Tag tone="info">执行中</Tag> : null}
      </div>
      {meta.length ? (
        <div
          style={{
            fontSize: 12,
            color: 'var(--dsw-alias-label-secondary, #6e6e73)',
            marginTop: 3,
          }}
        >
          {meta.join(' · ')}
        </div>
      ) : null}
    </div>
  )

  if (focus.kind === 'pipeline' && focus.nodes?.length) {
    const total = focus.nodes.length
    const done = focus.nodes.filter((n: GrapeFocusNode) => n.status === 2).length
    const run = focus.nodes.filter((n: GrapeFocusNode) => n.status === 1).length
    const review = focus.nodes.filter((n: GrapeFocusNode) => n.status === 6).length
    const pend = focus.nodes.filter((n: GrapeFocusNode) => n.status === 0).length
    const skipped = focus.nodes.filter((n: GrapeFocusNode) => n.status === 5).length
    const fail = focus.nodes.filter((n: GrapeFocusNode) => n.status === 3 || n.status === 4).length
    // 分母 = 渲染格数（= 场景节点去重数），分子 = 已完成格数 → 恒有 done ≤ total
    const summary = [
      `${done}/${total} 已完成`,
      run ? `${run} 进行中` : '',
      review ? `${review} 待审核` : '',
      // 审核发生在某一格时：节点状态仍是「已完成」，这里单独标出等的是哪一格
      focus.overallCode === 6 && focus.reviewTag ? `${focus.reviewTag} 待审核` : '',
      pend ? `${pend} 待开始` : '',
      skipped ? `${skipped} 跳过` : '',
      fail ? `${fail} 失败/取消` : '',
    ].filter(Boolean).join(' · ')
    const repoStr = focus.owner && focus.repo ? `${focus.owner}/${focus.repo}` : ''
    const issueNum = focus.number ?? ''
    // 接管中的会话（finish/abort 入口）。存在 localStorage 里：接管后可能切到新 session，
    // 回到这个 panel 时还要能点「完成 / 放弃」，不能只存在组件 state 里。
    const tkKey = `grape.takeover.${repoStr}#${issueNum}`
    return (
      <div style={pad}>
        {header}
        {focus.overallDetail ? (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)', marginBottom: 8 }}>
            {focus.overallDetail}
          </div>
        ) : null}
        {focus.sceneUnknown ? (
          <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)', marginBottom: 8 }}>
            场景未知，按事件推断（节点链取事件段首次出现顺序）
          </div>
        ) : null}
        <NodeChain nodes={focus.nodes} activeAgent={tk.info?.agent ?? ''} busyAgent={tk.busyAgent} onTakeover={(agent: string) => {
          // 接管动作统一走 takeover-flow（与「创建并接管」共用同一套顺序逻辑：
          // 乐观 busy → POST → 写本地/共享态 → 切工作区发 prompt → 失败可读原因 + 自检）
          if (!repoStr || !issueNum) return
          void requestTakeover({
            owner: focus.owner ?? '',
            repo: focus.repo ?? '',
            platform: tkPlatform,
            number: String(issueNum),
            agentType: agent,
          })
        }} />
        {/* Issue #28 C1：预览（bare）不挂接管条 —— 否则预览会 POST takeover-list、
            起 15s 定时器，并可能自动恢复另一条 issue 的接管会话 */}
        {bare ? null : <TakeoverBar repoStr={repoStr} issueNum={String(issueNum)} platform={tkPlatform} />}
        {/* 进度：数字 + 细进度条（面板本身就是流水线视图，只给数字太薄） */}
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary, #6e6e73)',
              marginBottom: 6,
            }}
          >
            <span>{summary}</span>
          </div>
          <div
            style={{
              height: 4,
              borderRadius: 'var(--dsw-radius-xs, 2px)',
              background: 'var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${total > 0 ? Math.round((done / total) * 100) : 0}%`,
                background: fail
                  ? 'var(--dsw-alias-state-error-primary, #ff3b30)'
                  : 'var(--dsw-alias-state-success-primary, #34c759)',
                transition: 'width .3s ease',
              }}
            />
          </div>
        </div>
        {focus.summary ? (
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary, #6e6e73)',
              lineHeight: 1.6,
            }}
          >
            {focus.summary}
          </div>
        ) : null}
        {/* Issue #42：4 个卡片动作只在真需求卡（非预览 bare）上出现 —— 预览不产生请求 */}
        <EscapeHatch
          url={focus.url}
          target={!bare && repoStr && issueNum
            ? { owner: focus.owner ?? '', repo: focus.repo ?? '', number: String(issueNum), platform: tkPlatform }
            : undefined}
          onChanged={onChanged}
        />
      </div>
    )
  }

  if (focus.kind === 'event') {
    const n0 = focus.nodes?.[0]
    const rows = n0
      ? ([
          ['状态', statusNumText(n0.status)],
          ['耗时', fmtDur(n0.dur)],
          ['事件类型', n0.ev ?? ''],
          ['执行者', n0.actor ? `@${n0.actor}` : ''],
        ] as const).filter(([, v]) => v)
      : []
    return (
      <div style={pad}>
        {header}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 12,
            rowGap: 6,
            fontSize: 12,
          }}
        >
          {rows.map(([k, v]) => (
            <Fragment key={k}>
              <div style={{ color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>{k}</div>
              <div style={{ color: 'var(--dsw-alias-label-primary, #1d1d1f)' }}>{v}</div>
            </Fragment>
          ))}
        </div>
        {focus.summary ? (
          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary, #6e6e73)',
              lineHeight: 1.6,
            }}
          >
            {focus.summary}
          </div>
        ) : null}
        <EscapeHatch url={focus.url} />
      </div>
    )
  }

  // overview
  const stats = [
    ['总数', focus.stats?.total, 'var(--dsw-alias-label-primary, #1d1d1f)'],
    ['进行中', focus.stats?.progress, 'var(--dsw-alias-state-business-primary, #0071e3)'],
    ['失败', focus.stats?.failed, 'var(--dsw-alias-state-error-primary, #ff3b30)'],
  ] as const
  return (
    <div style={pad}>
      {header}
      {focus.stats ? (
        <div style={{ display: 'flex', gap: 8 }}>
          {stats.map(([label, v, color]) =>
            v === undefined ? null : (
              <div
                key={label}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  padding: '9px 6px',
                  background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02))',
                  border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
                  borderRadius: CARD_RADIUS,
                }}
              >
                <div style={{ fontSize: 17, fontWeight: 700, color }}>{v}</div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--dsw-alias-label-secondary, #6e6e73)',
                    marginTop: 2,
                  }}
                >
                  {label}
                </div>
              </div>
            ),
          )}
        </div>
      ) : null}
      {focus.nodes?.length ? (
        <div style={{ marginTop: 12 }}>
          <NodeChain nodes={focus.nodes} />
        </div>
      ) : null}
      <EscapeHatch url={focus.url} />
    </div>
  )
}

/** 侧栏 Tab body */
// ─────────────────── 观察列表（pin，并行观察多个 issue）───────────────────

/**
 * 一张观察卡：收起态一行，展开后用 `FocusBody` 渲染完整流水线。
 *
 * ⭐ 复用 `FocusBody` 而不是另写一套卡片：pin 的数据被 `pinToFocus()` 组装成
 * `GrapeFocus`，所以 pin 卡与 AI 焦点卡**共用同一套渲染**（节点链/进度条/逃生舱），
 * 不会出现"同一个 issue 在两处长得不一样"。
 */
function PinCard(props: {
  pin: Pin
  /** 在列表中的位置（拖拽落点按"上半/下半"判定，需要它） */
  index: number
  dragging: boolean
  onDragStart: () => void
  setDropAt: (at: number) => void
  onDrop: () => void
  onDragEnd: () => void
}): ReactNode {
  const { pin } = props
  const sum = pinSummary(pin)
  const focus = pinToFocus(pin)
  const [hover, setHover] = useState(false)
  const [xHover, setXHover] = useState(false)
  const statusNum = sum.statusCode
  const tone: TagTone = sum.failed ? 'danger' : (STATUS_TONE[statusNum] ?? 'neutral')
  /** 平台展示名（无则空串 → 不渲染标签） */
  const plat = platformLabel(pin.platform)

  return (
    <div
      // 整张卡可拖：卡片本身就是"可排序项"，另加拖拽把手会多一个视觉元素
      draggable
      onDragStart={(e) => {
        // 必须写点东西进 dataTransfer，否则部分浏览器不认为拖拽已开始
        try { e.dataTransfer.setData('text/plain', pin.id) } catch { /* 某些环境禁写 */ }
        e.dataTransfer.effectAllowed = 'move'
        props.onDragStart()
      }}
      onDragOver={(e) => {
        e.preventDefault()                       // 不 preventDefault 就不会触发 drop
        e.dataTransfer.dropEffect = 'move'
        // 按指针在卡片的**上/下半**决定落点：上半→插到它之前，下半→插到它之后。
        // 这样最后一张的下半就是"列表末尾"，无需额外的空白投放区。
        const r = e.currentTarget.getBoundingClientRect()
        props.setDropAt(e.clientY > r.top + r.height / 2 ? props.index + 1 : props.index)
      }}
      onDrop={(e) => { e.preventDefault(); props.onDrop() }}
      onDragEnd={() => props.onDragEnd()}
      style={{
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))',
        borderRadius: CARD_RADIUS,
        marginBottom: 6,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-3, rgba(255,255,255,.55))',
        // 拖拽中用**降透明度**表示"被拿起"，不位移、不缩放（位移/变形在列表里很难看）
        opacity: props.dragging ? 0.45 : 1,
        cursor: props.dragging ? 'grabbing' : undefined,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={pin.expanded}
        onClick={() => togglePin(pin.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePin(pin.id) } }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', cursor: 'pointer',
          background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))' : 'transparent',
        }}
      >
        {/* 展开箭头在左，与「浏览」面板的目录头一致 */}
        <span
          style={{
            flex: 'none', display: 'flex', color: 'var(--dsw-alias-label-secondary, #6e6e73)',
            transform: pin.expanded ? 'rotate(90deg)' : 'none', transition: 'transform .15s',
          }}
          aria-hidden
        >
          <IconChevronRightOutlineRegular />
        </span>
        {/* 平台标签放**最前**：观察列表是跨仓库/跨平台并行的，第一眼要回答的就是
            "这是哪个平台的 issue"；放在行末则要先扫过标题和状态才看得到。
            与浏览面板用的是同一个映射（focus.ts 的 platformLabel），不会两处叫法不同。
            旧存档里的 pin 可能没有 platform → 标签直接不渲染。 */}
        {plat ? <Tag tone="quiet">{plat}</Tag> : null}
        <span
          style={{
            fontSize: 12, fontWeight: 600, flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
          // 悬停给出完整身份：平台 + owner/repo + 编号 + 标题
          // （收起态放不下 owner/repo，但同一编号来自不同仓库时它才是关键区分）
          title={[plat, `${pin.owner}/${pin.repo}#${pin.number}`, pin.title].filter(Boolean).join(' · ')}
        >
          #{pin.number}{pin.title ? ` ${pin.title}` : ''}
        </span>
        {/* 收起态也给进度：不展开就知道走到哪了 */}
        {sum.total > 0 ? (
          <span style={{ flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
            {sum.done}/{sum.total}
          </span>
        ) : null}
        <Tag tone={tone}>
          {sum.status ? sum.status : pin.error ? '出错' : '加载中'}
        </Tag>
        {/* 取消跟随（嵌在可点行内，必须 stopPropagation，否则会同时展开） */}
        <span
          role="button"
          tabIndex={0}
          aria-label={`取消跟随 #${pin.number}`}
          title="取消跟随"
          onClick={(e) => { e.stopPropagation(); removePin(pin.id) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); removePin(pin.id) }
          }}
          onMouseEnter={() => setXHover(true)}
          onMouseLeave={() => setXHover(false)}
          style={{
            flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 18, height: 18, borderRadius: 999, cursor: 'pointer',
            color: xHover ? 'var(--dsw-alias-state-error, #f87171)' : 'var(--dsw-alias-label-secondary, #6e6e73)',
            background: xHover ? 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))' : 'transparent',
          }}
        >
          <IconCloseOutlineRegular />
        </span>
      </div>

      {pin.expanded ? (
        pin.error && !focus ? (
          <div style={{ padding: '4px 16px 12px', fontSize: 12, color: 'var(--dsw-alias-state-error, #f87171)' }}>
            {pin.error}
            <Button variant="ghost" size="sm" onClick={() => refreshPin(pin.id)}>重试</Button>
          </div>
        ) : focus ? (
          <div style={{ paddingBottom: 4 }}>
            {/* 动作成功（确认完成 / 移交）后让 pin 重新取一次流水线，卡片状态与节点随之更新 */}
            <FocusBody focus={focus} onChanged={() => refreshPin(pin.id)} />
            <div style={{ padding: '0 16px 12px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="ghost" size="sm" onClick={() => refreshPin(pin.id)} disabled={pin.loading}>
                {pin.loading ? '刷新中…' : '刷新'}
              </Button>
              {/* pin ↔ 浏览 联动：直接定位到这个 issue 的流水线详情 */}
              <Button variant="ghost" size="sm" onClick={() => openPinInBrowse(pin)}>在浏览中打开</Button>
            </div>
          </div>
        ) : (
          <div style={{ padding: '4px 16px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
            加载中…
          </div>
        )
      ) : null}
    </div>
  )
}



/**
 * 拖拽落点的指示线。
 *
 * **刻意用一条线**而不是让被拖的卡片位移/缩放：卡片在列表里位移很难看
 * （用户对 hover 位移/变形明确反感），而一条 2px 的线把"会落到哪"表达得最准。
 */
function DropLine(): ReactNode {
  return (
    <div
      style={{
        height: 2, margin: '2px 0 4px', borderRadius: 2,
        background: 'var(--dsw-alias-brand-primary, #6f6cff)',
      }}
    />
  )
}

/**
 * 从 pin 跳到「浏览」面板并定位到这个 issue（pin ↔ 浏览 联动）。
 *
 * 导航栈构造成 `仓库列表 → issue 列表 → 流水线详情`：这样点进去后按一次「返回」
 * 落在该仓库的 issue 列表（而不是被打回根目录），符合用户此刻的心理位置。
 */
function openPinInBrowse(pin: Pin): void {
  resetToRoot()
  pushView({ kind: 'issues', owner: pin.owner, repo: pin.repo, platform: pin.platform })
  pushView({
    kind: 'pipeline', owner: pin.owner, repo: pin.repo,
    number: pin.number, title: pin.title, platform: pin.platform,
  })
  setMode('browse')
  // 侧栏被收起时顺带展开
  autoOpenOrSwitch()
}

/**
 * 实时面板底部的「观察列表」区。
 *
 * 与上方 AI 焦点卡**并列而非合并**：焦点卡是"AI 在做什么"（被动），
 * 这里是"我要盯什么"（主动）。为空时整区不渲染（不占位）。
 */
/**
 * 接管操作条 —— 状态以**服务端**为准（localStorage 只是提示优化）。
 *
 * 为什么改：实测浏览器刷新/换标签后 pin 卡会丢，localStorage 里的 takeoverId 也跟着失效，
 * 结果"服务端明明在接管中，前端却找不到完成/放弃入口"。现在卡片展开时拉
 * `/grape-worker-api/takeover-list`（→ GET /api/takeover/sessions），有 active 会话就渲染，
 * 并每 15 秒刷新一次。
 */
/** token 到期时间的可读形式：`到期 21:41（剩 11h 23m）`，过期为 `已过期`。 */
function fmtExpiry(ts: number): string {
  if (!ts) return ''
  const left = ts * 1000 - Date.now()
  const d = new Date(ts * 1000)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (left <= 0) return '已过期'
  const mins = Math.floor(left / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `到期 ${hhmm}（剩 ${h > 0 ? `${h}h ` : ''}${m}m）`
}

/** 本页内已自动尝试恢复过的 issue（避免 15s 轮询反复重试） */
const _recoverAttempted = new Set<string>()

function TakeoverBar({ repoStr, issueNum, platform = '' }: { repoStr: string; issueNum: string; platform?: string }): ReactNode {
  const [sess, setSess] = useState<{ id: string; agent: string; user: string; local: string; ready: boolean; summary: string; exp: number } | null>(null)
  const [pending, setPending] = useState(false)
  const [recovery, setRecovery] = useState<'idle' | 'running' | 'failed' | 'done'>('idle')
  const key = `grape.takeover.${repoStr}#${issueNum}`

  const dispatchKey = `grape.takeover.dispatched.${repoStr}#${issueNum}`
  const readDispatch = (): { task: string; at: number } | null => {
    try {
      const raw = localStorage.getItem(dispatchKey)
      if (!raw) return null
      const v = JSON.parse(raw) as { task?: string; at?: number }
      if (!v || !v.at || Date.now() - Number(v.at) > 24 * 3600 * 1000) return null
      return { task: String(v.task || ''), at: Number(v.at) }
    } catch { return null }
  }
  const [lastDispatch, setLastDispatch] = useState<{ task: string; at: number } | null>(null)

  const load = (): void => {
    setPending(hasPendingTakeover())
    setLastDispatch(readDispatch())
    if (!repoStr || !issueNum) return
    void postTakeoverList({ repo: repoStr, issue: issueNum, platform })
      .then((sessions) => {
        // 查询失败（null）保留上一次的接管条，不要把「暂时查不到」显示成「已结束」
        if (!sessions) return
        const one = sessions[0] as Record<string, any> | undefined
        // 半截接管：没有会话 / 或会话还没绑本地 session，但本地还有底稿 → 自动恢复一次
        // （用户平时看不到任何按钮；失败时才把「恢复接管会话」交给人）
        // ⚠️ Issue #43 R2/R3：创建进行中、或创建成功后 10s 窗口内，都不能把
        // 「正在创建」误判成「半截接管」再建一条；被门禁挡住时不写 _recoverAttempted，
        // 窗口过后仍可自动恢复。
        if (
          (!one || !one.client_session) &&
          hasPendingTakeover() &&
          canAutoRecoverPendingTakeover() &&
          !_recoverAttempted.has(repoStr + '#' + issueNum)
        ) {
          _recoverAttempted.add(repoStr + '#' + issueNum)
          setRecovery('running')
          void tryRecoverPendingTakeover().then((ok) => {
            setRecovery(ok ? 'done' : 'failed')
            if (ok) window.setTimeout(load, 600)
          })
        }
        // Issue #43 R4：服务端已登记本地会话时，取消同一接管下其它已跟踪会话（保留已登记项）。
        if (one?.id && one?.client_session) {
          reconcileTakeoverSessions(String(one.id), String(one.client_session))
        }
        setSess(one ? { id: String(one.id), agent: String(one.agent_type || ''), user: String(one.username || ''),
          local: String(one.client_session || ''), ready: Number(one.finish_requested_at || 0) > 0,
          summary: String(one.summary || ''), exp: Number(one.token_expires_at || 0) } : null)
        // 同步到共享态：节点按钮的「接管中」与接管条同源，避免两处口径不一致
        setTakeoverSession(repoStr, issueNum, one ? {
          id: String(one.id),
          agent: String(one.agent_type || ''),
          local: String(one.client_session || ''),
          ready: Number(one.finish_requested_at || 0) > 0,
        } : null)
        if (one) setTakeoverBusy(repoStr, issueNum, '')
        // 会话被删后侧栏可能残留旧行：以磁盘为准，尽快把「恢复接管会话」露出来，
        // 不要等用户点了「打开」再等 6s 轮询超时。
        if (one?.client_session) {
          void localSessionExists(String(one.client_session)).then((still) => {
            if (!still) setRecovery((r) => (r === 'running' ? r : 'failed'))
          })
        }
        if (!one) { try { localStorage.removeItem(key) } catch { /* ignore */ } }
      })
      .catch(() => { /* ignore */ })
  }

  useEffect(() => {
    load()
    const t = window.setInterval(load, 15000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoStr, issueNum])

  /** 点「恢复接管会话」前先确认这条接管还活着（完成/放弃/过期就不要建会话了）。 */
  const verifyStillActive = async (tid: string): Promise<boolean> => {
    // 查询失败返回 null（≠ 没有接管）：takeoverStillActive 把它当「无法判定 → 不拦」，
    // 否则一次网络抖动就会 clearPendingTakeover()，用户失去「恢复接管会话」入口。
    return takeoverStillActive(await postTakeoverList({ repo: repoStr, issue: issueNum, platform }), tid)
  }

  const recoverNow = async (): Promise<void> => {
    const tid = getPendingTakeoverId()
    if (tid && !(await verifyStillActive(tid))) {
      clearPendingTakeover()
      setPending(false)
      setNotice('这条接管已经结束（完成/放弃/过期），不能再恢复会话；请重新点「接管」。', 30000)
      load()
      return
    }
    setRecovery('running')
    const ok = await tryRecoverPendingTakeover()
    setRecovery(ok ? 'done' : 'failed')
    if (!ok) setNotice('恢复接管会话失败（详见 takeover-log 里的 recover_failed），可稍后重试或重新接管。', 30000)
    load()
  }

  /**
   * 重建本地会话（本地会话被删 / 从未建起来时）。
   *
   * 不是"再接管一次"：服务端对同一任务已有 active 会话时走 reused 分支，只重签 bundle、
   * 不会再 cancel 任务。拿到新 prompt + workspaceId 后走正常切会话流程。
   */
  const rebuildSession = async (): Promise<void> => {
    setRecovery('running')
    try {
      const r = await fetch(new URL('grape-worker-api/takeover', document.baseURI).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ issue_number: String(issueNum), repo: repoStr, agent_type: sess?.agent || '', platform }),
      }).then((x) => x.json().catch(() => ({}))) as Record<string, any>
      if (r?.ok && r.prompt && r.workspaceId) {
        switchToTakeoverWorkspace(String(r.prompt), String(r.workspaceId), String(r.workspaceName || ''), String(r.takeoverId || ''))
        setRecovery('done')
        load()
        return
      }
      setRecovery('failed')
      setNotice(`重建本地会话失败：${r?.error || r?.message || 'unknown'}`, 30000)
    } catch (e) {
      setRecovery('failed')
      setNotice(`重建本地会话失败：${String(e)}`, 30000)
    }
  }

  const callTk = (path: string, payload: Record<string, unknown>) =>
    fetch(new URL(`grape-worker-api/${path}`, document.baseURI).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json().catch(() => ({}))) as Promise<Record<string, any>>

  const btn = (primary: boolean): React.CSSProperties => ({
    fontSize: 12, padding: '5px 10px', borderRadius: 7, cursor: 'pointer',
    border: primary ? '1px solid var(--dsw-alias-line-secondary, #e5e5e7)' : '1px solid transparent',
    background: primary ? 'var(--dsw-alias-bg-secondary, #f5f5f7)' : 'transparent',
    color: primary ? 'inherit' : 'var(--dsw-alias-label-secondary, #6e6e73)',
  })

  if (!sess && !pending) {
    // 没有接管会话了，但 24h 内有过"放弃接管 → 自动重派"：留一条痕迹，
    // 否则卡片上完全看不出这个节点是被重派过的（只有一个闪过的 notice）。
    if (!lastDispatch) return null
    return (
      <div style={{
        marginTop: 12, padding: '8px 12px', borderRadius: 10,
        border: '1px dashed var(--dsw-alias-line-secondary, #e5e5e7)',
        fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)',
      }}>
        上次放弃接管后已重新派发：task {lastDispatch.task.slice(0, 12) || '(未知)'}
        {' · '}{new Date(lastDispatch.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        {'（节点状态以上方节点链为准）'}
      </div>
    )
  }

  if (!sess) {
    // 有底稿时先自动恢复：running 期间只给一句提示，失败才把按钮交给人。
    if (recovery === 'running') {
      return (
        <div style={{
          marginTop: 12, padding: '10px 12px', borderRadius: 10,
          border: '1px solid var(--dsw-alias-line-secondary, #e5e5e7)',
          fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)',
        }}>
          接管已建立，正在自动恢复本地会话…
        </div>
      )
    }
    if (recovery !== 'failed') return null
    return (
      <div style={{
        marginTop: 12, padding: '10px 12px', borderRadius: 10,
        border: '1px solid var(--dsw-alias-line-secondary, #e5e5e7)',
        background: 'var(--dsw-alias-bg-secondary, #f5f5f7)',
      }}>
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
          自动恢复接管会话失败：服务端接管仍在，但本地会话没建起来
        </div>
        <button style={{ ...btn(true), marginTop: 8 }} onClick={() => { void rebuildSession() }}>恢复接管会话（重发一次 prompt）</button>
      </div>
    )
  }

  return (
    <div style={{
      marginTop: 12, padding: '10px 12px', borderRadius: 10,
      border: '1px solid var(--dsw-alias-line-secondary, #e5e5e7)',
    }}>
      <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
        接管中：{sess.agent}{sess.user ? ` · ${sess.user}` : ''} · {sess.id}
        {sess.local ? ` · 本地会话 ${sess.local.slice(0, 18)}…` : ''}
        {sess.exp ? ` · ${fmtExpiry(sess.exp)}` : ''}
      </div>
      {/* 接管期间平台不该再派这个 issue（webhook / A2A 都不派）：
          用户最容易在这里误解「我改了标签、发了评论，怎么没反应」，
          所以把「为什么没反应」和「该点哪里」写在卡片上。
          措辞留了余地：服务端守门上线前，这里只说「应该 / 若仍发生请反馈」，
          不让面板替还没部署的服务端做承诺。 */}
      <div style={{ fontSize: 11, marginTop: 4, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
        接管期间这个 issue 应处于「暂停自动派发」：其他节点不该被平台自动拉起，
        其他卡片上的「重新派发」也会被插件拒绝。若仍看到别的节点自动开跑，请把这个 issue 反馈给平台。
        要推进流水线，请用下面的「确认完成 / 放弃接管」。
      </div>
      {!sess.local || recovery === 'failed' ? (
        recovery === 'running' ? (
          <div style={{ fontSize: 12, marginTop: 4, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
            正在自动恢复本地会话…
          </div>
        ) : recovery === 'failed' ? (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
              本地会话不可用（尚未创建，或已被手动删除；服务端接管仍在）
            </div>
            <button style={{ ...btn(true), marginTop: 6 }} onClick={() => { void rebuildSession() }}>
              恢复接管会话（重发一次 prompt）
            </button>
          </div>
        ) : null
      ) : null}
      {sess.ready ? (
        <div style={{ fontSize: 12, marginTop: 4, color: 'var(--dsw-alias-label-primary, #1d1d1f)' }}>
          agent 已提交小结：{sess.summary ? sess.summary.slice(0, 90) : '（无内容）'}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button
          style={btn(true)}
          onClick={() => {
            // 不可逆动作（派发下一节点 + 停掉本地会话）→ 先二次确认
            const ok = window.confirm(
              `确认结束 #${issueNum} 当前节点并继续流水线？\n\n`
              + '· 平台会把下一节点派发给对应 agent（带上本节点的交接内容）；\n'
              + '· 接管时新建的本地会话会被停止 —— 停的是当前这一轮，会话仍留在列表里可回看。',
            )
            if (!ok) return
            callTk('takeover-finish', { takeover_id: sess.id, outcome: 'completed', handoff: 'a2a' })
              .then(async (r) => {
                if (r.ok) {
                  clearPendingTakeover()
                  // 平台已确认完成 → 再停本地会话（顺序反了会先停掉 agent，交接内容就没了）
                  const stop = await stopLocalSession(sess.local)
                  // 停稳之后回收 token 文件：finish 时不能直接删（agent 可能还在收尾），
                  // 这一轮结束后再留着就是无主的本地凭据。
                  if (stop.ok && sess.local) {
                    void callTk('takeover-release', { takeover_id: sess.id }).catch(() => {})
                  }
                  const handoffErr = String((r.handoff as { error?: string } | undefined)?.error || '')
                  // 405 = 服务端不提供「finish 时自动 A2A 派发」。此时节点已经走完、流水线也已推进，
                  // 不是「派发失败」，别让用户以为要重试。
                  const noDispatchApi = Boolean(r.handoff && r.handoff.ok === false
                    && /(^|\D)405(\D|$)|method not allowed/i.test(handoffErr))
                  const dispatched = r.handoff && r.handoff.ok !== false
                  setNotice(
                    (noDispatchApi
                      ? '已确认完成；当前服务端不支持自动派发，请到平台手动推进下一节点'
                      : dispatched
                        ? `已确认完成${r.next_agent ? `，已派发下一节点 ${r.next_agent}` : '（无下一节点）'}`
                          + `${r.handoff?.skipped ? '（该节点此前已派发过，未重复派发）' : ''}`
                        : '已确认完成，但派发失败 —— 可在卡片上点「重新派发」重试')
                    + `；${stop.message}`,
                    20000,
                  )
                  // 只有真正派发成功（含「此前已派发过」的 skipped）才开加速窗口；
                  // 派发失败 / 无下一节点时不空转，等用户重试或手动刷新。
                  if (dispatched) followPin(`${repoStr}#${issueNum}`)
                } else {
                  setNotice(`完成失败：${r.message || r.error || 'unknown'}`, 30000)
                }
                load()
              })
              .catch((e) => setNotice(`完成失败：${String(e)}`, 30000))
          }}
          title={
            '确认本节点完成 → 平台把下一节点派发给对应 agent。' +
            '派发内容会带上这段接管的 summary / 证据 / 改动文件清单；不会重做本节点。' +
            '确认后会同时停止接管时新建的本地会话。'
          }
        >{sess.ready ? '确认完成 · 派发下一节点（agent 小结已附）' : '确认完成 · 派发下一节点'}</button>
        <button
          style={btn(false)}
          onClick={() => {
            const ok = window.confirm(
              `确认放弃 #${issueNum} 的接管？\n\n`
              + '· 该节点会交还流水线，由平台自动重新派发；\n'
              + '· 接管时新建的本地会话会被停止（会话仍留在列表里可回看）。',
            )
            if (!ok) return
            callTk('takeover-abort', { takeover_id: sess.id, reason: '用户在前端放弃接管' })
              .then(async (r) => {
                const rd = (r as { redispatch?: { ok?: boolean; task_id?: string } }).redispatch
                if (r.ok) clearPendingTakeover()
                if (r.ok && rd && rd.ok) {
                  // 把重派结果留在卡片上（notice 只闪 20 秒，刷新后就没了）
                  const rec = { task: String(rd.task_id || ''), at: Date.now() }
                  try { localStorage.setItem(dispatchKey, JSON.stringify(rec)) } catch { /* ignore */ }
                  setLastDispatch(rec)
                  // 已交还流水线并重派：60s 内加速刷新，下一节点尽快出现
                  followPin(`${repoStr}#${issueNum}`)
                }
                // 平台已受理 → 停本地会话（本地 agent 继续跑会与新派发的节点双写同一 worktree）
                const stop = r.ok ? await stopLocalSession(sess.local) : { message: '' }
                setNotice(
                  (r.ok
                    ? (rd && rd.ok
                      ? `已放弃接管；该节点已交还流水线，平台正在重新派发（task ${String(rd.task_id || '').slice(0, 12)}）`
                      : '已放弃接管；但自动重派失败，请到平台上手动「重新派发」该节点')
                    : `放弃失败：${r.message || r.error || 'unknown'}`)
                  + (stop.message ? `；${stop.message}` : ''),
                  r.ok ? 20000 : 30000,
                )
                load()
              })
              .catch((e) => setNotice(`放弃失败：${String(e)}`, 30000))
          }}
        >放弃接管</button>
        {sess.local ? (
          <button
            // 放右侧：完成/放弃是主操作，定位会话是辅助动作
            style={{ ...btn(false), marginLeft: 'auto' }}
            title={sess.local}
            onClick={() => {
              void (async () => {
                // 先按磁盘判定：删掉的会话不要在 DOM 里点（会跳到「未分组」留下坏印象）
                const still = await localSessionExists(sess.local)
                if (!still) {
                  setRecovery('failed')
                  setNotice('这条本地会话已被删除（服务端接管仍在）。点「恢复接管会话」可重建一条并重发 prompt。', 30000)
                  return
                }
                openExistingSession(sess.local, '', '', () => {
                  setRecovery('failed')
                  setNotice('侧栏里没找到这条本地会话（可能已被手动删除）。点「恢复接管会话」可重建一条并重发 prompt。', 30000)
                })
              })()
            }}
          >打开接管会话</button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 空态引导卡（pins 为空时显示）。
 *
 * 主按钮直达浏览；次按钮把「当前仓库最近活跃 issue」一键加入观察。
 * 三种空态原因分开说清（未选仓库 / 无 issue / 拉取失败），并在无法加入时
 * 给出**置灰原因**而不是让用户点一个没反应的按钮。
 */
function EmptyGuideCard(props: {
  pick: PreviewPick
  onBrowse: () => void
  onPin: () => void
  onRetry: () => void
}): ReactNode {
  const ready = props.pick.kind === 'ready'
  // 空态卡只在 pinCount === 0 时渲染，故 `full`（要求 pinCount 达上限）不可达；
  // 上限提示仍由 `pinPreview` → `addPin` 返回 `full` 的 notice 路径负责。
  const hint = !ready && props.pick.kind === 'none'
    ? props.pick.reason === 'no-repo'
      ? '先在「浏览」里选一个仓库'
      : props.pick.reason === 'loading'
        ? '正在加载该仓库的 issue…'
        : props.pick.reason === 'not-loaded'
          ? '在「浏览」里打开该仓库的 issue 列表后，即可一键钉住最近活跃 issue'
          : props.pick.reason === 'error'
            ? `拉取失败：${props.pick.message || '请先在浏览里重试'}`
            : props.pick.reason === 'no-issue'
              ? '这个仓库还没有 issue'
              : ''
    : ''

  return (
    <div
      style={{
        margin: '14px 16px 0',
        padding: '14px 16px',
        border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
        borderRadius: CARD_RADIUS,
        background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02))',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600 }}>实时 · 你钉住的 issue 都在这</div>
      <div
        style={{
          marginTop: 4,
          fontSize: 12,
          lineHeight: 1.6,
          color: 'var(--dsw-alias-label-secondary, #6e6e73)',
        }}
      >
        钉住后这里会持续刷新每个 issue 的流水线进度；也可以先看下面自动挑出的最近活跃 issue。
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Button variant="primary" size="sm" onClick={props.onBrowse}>去浏览挑选 issue</Button>
        <Button
          variant="outline"
          size="sm"
          onClick={props.onPin}
          disabled={!ready}
          title={hint || undefined}
        >
          钉住最近活跃 issue
        </Button>
        {/* 拉取失败必须就地可重试（spec 空态文案是「拉取失败 · 重试」，Issue #28 R3） */}
        {props.pick.kind === 'none' && props.pick.reason === 'error' ? (
          <Button variant="outline" size="sm" onClick={props.onRetry}>重试</Button>
        ) : null}
      </div>
      {!ready && hint ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: 'var(--dsw-alias-label-secondary, #6e6e73)',
          }}
        >
          {hint}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 自动预览卡：虚线边框 +「自动」徽标。
 *
 * 主体复用 `FocusBody`（与 pin 卡同一套渲染口径）；对应流水线**已缓存**时直接完整渲染，
 * 未缓存时给紧凑摘要——不为了预览另发请求（预览用 `/issues` 缓存做选择）。
 * 卡片不参与拖拽排序：它不来自 pins 数组，固定前始终是临时视图。
 */
function PreviewCard(props: {
  issue: PreviewIssue
  focus: GrapeFocus | null
  dataAt?: number
  /** 收起时只留标题 + 一行进度摘要（默认展开，用户可收起） */
  collapsed: boolean
  onToggle: () => void
  onPin: () => void
  onBrowse: () => void
}): ReactNode {
  const { issue } = props
  const plat = platformLabel(issue.platform)
  const status = statusLabel(issue.status)
  const nodes = props.focus?.nodes ?? []
  const total = nodes.length
  const done = nodes.filter((n) => n.status === 2).length
  const progress = total > 0
    ? `${done}/${total} 已完成${props.focus?.stage ? ` · 阶段 ${props.focus.stage}` : ''}`
    : ''

  return (
    <div
      style={{
        margin: '12px 16px 0',
        border: '1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.18))',
        borderRadius: CARD_RADIUS,
        background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02))',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '10px 12px',
          fontSize: 12,
        }}
      >
        <Tag tone="info">自动预览</Tag>
        {plat ? (
          <span style={{ flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
            {plat}
          </span>
        ) : null}
        <span
          style={{
            flex: 1, minWidth: 0, fontWeight: 600,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
          title={[plat, `${issue.owner}/${issue.repo}#${issue.number}`, issue.title].filter(Boolean).join(' · ')}
        >
          #{issue.number}{issue.title ? ` ${issue.title}` : ''}
        </span>
        {issue.status ? (
          <Tag tone="neutral">{status || '未知'}</Tag>
        ) : null}
        {/* 展开/收起：默认展开（首次进入要看到内容），收起后只有标题行 + 一行进度摘要 */}
        <span
          role="button"
          tabIndex={0}
          aria-expanded={!props.collapsed}
          title={props.collapsed ? '展开预览' : '收起预览'}
          onClick={(e) => { e.stopPropagation(); props.onToggle() }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onToggle() } }}
          style={{
            flex: 'none', cursor: 'pointer', padding: '0 2px',
            fontSize: 12, lineHeight: 1,
            color: 'var(--dsw-alias-label-secondary, #6e6e73)',
          }}
        >
          {props.collapsed ? '▸' : '▾'}
        </span>
      </div>
      {props.collapsed ? (
        progress ? (
          <div style={{ padding: '0 12px 10px', fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
            {progress}
          </div>
        ) : null
      ) : (
        <>
          {props.focus ? (
            // 预览卡：bare 渲染，不挂接管条（Issue #28 C1）
            <FocusBody focus={props.focus} bare />
          ) : (
            <div
              style={{
                padding: '4px 16px 12px',
                fontSize: 12,
                lineHeight: 1.6,
                color: 'var(--dsw-alias-label-secondary, #6e6e73)',
              }}
            >
              {issue.owner}/{issue.repo} · {status || '未知'}
              <br />
              在浏览里打开这条流水线可看完整节点（预览不额外发请求）。
            </div>
          )}
          {typeof props.dataAt === 'number' ? (
            <div style={{ padding: '0 16px 6px', fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>
              数据时间：{formatTime(new Date(props.dataAt).toISOString())}（来自浏览缓存，预览不自动刷新）
            </div>
          ) : null}
        </>
      )}
      <div style={{ display: 'flex', gap: 8, padding: '0 16px 14px' }}>
        <Button variant="primary" size="sm" onClick={props.onPin}>固定为观察</Button>
        <Button variant="outline" size="sm" onClick={props.onBrowse}>去浏览换一条</Button>
      </div>
    </div>
  )
}

function PinnedIssues(): ReactNode {
  const pins = usePins()
  const notice = getNotice()
  /** 拖拽中：`from` 是被拖的第几张，`at` 是落点（插到第几张之前；= pins.length 表示末尾） */
  const [drag, setDrag] = useState<{ from: number; at: number } | null>(null)
  if (!pins.length) return null
  return (
    <div
      style={{
        borderTop: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
        padding: '12px 16px 16px',
      }}
    >
      {/* 标题行。一次性提示**内联在这里**而不是单独占一行 ——
          单独一行会在出现/消失时把整列卡片顶下去再弹回来（评审实测的抖动）。
          提示必须渲染在实时面板里：跟随会立刻切到实时，写在浏览面板里的提示会被卸载掉。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, flex: 'none' }}>观察中</span>
        <span style={{ flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }}>({pins.length})</span>
        {notice ? (
          <span
            style={{
              flex: 1, minWidth: 0, fontSize: 11,
              color: 'var(--dsw-alias-label-secondary, #6e6e73)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
            title={notice}
          >
            {notice}
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}
        <Button variant="ghost" size="sm" onClick={() => setMode('browse')}>+ 添加</Button>
        <Button variant="ghost" size="sm" onClick={refreshAllPins}>全部刷新</Button>
      </div>
      {pins.map((p, i) => (
        <Fragment key={p.id}>
          {/* 落点线画在**第 i 张卡之前**；`at === pins.length` 时画在列表末尾（见下） */}
          {drag && drag.at === i ? <DropLine /> : null}
          <PinCard
            pin={p}
            index={i}
            dragging={drag?.from === i}
            onDragStart={() => setDrag({ from: i, at: i })}
            setDropAt={(at: number) => setDrag((d) => (d ? { ...d, at } : d))}
            onDrop={() => {
              const d = drag
              setDrag(null)
              if (d && d.from !== d.at) movePin(d.from, d.at)
            }}
            onDragEnd={() => setDrag(null)}
          />
        </Fragment>
      ))}
      {/* 列表末尾的落点线（拖到最后一位） */}
      {drag && drag.at >= pins.length ? <DropLine /> : null}
    </div>
  )
}

export function GrapeFocusPanel(): ReactNode {
  const preview = usePreview()
  const pick = preview.pick
  const ready = pick.kind === 'ready' ? pick.issue : null
  return (
    <div
      onPointerDown={onUserManualAction}
      style={{
        height: '100%',
        overflowY: 'auto',
        color: 'var(--dsw-alias-label-primary, #1d1d1f)',
      }}
    >
      {/* 顶部指引。
          ⚠️ 必须放在 `PinnedIssues` **外面**：那个组件在没有卡片时整块返回 null，
          指引放进去就会"最需要它的时候恰好不显示"。
          用官方 pin 图标而不是 📌 emoji —— 这个图标正是"浏览"列表里要点的那个，
          图文对应才不会让人去找一个不存在的按钮。 */}
      <div
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 6,
          padding: '14px 16px 10px',
          // 12px + secondary，而不是 11px + tertiary：这是**指引**，
          // 淡到看不清就等于没有（评审实测 11px 三级太轻）。
          // 仍然是 400 字重，与 12px/600 的「观察中」标题分层清楚。
          fontSize: 12, lineHeight: 1.6,
          color: 'var(--dsw-alias-label-secondary, #6e6e73)',
        }}
      >
        <span style={{ flex: 'none', display: 'flex', marginTop: 2 }} aria-hidden>
          <IconPinOutlineRegular />
        </span>
        <span>
          在「浏览」里给 issue 点这个图标即可加入观察
          <br />
          卡片可拖拽排序、点击展开
        </span>
      </div>
      {preview.pinCount === 0 ? (
        <EmptyGuideCard
          pick={pick}
          onBrowse={openBrowse}
          onPin={() => { if (ready) pinPreview(ready) }}
          onRetry={() => refresh()}
        />
      ) : null}
      {preview.visible && ready ? (
        <PreviewCard
          issue={ready}
          focus={preview.focus}
          dataAt={preview.dataAt}
          collapsed={preview.collapsed}
          onToggle={preview.toggleCollapsed}
          onPin={() => { if (ready) pinPreview(ready) }}
          onBrowse={openBrowse}
        />
      ) : null}
      <PinnedIssues />
    </div>
  )
}