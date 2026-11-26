/**
 * 事件工具（2 个）：
 * terminate_event
 * (get_issue_events 和 list_repo_events 已在 issues.ts 中)
 *
 * 注：search 也在 issues.ts（因为 issues.py 的 unified entry）
 * events.ts 只放纯事件操作工具
 */

import type { GrapeCliConfig } from '../types.js'
import { makeToolFromConfig } from './helper.js'

export function createEventTools(cliConfig: GrapeCliConfig): Record<string, unknown>[] {
  return [

    // 1. grape_terminate_event
    makeToolFromConfig({
      name: 'grape_terminate_event',
      description: '[Grape-unique] Force-terminate a single event by seq. ' +
        'More granular than cancel_issue (stops one agent execution, not the whole issue). ' +
        'Has side effects (kills running agent). Use with caution.',
      parameters: {
        seq: { type: 'number', required: true, description: 'Event sequence number to terminate' },
      },
      cliArgs: (args) => ['events', 'terminate', '--seq', String(args.seq), '--json-out'],
      renderType: 'action',
      actionName: '事件已终止',
      presentCall: { title: '终止事件 seq=${seq}', kind: 'delete' },
    }, cliConfig),

  ]
}
