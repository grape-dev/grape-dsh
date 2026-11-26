/**
 * 流水线工具（5 个）：
 * trigger_pipeline / get_task_status / wait_task / get_pipeline_info / get_pipeline_roadmap
 *
 * 注：get_issue_status 已下线。它曾映射到 GET /api/issues/{issue_id}/status，
 * 但 grape CLI 0.3.3 的 `issues status` 已改为 PUT 更新状态，该 GET 在 CLI 层不可达
 * （见 grape-cli-command-inventory.md）。只读需求请用 get_issue_detail / list_issues。
 */

import type { ToolConfig } from './helper.js'
import type { GrapeCliConfig } from '../types.js'
import { makeToolFromConfig } from './helper.js'
import { execGrape } from '../cli-client.js'
import { pipelineFocus, eventFocus, extractPipelineSummary } from '../focus.js'
import { projectSceneNodes } from '../pipeline-model.js'

export function createPipelineTools(cliConfig: GrapeCliConfig): Record<string, unknown>[] {
  return [

    // 1. grape_trigger_pipeline
    makeToolFromConfig({
      name: 'grape_trigger_pipeline',
      description: '[Grape-unique] Trigger a Grape DevOps pipeline by creating an A2A handoff ' +
        'to the first pipeline node (usually VOD). Returns an event_seq for tracking. ' +
        'Pipeline node-to-node handoff is managed internally by Grape.',
      parameters: {
        repository: { type: 'string', required: true, description: 'Repository in owner/repo format' },
        issue_number: { type: 'string', required: true, description: 'Issue number (GitCode numeric, Gitee alphanumeric)' },
        account: { type: 'string', required: true, description: 'Account identity (usually same as owner/repo)' },
        context: { type: 'string', required: true, description: 'Task description for the VOD agent' },
        agent: { type: 'string', description: 'Target agent name (default: vod)' },
      },
      cliArgs: (args) => {
        const body = JSON.stringify({
          agent: (args.agent as string) || 'vod',
          payload: {
            repository: args.repository,
            account: args.account,
            issue_number: args.issue_number,
            context: args.context,
          },
        })
        return ['a2a', 'handoff', '--json', body, '--json-out']
      },
      renderType: 'action',
      actionName: '流水线已触发',
      presentCall: { title: '触发流水线: ${repository} #${issue_number}', kind: 'execute' },
    }, cliConfig),

    // 2. grape_get_task_status
    makeToolFromConfig({
      name: 'grape_get_task_status',
      description: '[Grape-unique] Get the current status of a pipeline task by event sequence number. ' +
        'Returns status, agent name, summary, and duration.',
      parameters: {
        event_seq: { type: 'number', required: true, description: 'Event sequence number (from trigger_pipeline)' },
      },
      cliArgs: (args) => ['events', 'detail', '--seq', String(args.event_seq), '--json-out'],
      renderType: 'taskStatus',
      presentCall: { title: '查询任务状态 seq=${event_seq}', kind: 'read' },
      // 焦点：侧栏切到该事件详情
      focus: (args, result) => {
        const seq = Number(args.event_seq)
        if (!Number.isFinite(seq)) return null
        return { ...eventFocus(cliConfig.baseUrl, seq), ...extractPipelineSummary(result) }
      },
    }, cliConfig),

    // 3. grape_wait_task
    makeToolFromConfig({
      name: 'grape_wait_task',
      description: '[Grape-unique] Poll a pipeline task for a short period (default 30s) and return the current ' +
        'status with a full pipeline snapshot showing all agent nodes. ' +
        'If the task is still running, the result includes _still_running=true and _suggestion to call again. ' +
        'IMPORTANT: Use short timeouts (30s) and call repeatedly to show the user live pipeline progress. ' +
        'Each call returns a pipeline flow diagram with all node statuses (completed/running/pending). ' +
        'Pass owner/repo/number to get the full pipeline snapshot; without them only single event status is returned.',
      parameters: {
        event_seq: { type: 'number', required: true, description: 'Event sequence number' },
        timeout: { type: 'number', description: 'Max wait seconds (default 30, keep short for live updates)' },
        interval: { type: 'number', description: 'Poll interval seconds (default 3)' },
        owner: { type: 'string', description: 'Repository owner (required for pipeline snapshot)' },
        repo: { type: 'string', description: 'Repository name (required for pipeline snapshot)' },
        number: { type: 'string', description: 'Issue number (required for pipeline snapshot)' },
      },
      cliArgs: () => ['events', 'detail', '--json-out'],
      isPoll: { seqArg: 'event_seq', timeoutArg: 'timeout', intervalArg: 'interval' },
      renderType: 'pipelineCard',
      presentCall: { title: '轮询任务 seq=${event_seq}（${timeout}s）', kind: 'execute' },
      // 焦点：轮询期间侧栏持续显示该 issue 的实时流水线
      focus: (args, result) => {
        const owner = args.owner as string | undefined
        const repo = args.repo as string | undefined
        const number = args.number as string | undefined
        if (!owner || !repo || !number) return null
        return { ...pipelineFocus(cliConfig.baseUrl, owner, repo, number), ...extractPipelineSummary(result) }
      },
    }, cliConfig),

    // 4. grape_get_pipeline_info
    makeToolFromConfig({
      name: 'grape_get_pipeline_info',
      description: '[Grape-unique] Get pipeline configuration and current node status for an issue. ' +
        'Returns scene name and each node\'s status.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner' },
        repo: { type: 'string', required: true, description: 'Repository name' },
        number: { type: 'string', required: true, description: 'Issue number' },
      },
      cliArgs: (args) => ['issues', 'pipeline', '--owner', args.owner as string, '--repo', args.repo as string, '--number', args.number as string, '--json-out'],
      renderType: 'pipelineCard',
      presentCall: { title: '查询流水线进度 ${owner}/${repo} #${number}', kind: 'read' },
      // 文本渲染按场景节点画骨架：补 scene_id / scene_nodes（失败静默 → 渲染退化并标注「场景未知」）
      enrich: async (args, result) => {
        const r = result as Record<string, unknown>
        const owner = String(args.owner || '')
        const repo = String(args.repo || '')
        const number = String(args.number || '')
        if (!owner || !repo || !number) return result
        let sceneId = typeof r.scene_id === 'string' ? r.scene_id : ''
        if (!sceneId) {
          const detail = await execGrape(cliConfig,
            ['issues', 'detail', '--owner', owner, '--repo', repo, '--number', number, '--json-out'])
            .catch(() => null) as Record<string, unknown> | null
          sceneId = typeof detail?.scene_id === 'string' ? detail.scene_id : ''
          // Issue #26 C1：走 repo 默认场景的 issue，issues detail 返回 scene_id=""（且无 scene_source），
          // 场景库里默认场景 id 是 'default'；不回退会永远按「场景未知」渲染
          if (!sceneId) sceneId = 'default'
        }
        if (!sceneId) return result
        const scene = await execGrape(cliConfig,
          ['scenes', 'detail', '--scene_id', sceneId, '--repo', `${owner}/${repo}`, '--json-out'])
          .catch(() => null) as Record<string, unknown> | null
        // Issue #26 R2：明确标记「试过且失败」，客户端据此显示「场景未知」
        if (!scene) return { ...r, scene_id: sceneId, scene_unknown: true }
        const nodes = projectSceneNodes(scene)
        return {
          ...r,
          scene_id: sceneId,
          scene_name: String(scene.display_name || scene.name || r.scene_name || ''),
          scene_nodes: nodes,
          node_count: nodes.length,
        }
      },
      // 焦点：侧栏切到该 issue 的流水线
      focus: (args, result) => {
        const owner = args.owner as string | undefined
        const repo = args.repo as string | undefined
        const number = args.number as string | undefined
        if (!owner || !repo || !number) return null
        return { ...pipelineFocus(cliConfig.baseUrl, owner, repo, number), ...extractPipelineSummary(result) }
      },
    }, cliConfig),

    // 5. grape_get_pipeline_roadmap
    makeToolFromConfig({
      name: 'grape_get_pipeline_roadmap',
      description: '[Grape-unique] Get the repository-level pipeline roadmap (not issue-specific). ' +
        'Shows the scene\'s node chain.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner' },
        repo: { type: 'string', required: true, description: 'Repository name' },
      },
      cliArgs: (args) => ['pipeline', 'get', '--owner', args.owner as string, '--repo', args.repo as string, '--json-out'],
      renderType: 'pipelineRoadmap',
      presentCall: { title: '查询仓库流水线蓝图 ${owner}/${repo}', kind: 'read' },
    }, cliConfig),

  ]
}
