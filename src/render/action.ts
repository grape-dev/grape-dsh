/**
 * 动作类渲染函数。
 * 用于 trigger/create/cancel/resume/start/host/sync/apply/terminate 等工具。
 */

import { normalizeIssueNumber } from '../issue-number.js'
import { extractStr, extractNum } from './helpers.js'

/** 一行动作确认 */
export function renderActionConfirm(data: unknown, action: string): string {
  const obj = data as Record<string, unknown>
  if (!obj || typeof obj !== 'object') {
    return `✅ ${action} 完成`
  }

  const status = extractStr(obj, 'status')
  const ok = status === 'ok' || extractStr(obj, 'ok') === 'true'
  const icon = ok ? '✅' : '⚠️'

  // 尝试提取常见字段
  const seq = extractNum(obj, 'seq')
  const agent = extractStr(obj, 'agent')
  // 编号按字符串取（Gitee 字母数字 `IKXR3B` 经 parseInt 会变成 0，Issue #39）；
  // 归一仍走共享口径：`"0"` 占位/空/非法一律不展示，绝不伪造 `#0`。
  const number = normalizeIssueNumber(extractStr(obj, 'number')) || normalizeIssueNumber(extractStr(obj, 'issue_number'))
  const message = extractStr(obj, 'message')

  const parts: string[] = [icon, action]
  if (number) parts.push(`#${number}`)
  if (seq) parts.push(`seq=${seq}`)
  if (agent) parts.push(`agent=${agent}`)
  if (message) parts.push(`| ${message}`)

  return parts.join(' ')
}
