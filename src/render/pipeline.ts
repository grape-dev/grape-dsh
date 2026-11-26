/**
 * 流水线类渲染函数。
 * 用于 pipeline 工具的 render 和 presentResult。
 *
 * 口径（Issue #26）：节点链/整体状态/进度统一来自 `pipeline-model.ts` 的视图模型，
 * 不再按事件段逐条画框、也不再固定 5 格。工具结果里带了 `scene_nodes` 时按场景节点渲染，
 * 场景拉取失败时退化为事件段首次出现顺序并明确标注「场景未知」。
 */

import type { GrapePipelineNode } from '../types.js'
import { formatDuration } from './helpers.js'
import {
  derivePipelineViewFromData,
  nodeStatusLabel,
  progressText,
  type DerivedNode,
  type PipelineView,
} from '../pipeline-model.js'
import type { GrapeStatusNum } from '../focus.js'

/** 节点状态码 → 图标（0 pending 1 running 2 completed 3 failed 4 cancelled 5 skipped 6 pending_review） */
function statusNumIcon(num: GrapeStatusNum | undefined): string {
  if (num === undefined) return '❓'
  const map: Record<number, string> = {
    0: '⬜', // pending
    1: '🔄', // running
    2: '✅', // completed
    3: '❌', // failed
    4: '🚫', // cancelled
    5: '⏭️', // skipped
    6: '⏳', // pending_review
  }
  return map[num] || '❓'
}

/** 视图 → 卡片节点（保留 duration / seq / 重试 / 场景外标记） */
interface CardNode {
  node: DerivedNode
  duration: number | null
}

function viewToCardNodes(view: PipelineView): CardNode[] {
  return view.nodes.map((node) => ({ node, duration: node.dur ?? null }))
}

/**
 * 流水线可视化卡片 —— Unicode 框线节点链。
 *
 * 支持两种数据源：
 * 1. issues pipeline / panel 代理返回的 { segments, statuses, issue_stage, issue_task_status, review_status, scene_nodes, ... }
 * 2. pipeline get 返回的 { active: { stages, statuses, stage, ... } }
 *
 * 输出格式（Markdown 代码块，保证等宽对齐）：
 *
 * ```
 * Pipeline: 通用开发 · Issue 22
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ ✅ VOD   │ ──→ │ ⏳ QA    │ ──→ │ ⬜ SRE   │
 * │ 已完成   │     │ 待审核   │     │ 待开始   │
 * │ 76.5s    │     │          │     │          │
 * │ seq=106  │     │ seq=118  │     │          │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * ✅ 2/3 已完成 · ⏳ 1 待审核
 * 整体: qa · 待审核（pending_review） · 阶段: qa · 事件状态: completed
 * ```
 */
