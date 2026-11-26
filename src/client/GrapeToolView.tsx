/**
 * grape 工具的客户端卡片（tool.call.toolview）。
 *
 * 两个职责：
 *   1. 渲染工具调用行（因为注册 toolview 会**接管整行渲染**，替换 dsh 的通用行）
 *   2. 观察结果里的焦点标记 → 写入共享 store → 驱动侧栏实时观察窗
 *
 * 注意：dsh 文档说明"Registering an occupied key replaces its view"，所以我们
 * 必须自己把卡片渲染出来（presentCall/presentResult 的默认呈现会被绕过）。
 */

import { useEffect, useState, type ReactNode } from 'react'
import { extractIssueNumberFromText } from '../issue-number.js'
import { currentRepo, viewState } from './browse-store.js'
import { autoOpenOrSwitch } from './panel-control.js'

/**
 * 卡片正文先用无依赖的等宽 `<pre>`。
 *
 * 为什么不接 dsh 的 `MarkdownText`：它需要整套 `labels`（含 `code`）、
 * `fileMentions`、`pathImages` props，缺一个就抛
 * `Cannot read properties of undefined (reading 'code')`。
 * 而我们的卡片本来就是等宽框线图，`<pre>` 下可读性没问题。
 */

/** 极小取值器：模型给的参数是"未校验 JSON"，任何字段都可能是别的类型 */
function strOf(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

/** start 阶段记下的调用上下文（owner/repo/title/platform），供 result 阶段的自动 pin 使用 */
const _lastCallCtx: Record<string, { owner: string; repo: string; title: string; platform: string }> = {}

/**
 * 解析已派发调用的参数。
 *
 * `argsRaw` 是**原始 JSON 字符串**（可能是模型写的、未经校验），所以：
 * 非字符串 / 空串 / 解析失败 / 不是对象 → 一律返回 null，绝不抛错。
 */
function parseCallArgs(block: unknown): Record<string, unknown> | null {
  const raw = (block as { argsRaw?: unknown } | undefined)?.argsRaw
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null          // 参数不是合法 JSON：静默忽略，不打扰用户
  }
}

/** 从 ContentBlock[] 里取出纯文本 */
function blocksToText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    const blk = b as Record<string, unknown>
    if (blk && blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text)
  }
  return parts.join('\n')
}

