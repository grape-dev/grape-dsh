/**
 * 渲染辅助函数。
 */

import type { GrapePipelineNode } from '../types.js'

/** 状态 → emoji 图标 */
export function statusIcon(status: string | undefined): string {
  if (!status) return '❓'
  const map: Record<string, string> = {
    completed: '✅',
    failed: '❌',
    cancelled: '🚫',
    running: '🔄',
    pending: '⬜',
    processing: '🔄',
    pending_review: '🔍',
    active: '🔄',
    awaiting_input: '⏳',
    open: '📂',
    closed: '🔒',
    all: '📋',
  }
  return map[status] || '❓'
}

/** 截断文本到指定长度 */
export function truncate(text: string | undefined, max: number = 80): string {
  if (!text) return ''
  return text.length > max ? text.slice(0, max - 3) + '...' : text
}

/** 格式化持续时间（秒 → 可读字符串） */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '-'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m${s}s`
}

/** 从 agent_statuses 构建紧凑进度串 */
export function agentProgressCompact(nodes: GrapePipelineNode[] | undefined): string {
  if (!nodes || nodes.length === 0) return '-'
  return nodes.map(n => {
    const icon = statusIcon(n.status)
    const tag = n.tag || n.agent || '?'
    return `${tag}${icon}`
  }).join(' ')
}

/** 从 agent_statuses 构建多行进度列表 */
export function agentProgressList(nodes: GrapePipelineNode[] | undefined): string {
  if (!nodes || nodes.length === 0) return '(无 agent 状态)'
  const lines = nodes.map(n => {
    const icon = statusIcon(n.status)
    const label = n.label || n.tag || n.agent || '?'
    const status = n.status || 'unknown'
    const summary = n.latest_title ? ` — ${truncate(n.latest_title, 60)}` : ''
    return `- ${label} ${icon} ${status}${summary}`
  })
  return lines.join('\n')
}

/** 构建一个 ContentBlock text */
export function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

/** 从未知值中安全提取数组 */
export function extractArray(data: unknown, key: string): unknown[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object' && key in data) {
    const v = (data as Record<string, unknown>)[key]
    if (Array.isArray(v)) return v
  }
  return []
}

/** 从未知值中安全提取数字 */
export function extractNum(data: unknown, key: string): number {
  if (data && typeof data === 'object' && key in data) {
    const v = (data as Record<string, unknown>)[key]
    if (typeof v === 'number') return v
    if (typeof v === 'string') return parseInt(v, 10) || 0
  }
  return 0
}

/** 从未知值中安全提取字符串 */
export function extractStr(data: unknown, key: string): string {
  if (data && typeof data === 'object' && key in data) {
    const v = (data as Record<string, unknown>)[key]
    if (typeof v === 'string') return v
    if (typeof v === 'number') return String(v)
    if (v === null) return ''
  }
  return ''
}