export function renderPipelineCard(data: unknown): string {
  const obj = data as Record<string, unknown>
  if (!obj || typeof obj !== 'object') return String(data)

  const view = derivePipelineViewFromData(data)

  if (view.nodes.length === 0) {
    return renderPipelineNodes(data)
  }

  const active = obj.active as Record<string, unknown> | undefined
  const source = active && typeof active === 'object' ? active : obj
  const sceneName = view.scene || (source.scene_name as string) || (obj.scene_id as string) || ''
  const issueObj = (obj.issue as Record<string, unknown> | undefined) || (source.issue as Record<string, unknown> | undefined)
  const issueId = (issueObj?.number as string | number | undefined) ?? (source.issue_id as string | number | undefined) ?? ''

  let header = 'Pipeline'
  if (sceneName) header += `: ${sceneName}`
  if (issueId !== '' && issueId !== undefined && issueId !== null) header += ` · Issue ${issueId}`

  const NODE_W = 10
  const ARROW = ' ──→ '
  const cards = viewToCardNodes(view)

  const nodeLines = cards.map(({ node, duration }) => {
    const icon = statusNumIcon(node.status)
    const name = node.tag.toUpperCase().slice(0, NODE_W - 1).padEnd(NODE_W - 1)
    const statusText = nodeStatusLabel(node.status).slice(0, NODE_W).padEnd(NODE_W)
    const badges: string[] = []
    if (node.retries > 0) badges.push(`重试 ${node.retries} 次`)
    if (node.outsideScene) badges.push('场景外')
    const subText = duration != null ? formatDuration(duration) : (badges[0] ?? '')
    const lastText = node.seq != null ? `seq=${node.seq}` : (badges[1] ?? '')
    return {
      line1: `${icon} ${name}`.slice(0, NODE_W).padEnd(NODE_W),
      line2: statusText,
      line3: subText.slice(0, NODE_W).padEnd(NODE_W),
      line4: lastText.slice(0, NODE_W).padEnd(NODE_W),
    }
  })

  // 箭头只画在「名字行」，其余行用等宽空格占位 —— 这样框线不会每行都被箭头打断
  const SPACER = ' '.repeat(ARROW.length)
  const topRow = nodeLines.map(() => '┌' + '─'.repeat(NODE_W) + '┐').join(SPACER)
  const row1 = nodeLines.map(n => '│' + n.line1 + '│').join(ARROW)
  const row2 = nodeLines.map(n => '│' + n.line2 + '│').join(SPACER)
  const row3 = nodeLines.map(n => '│' + n.line3 + '│').join(SPACER)
  const row4 = nodeLines.map(n => '│' + n.line4 + '│').join(SPACER)
  const bottomRow = nodeLines.map(() => '└' + '─'.repeat(NODE_W) + '┘').join(SPACER)

  const completed = view.nodes.filter(n => n.status === 2).length
  const running = view.nodes.filter(n => n.status === 1).length
  const review = view.nodes.filter(n => n.status === 6).length
  const pending = view.nodes.filter(n => n.status === 0).length
  const skipped = view.nodes.filter(n => n.status === 5).length
  const failed = view.nodes.filter(n => n.status === 3 || n.status === 4).length

  const stats = [
    `${progressText(view)}`,
    running ? `${running} 进行中` : '',
    review ? `${review} 待审核` : '',
    pending ? `${pending} 待开始` : '',
    skipped ? `${skipped} 跳过` : '',
    failed ? `${failed} 失败/取消` : '',
  ].filter(Boolean)

  // 整体状态（业务字段）与阶段、事件级提示
  const footerParts: string[] = []
  if (view.overallDetail) footerParts.push(`整体: ${view.overallDetail}`)
  if (view.stage) footerParts.push(`阶段: ${view.stage}`)
  // 只在数据真的带顶层 status 时才打「事件状态」；没有就不要拿整体状态冒充
  // （顶层 status 只是「本次事件是否跑完」，Issue #26 Minor）
  const eventStatus = (source.status as string) || (obj.status as string) || ''
  if (eventStatus) footerParts.push(`事件状态: ${eventStatus}`)

  const sceneNote = view.sceneUnknown ? '\n⚠ 场景未知，按事件推断（未取到场景节点，不代表固定 5 节点）' : ''

  const diagram = [
    topRow,
    row1,
    row2,
    row3,
    row4,
    bottomRow,
  ].join('\n')

  return `${header}\n\n\`\`\`\n${diagram}\n\`\`\`\n${stats.join(' · ')}${footerParts.length ? `\n${footerParts.join(' · ')}` : ''}${sceneNote}`
}

/** 流水线节点链（旧版，保留作为 fallback；同样按 tag 去重，不再重复画框） */
export function renderPipelineNodes(data: unknown): string {
  const obj = data as Record<string, unknown>
  if (!obj || typeof obj !== 'object') return String(data)

  const view = derivePipelineViewFromData(data)
  const sceneName = view.scene || (obj.scene_name as string) || (obj.scene as string) || (obj.scene_id as string) || '-'

  if (view.nodes.length === 0) {
    return `Pipeline: ${sceneName}\n(无节点数据)`
  }

  const lines = view.nodes.map((n) => {
    const icon = statusNumIcon(n.status)
    const tag = n.tag.padEnd(6)
    const status = nodeStatusLabel(n.status).padEnd(10)
    const duration = n.dur != null ? formatDuration(n.dur) : '-'
    const badges = [n.retries > 0 ? `重试 ${n.retries} 次` : '', n.outsideScene ? '场景外' : ''].filter(Boolean)
    const tail = badges.length ? `  ${badges.join(' · ')}` : ''
    return `${tag} ${icon} ${status} ${duration}${tail}`.trimEnd()
  })

  let footer = ''
  if (view.stage) footer += `\n阶段: ${view.stage}`
  footer += `\n整体: ${view.overallDetail}`
  if (view.sceneUnknown) footer += '\n⚠ 场景未知，按事件推断'
  return `Pipeline: ${sceneName}\n${lines.join('\n')}${footer}`
}

/** 仓库级流水线蓝图（不针对单个 issue） */
export function renderPipelineRoadmap(data: unknown): string {
  const obj = data as Record<string, unknown>
  if (!obj || typeof obj !== 'object') return String(data)

  const sceneName = obj.scene_name as string || obj.scene_id as string || '-'
  const nodes = (obj.segments || obj.nodes || obj.pipeline) as GrapePipelineNode[] | undefined

  if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
    const tags = obj.tags as string[] | undefined
    if (tags && tags.length > 0) {
      return `Pipeline roadmap: ${sceneName}\n  ${tags.join(' → ')}`
    }
    return `Pipeline roadmap: ${sceneName}\n(无节点数据)`
  }

  const chain = nodes.map(n => n.tag || n.agent || '?').join(' → ')
  return `Pipeline roadmap: ${sceneName}\n  ${chain}`
}