/** 工具名 → 友好标题 */
function toolLabel(toolName: string): string {
  const s = toolName.replace(/^grape_/, '').replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * 尽力确定 owner/repo 的平台 id（gitcode / gitee / ...），用于自动 pin 的平台标签。
 *
 * `grape_create_issue` 的参数里没有 platform，原先写死 `'gitcode'`，在 Gitee 仓库里创建
 * issue 后再自动 pin 会被标成 GitCode（Issue #39 复审 Nit）。这里按「知道就写、不知道就不写」
 * 处理，绝不猜：
 *   ① 侧栏当前仓库正好是它 → 用浏览视图带下来的 platform；
 *   ② 否则在已加载的托管仓库列表里按 full_name / repo_key 找前缀；
 *   ③ 都查不到 → 返回空串，调用方不传 platform（pin 卡片隐藏平台标签，而不是标错）。
 */
function platformOfRepo(owner: string, repo: string): string {
  const cur = currentRepo()
  if (cur && cur.platform && cur.owner === owner && cur.repo === repo) return cur.platform
  const data = viewState({ kind: 'repos' }).data as { repos?: unknown[] } | null
  const want = `${owner}/${repo}`.toLowerCase()
  for (const it of Array.isArray(data?.repos) ? data.repos : []) {
    const o = it as Record<string, unknown>
    const key = strOf(o.repo_key)
    const sep = key.indexOf(':')
    const full = strOf(o.full_name) || (sep > 0 ? key.slice(sep + 1) : key)
    if (full.toLowerCase() !== want) continue
    return sep > 0 ? key.slice(0, sep).toLowerCase() : ''
  }
  return ''
}

interface Props {
  phase?: string
  block?: unknown
  toolName?: string
  callId?: string
}

export function GrapeToolView(props: Props): ReactNode {
  const phase = props.phase || 'result'
  const toolName = props.toolName || 'grape'
  const block = props.block as Record<string, unknown> | undefined

  const isResult = phase === 'result'
  const isError = isResult && block?.isError === true
  const rawText = isResult ? blocksToText(block?.content) : ''
  const body = rawText          // 结果文本已不含任何标记，无需再剥离
  const [open, setOpen] = useState(true)

  /**
   * 工具**已派发**（`phase === 'start'`）时读它的参数，决定要不要把侧栏 Tab 推到用户眼前。
   *
   * 为什么不看结果阶段：
   *   ① 结果要等 CLI 跑完，晚一拍；
   *   ② 原实现靠"结果文本里塞 `<!--grape-focus:…-->` 标记"传递这件事，而结果值是
   *      **模型也会读到的内容** —— 每次 Grape 工具调用都让模型白读一份焦点 JSON。已移除。
   *
   * 契约（dsh-client-ui-tool）：`StartedToolCall.argsRaw` 是**参数的原始 JSON**，
   * 注释原文 "unvalidated model JSON"，所以解析**必须容错**（坏了就当没这回事，不能抛）；
   * `preparing` 阶段没有参数（原文："Preparing blocks have no dispatched arguments"）。
   */
  useEffect(() => {
    if (phase !== 'start') return
    const args = parseCallArgs(block)
    if (!args) return
    const owner = strOf(args.owner)
    const repo = strOf(args.repo)
    if (!owner || !repo) return   // 非仓库维度的调用（如「列托管仓库」）不该切走用户的画面
    autoOpenOrSwitch()
    // 记住 owner/repo/title 供 result 阶段的自动 pin 使用（Issue 创建后 pin 卡片）。
    // title 必须一起带上：pin 卡片标题只来自这里，缺了实时候选列表就只剩「#N」。
    _lastCallCtx[toolName] = { owner, repo, title: strOf(args.title), platform: strOf(args.platform) }
  }, [phase])

  /**
   * result 阶段：创建 Issue 成功后自动加入实时面板观察列表。
   *
   * start 阶段的参数里有 owner/repo 但没有 issue_number（那是执行结果）；
   * result 的渲染文本里有 `#编号`（renderActionConfirm 输出）。两段配合完成自动 pin。
   * 编号解析走 `issue-number.ts`（GitCode 数字 / Gitee 字母数字同一口径，Issue #39），
   * 不在本文件内联正则。依赖模块按需 import，避免顶层引入 pins-store 的循环依赖。
   */
  useEffect(() => {
    if (phase !== 'result' || toolName !== 'grape_create_issue') return
    const ctx = _lastCallCtx[toolName]
    if (!ctx) return
    const number = extractIssueNumberFromText(body)
    if (!number) return
    import('./pins-store.js').then(({ addPin, setNotice }) => {
      // 平台标签：先用调用参数/侧栏上下文，查不到就不传（宁缺毋错，见 platformOfRepo）
      const platform = ctx.platform || platformOfRepo(ctx.owner, ctx.repo) || undefined
      const r = addPin({ owner: ctx.owner, repo: ctx.repo, number, title: ctx.title, platform })
      if (r === 'added') setNotice(`已自动观察 #${number}`)
    }).catch(() => { /* 不会发生：同在 client bundle */ })
  }, [phase, body])

  return (
    <div style={{ margin: '4px 0 4px 4px', fontSize: 13 }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          color: isError ? '#ff3b30' : '#6e6e73', cursor: 'pointer',
          fontSize: 13, lineHeight: '24px',
        }}
      >
        <span style={{ flex: 'none' }}>{isError ? '✕' : phase === 'result' ? '●' : '◌'}</span>
        <span style={{ fontWeight: 500, color: isError ? '#ff3b30' : '#1d1d1f' }}>
          {toolLabel(toolName)}
        </span>
        {!isResult ? <span style={{ opacity: 0.7 }}>运行中…</span> : null}
        <span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 11 }}>{open ? '▾' : '▸'}</span>
      </div>

      {open && body ? (
        <div style={{
          marginTop: 4, border: '0.5px solid rgba(0,0,0,.12)', borderRadius: 8,
          background: 'rgba(0,0,0,.02)', overflow: 'hidden',
        }}>
          <pre style={{
            margin: 0, padding: '10px 12px', whiteSpace: 'pre-wrap',
            wordBreak: 'break-word', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
            fontSize: 12, lineHeight: 1.5,
          }}>{body}</pre>
        </div>
      ) : null}
    </div>
  )
}