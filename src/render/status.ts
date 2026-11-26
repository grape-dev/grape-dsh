/**
 * 状态类渲染函数。
 * 用于 task status / issue status / wait_task 工具。
 */

import type { GrapeEvent } from '../types.js'
import { statusIcon, truncate, formatDuration, extractStr } from './helpers.js'

/** 任务状态摘要 */
export function renderTaskStatus(data: unknown): string {
  const event = data as GrapeEvent
  if (!event || typeof event !== 'object') return String(data)

  const icon = statusIcon(event.status)
  const status = event.status || 'unknown'
  const agent = event.agent_type || '-'
  const seq = event.seq
  const duration = event.duration != null ? formatDuration(event.duration) : '-'
  const summary = truncate(event.summary || event.title, 100)

  let result = `${icon} ${status} | agent=${agent} | seq=${seq} | ${duration}`
  if (summary) result += `\n${summary}`
  return result
}

/** Dashboard 摘要 */
export function renderDashboard(data: unknown): string {
  const obj = data as Record<string, unknown>
  if (!obj || typeof obj !== 'object') return String(data)

  const lines: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'number' || typeof value === 'string') {
      lines.push(`  ${key}: ${value}`)
    } else if (Array.isArray(value)) {
      lines.push(`  ${key}: ${value.length} 项`)
    }
  }
  if (lines.length === 0) return '(无数据)'
  return lines.join('\n')
}

/** Issue 状态摘要（轻量） */
export function renderIssueStatus(data: unknown): string {
  const obj = data as Record<string, unknown>
  if (!obj || typeof obj !== 'object') return String(data)

  const status = extractStr(obj, 'status') || extractStr(obj, 'task_status') || '-'
  const stage = extractStr(obj, 'stage') || '-'
  const num = extractStr(obj, 'number') || extractStr(obj, 'issue_number') || '?'

  return `${statusIcon(status)} ${status} | 阶段: ${stage} | #${num}`
}
