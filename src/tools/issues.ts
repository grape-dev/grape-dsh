/**
 * Issue 工具（10 个）：
 * list_issues / list_my_issues / get_issue_detail / create_issue /
 * cancel_issue / resume_issue / start_issue / get_issue_events /
 * list_repo_events / search
 */

import type { ToolConfig } from './helper.js'
import type { GrapeCliConfig } from '../types.js'
import { makeToolFromConfig } from './helper.js'
import { pipelineFocus } from '../focus.js'

export function createIssueTools(cliConfig: GrapeCliConfig): Record<string, unknown>[] {
  return [

    // 1. grape_list_issues
    makeToolFromConfig({
      name: 'grape_list_issues',
      description: '[Grape-unique] List issues for a repository with pipeline status. ' +
        'Each issue includes agent_statuses, scene, stage, and is_running.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner' },
        repo: { type: 'string', required: true, description: 'Repository name' },
        status: { type: 'string', description: 'Filter: active/processing/awaiting_input/pending_review/completed' },
      },
      cliArgs: (args) => {
        const a = ['issues', 'list', '--owner', args.owner as string, '--repo', args.repo as string]
        if (args.status) a.push('--status', args.status as string)
        a.push('--json-out')
        return a
      },
      renderType: 'issueTable',
      presentCall: { title: '查询 Issue ${owner}/${repo}', kind: 'search' },
    }, cliConfig),

    // 2. grape_list_my_issues
    makeToolFromConfig({
      name: 'grape_list_my_issues',
      description: '[Grape-unique] List my issues across all repos. No need to specify owner/repo. ' +
        'Supports status filter and repo_key filter.',
      parameters: {
        status: { type: 'string', description: 'Filter: active/processing/awaiting_input/pending_review/completed' },
        repo_key: { type: 'string', description: 'Filter by repo key (e.g. gitcode:owner/repo)' },
      },
      cliArgs: (args) => {
        const a = ['issues', 'mine']
        if (args.status) a.push('--status', args.status as string)
        if (args.repo_key) a.push('--repo_key', args.repo_key as string)
        a.push('--json-out')
        return a
      },
      renderType: 'issueTable',
      presentCall: { title: '查询我的 Issue', kind: 'search' },
    }, cliConfig),

    // 3. grape_get_issue_detail
    makeToolFromConfig({
      name: 'grape_get_issue_detail',
      description: '[Grape-unique] Get issue detail including stage, events, pipeline, and agent statuses.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner' },
        repo: { type: 'string', required: true, description: 'Repository name' },
        number: { type: 'string', required: true, description: 'Issue number' },
      },
      cliArgs: (args) => ['issues', 'detail', '--owner', args.owner as string, '--repo', args.repo as string, '--number', args.number as string, '--json-out'],
      renderType: 'issueDetail',
      presentCall: { title: '查询 Issue 详情 ${owner}/${repo} #${number}', kind: 'read' },
    }, cliConfig),

    // 4. grape_create_issue
    makeToolFromConfig({
      name: 'grape_create_issue',
      description: '[Grape-unique] Create an issue AND automatically trigger the DevOps pipeline in one call. ' +
        'This is the PREFERRED way to create issues — do NOT use GitCode API or bash to create issues manually. ' +
        'Unlike GitCode API which only creates an empty issue, this tool: ' +
        '(1) creates the GitCode issue, (2) triggers the Grape multi-agent pipeline (VOD→Issue→Coding→QA→SRE), ' +
        '(3) returns issue_number + event_seq for pipeline tracking with grape_wait_task. ' +
        'Always use this tool when the user wants to create an issue, start a task, or begin a pipeline.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner' },
        repo: { type: 'string', required: true, description: 'Repository name' },
        title: { type: 'string', required: true, description: 'Issue title' },
        description: { type: 'string', description: 'Issue description / task context' },
        scene_id: { type: 'string', description: 'Scene to use (default: repo recommended scene)' },
        assignee: { type: 'string', description: 'Assignee username' },
        is_subtask_mode: { type: 'boolean', description: 'Create as subtask (default: false)' },
      },
      cliArgs: (args) => {
        const body: Record<string, unknown> = { title: args.title }
        if (args.description) body.description = args.description
        if (args.scene_id) body.scene_id = args.scene_id
        if (args.assignee) body.assignee = args.assignee
        if (args.is_subtask_mode != null) body.is_subtask_mode = args.is_subtask_mode
        return ['issues', 'create', '--owner', args.owner as string, '--repo', args.repo as string, '--json', JSON.stringify(body), '--json-out']
      },
      renderType: 'action',
      actionName: 'Issue 已创建',
      presentCall: { title: '创建 Issue: ${title}', kind: 'execute' },
      // 焦点：创建后侧栏切到该 issue 的流水线
      focus: (args, result) => {
        const r = result as Record<string, unknown> | null
        const n = (r?.issue_number ?? r?.number ?? r?.issue_id) as string | number | undefined
        const owner = (args.owner ?? r?.owner) as string | undefined
        const repo = (args.repo ?? r?.repo) as string | undefined
        if (n === undefined || n === null || !owner || !repo) return null
        return pipelineFocus(cliConfig.baseUrl, owner, repo, n)
      },
    }, cliConfig),

    // 5. grape_cancel_issue
    makeToolFromConfig({
      name: 'grape_cancel_issue',
      description: '[Grape-unique] Cancel an issue — stops the pipeline. ' +
        'Has side effects (stops running pipeline). Use with caution.',
      parameters: {
        issue_id: { type: 'string', required: true, description: 'Issue ID (numeric, not issue_number)' },
      },
      cliArgs: (args) => ['issues', 'cancel', '--issue_id', args.issue_id as string, '--json-out'],
      renderType: 'action',
      actionName: 'Issue 已取消',
      presentCall: { title: '取消 Issue #${issue_id}', kind: 'delete' },
      // 焦点：结果里若带 owner/repo/number 则切到该 issue
      focus: (_args, result) => {
        const r = result as Record<string, unknown> | null
        const owner = r?.owner as string | undefined
        const repo = r?.repo as string | undefined
        const n = (r?.issue_number ?? r?.number) as string | number | undefined
        if (!owner || !repo || n === undefined || n === null) return null
        return pipelineFocus(cliConfig.baseUrl, owner, repo, n)
      },
    }, cliConfig),

    // 6. grape_resume_issue
    makeToolFromConfig({
      name: 'grape_resume_issue',
      description: '[Grape-unique] Resume a cancelled issue. Restarts the pipeline from where it stopped.',
      parameters: {
        issue_id: { type: 'string', required: true, description: 'Issue ID (numeric)' },
      },
      cliArgs: (args) => ['issues', 'resume', '--issue_id', args.issue_id as string, '--json-out'],
      renderType: 'action',
      actionName: 'Issue 已恢复',
      presentCall: { title: '恢复 Issue #${issue_id}', kind: 'execute' },
    }, cliConfig),

    // 7. grape_start_issue
    makeToolFromConfig({
      name: 'grape_start_issue',
      description: '[Grape-unique] Start/open an issue session. Advances the pipeline.',
      parameters: {
        issue_id: { type: 'string', required: true, description: 'Issue ID (numeric)' },
      },
      cliArgs: (args) => ['issues', 'start', '--issue_id', args.issue_id as string, '--json-out'],
      renderType: 'action',
      actionName: 'Issue 已启动',
      presentCall: { title: '启动 Issue #${issue_id}', kind: 'execute' },
    }, cliConfig),

    // 8. grape_get_issue_events
    makeToolFromConfig({
      name: 'grape_get_issue_events',
      description: '[Grape-unique] Get event history for an issue — agent executions, A2A handoffs, status changes. ' +
        'Grape\'s internal execution log, not available from GitCode.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner' },
        repo: { type: 'string', required: true, description: 'Repository name' },
        number: { type: 'string', required: true, description: 'Issue number' },
      },
      cliArgs: (args) => ['issues', 'events', '--owner', args.owner as string, '--repo', args.repo as string, '--number', args.number as string, '--json-out'],
      renderType: 'eventTimeline',
      presentCall: { title: '查询事件历史 ${owner}/${repo} #${number}', kind: 'read' },
    }, cliConfig),

    // 9. grape_list_repo_events
    makeToolFromConfig({
      name: 'grape_list_repo_events',
      description: '[Grape-unique] List events for a repository (cross-issue). Shows recent agent executions.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner' },
        repo: { type: 'string', required: true, description: 'Repository name' },
      },
      cliArgs: (args) => ['events', 'list', '--owner', args.owner as string, '--repo', args.repo as string, '--json-out'],
      renderType: 'eventTimeline',
      presentCall: { title: '查询仓库事件 ${owner}/${repo}', kind: 'read' },
    }, cliConfig),

    // 10. grape_search
    makeToolFromConfig({
      name: 'grape_search',
      description: '[Grape-unique] Global search across issues, repos, and skills.',
      parameters: {
        q: { type: 'string', required: true, description: 'Search query' },
      },
      cliArgs: (args) => ['search', 'global', '--q', args.q as string, '--json-out'],
      renderType: 'searchResults',
      presentCall: { title: '搜索: ${q}', kind: 'search' },
    }, cliConfig),

  ]
}
