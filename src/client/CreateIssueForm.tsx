/**
 * 共享建单表单（Issue #42）：浏览页「创建需求 / 创建需求并接管」与需求卡「复制需求」共用。
 *
 * 为什么抽出来：两处的字段、校验、提交态、错误展示完全同形，各写一套必然漂移
 * （#40 已把「标题 200 字 / 提交中三按钮同禁 / 错误可读」写进表单内联实现）。
 *
 * 职责边界：表单只管**字段与本地校验**；提交（建单 / 建单并接管 / 复制后 pin）由父组件
 * 传入 `onSubmit`，`submitting` 与 `error` 也由父组件下发 —— 面板的 store / notice 不进这里。
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'

const CARD_RADIUS = 'var(--dsw-radius-lg, 10px)'
const TITLE_MAX = 200
const DESCRIPTION_MAX = 10_000

/** 场景下拉项（`/grape-panel-api/scenes` 的投影子集） */
export interface SceneOption {
  id: string
  display_name: string
  work_branch?: string
  degraded?: boolean
}

/** 表单提交值（父组件据此拼 `POST /grape-worker-api/create-issue`） */
export interface CreateIssueFormValue {
  title: string
  description: string
  /** 仅 copy 模式 / 有场景列表时可能非空 */
  sceneId: string
}

export type CreateIssueFormAction = 'create' | 'takeover' | 'copy'

export interface CreateIssueFormProps {
  /** `create` = 浏览页（可再点「创建并接管」）；`copy` = 需求卡复制（单按钮「创建并执行」） */
  mode: 'create' | 'copy'
  owner: string
  repo: string
  /** 打开表单时默认高亮的动作（浏览页记住用户点的是哪个入口） */
  initialAction?: 'create' | 'takeover'
  initial?: { title?: string; description?: string; sceneId?: string }
  /** 可切换的场景（copy 模式必给；create 模式可省略 → 不渲染下拉，行为与 #40 一致） */
  scenes?: SceneOption[]
  scenesLoading?: boolean
  scenesDegraded?: boolean
  /** 在途动作（'' = 空闲）；任一位非空时三按钮同禁，天然单飞 */
  submitting?: '' | CreateIssueFormAction
  /** 父组件下发的可读错误 */
  error?: string
  onCancel: () => void
  onSubmit: (value: CreateIssueFormValue, action: CreateIssueFormAction) => void
}

/** 一行标签 + 值的只读展示（仓库） */
const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6e6e73)' }

export function CreateIssueForm(props: CreateIssueFormProps): ReactNode {
  const { mode, owner, repo, initial, scenes, submitting = '', error = '' } = props
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [sceneId, setSceneId] = useState(initial?.sceneId ?? (scenes?.length === 1 ? scenes[0].id : ''))
  const [intent, setIntent] = useState<'create' | 'takeover'>(props.initialAction ?? 'create')
  const [localError, setLocalError] = useState('')

  const busy = Boolean(submitting)
  const shownError = error || localError

  // 场景列表异步到达（复制需求先取 task 再取 scenes）：到达后补默认值，
  // 优先源场景（initial.sceneId），否则唯一场景；已有选择时不覆盖用户操作。
  useEffect(() => {
    if (sceneId) return
    const fallback = initial?.sceneId || (scenes?.length ? scenes[0].id : '')
    if (fallback) setSceneId(fallback)
  }, [sceneId, initial?.sceneId, scenes])

  /** 校验在提交时做（不发请求）；标题 / 描述长度与宿主校验同口径 */
  const submit = (action: CreateIssueFormAction): void => {
    if (busy) return
    const t = title.trim()
    if (!t) { setLocalError('标题不能为空'); return }
    if ([...t].length > TITLE_MAX) { setLocalError(`标题不能超过 ${TITLE_MAX} 字`); return }
    const d = description.trim()
    if (mode === 'copy' && !d) { setLocalError('描述不能为空（复制需求默认带上原文与 Issue 链接）'); return }
    if ([...d].length > DESCRIPTION_MAX) { setLocalError(`描述不能超过 ${DESCRIPTION_MAX} 字`); return }
    setLocalError('')
    props.onSubmit({ title: t, description: d, sceneId }, action)
  }

  const sceneSelect = scenes && scenes.length ? (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...labelStyle }}>
      <span>
        流水线{scenes.length === 1 ? '（仅当前场景）' : ''}
        {props.scenesDegraded ? ' · 降级' : ''}
      </span>
      <select
        value={sceneId}
        disabled={busy || props.scenesLoading}
        onChange={(e) => setSceneId(e.target.value)}
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
        {scenes.map((s) => (
          <option key={s.id} value={s.id}>
            {[s.display_name || s.id, s.work_branch].filter(Boolean).join(' · ')}
          </option>
        ))}
      </select>
    </label>
  ) : null

  return (
    <div
      style={{
        border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
        borderRadius: CARD_RADIUS,
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...labelStyle }}>
        <span>仓库</span>
        <span style={{ color: 'var(--dsw-alias-label-primary, #1d1d1f)', fontWeight: 600 }}>{owner}/{repo}</span>
        <span>（只读）</span>
      </div>
      <Input
        value={title}
        maxLength={TITLE_MAX}
        placeholder={`标题（必填，≤${TITLE_MAX} 字）`}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        style={{ fontSize: 12 }}
      />
      <textarea
        value={description}
        placeholder={mode === 'copy' ? '描述（必填，已带上原文与 Issue 链接）' : '描述（可选，不超过 10000 字）'}
        maxLength={DESCRIPTION_MAX}
        rows={mode === 'copy' ? 6 : 3}
        disabled={busy}
        onChange={(e) => setDescription(e.target.value)}
        style={{
          resize: 'vertical',
          font: 'inherit',
          fontSize: 12,
          padding: 6,
          borderRadius: 'var(--dsw-radius-sm, 6px)',
          border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))',
          background: 'transparent',
          color: 'inherit',
        }}
      />
      {sceneSelect}
      {shownError ? (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #ff3b30)' }}>{shownError}</div>
      ) : null}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Button variant="ghost" size="sm" disabled={busy} onClick={props.onCancel}>取消</Button>
        {mode === 'copy' ? (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => submit('copy')}>
            {submitting === 'copy' ? '创建中…' : '创建并执行'}
          </Button>
        ) : (
          <>
            <Button
              variant={intent === 'create' ? 'primary' : 'outline'}
              size="sm"
              disabled={busy}
              onClick={() => { setIntent('create'); submit('create') }}
            >
              {submitting === 'create' ? '创建中…' : '创建'}
            </Button>
            <Button
              variant={intent === 'takeover' ? 'primary' : 'outline'}
              size="sm"
              disabled={busy}
              onClick={() => { setIntent('takeover'); submit('takeover') }}
            >
              {submitting === 'takeover' ? '创建中…' : '创建并接管'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

export default CreateIssueForm