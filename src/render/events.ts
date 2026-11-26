/**
 * 事件类渲染函数。
 * 用于 events 工具的 render 和 presentResult。
 */

import type { GrapeEvent } from '../types.js'
import { statusIcon, truncate, formatDuration, extractArray } from './helpers.js'

/** 事件时间线 */
export function renderEventTimeline(data: unknown): string {
  const events = extractArray(data, 'events') as GrapeEvent[]
  if (events.length === 0) return '没有找到事件'

  const lines = events.map(e => {
    const icon = statusIcon(e.status)
    const seq = e.seq
    const agent = e.agent_type || '?'
    const status = e.status || 'unknown'
    const duration = e.duration != null ? formatDuration(e.duration) : '-'
    const summary = truncate(e.summary || e.title, 70)
    return `seq=${seq} ${icon} ${agent} ${status} ${duration}  ${summary}`
  })

  return `共 ${events.length} 条事件:\n${lines.join('\n')}`
}
