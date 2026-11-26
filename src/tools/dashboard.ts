/**
 * Dashboard 工具（2 个）：
 * get_repo_dashboard / get_ops_overview
 */

import type { GrapeCliConfig } from '../types.js'
import { makeToolFromConfig } from './helper.js'
import { overviewFocus, opsFocus, extractRepoSummary } from '../focus.js'

export function createDashboardTools(cliConfig: GrapeCliConfig): Record<string, unknown>[] {
  return [

    // 1. grape_get_repo_dashboard
    makeToolFromConfig({
      name: 'grape_get_repo_dashboard',
      description: '[Grape-unique] Get repository dashboard — issue statistics, agent status, pipeline summary.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner' },
        repo: { type: 'string', required: true, description: 'Repository name' },
      },
      cliArgs: (args) => ['dashboard', 'repo', '--owner', args.owner as string, '--repo', args.repo as string, '--json-out'],
      renderType: 'dashboard',
      presentCall: { title: '查询仓库 Dashboard ${owner}/${repo}', kind: 'read' },
      // 焦点：侧栏切到该仓库概览
      focus: (args, result) => {
        const owner = args.owner as string | undefined
        const repo = args.repo as string | undefined
        if (!owner || !repo) return null
        return { ...overviewFocus(cliConfig.baseUrl, owner, repo), ...extractRepoSummary(result) }
      },
    }, cliConfig),

    // 2. grape_get_ops_overview
    makeToolFromConfig({
      name: 'grape_get_ops_overview',
      description: '[Grape-unique] Get global ops overview — all repos, running issues, online agents, machine health.',
      parameters: {},
      cliArgs: () => ['dashboard', 'ops', 'overview', '--json-out'],
      renderType: 'dashboard',
      presentCall: { title: '查询运维概览', kind: 'read' },
      // 焦点：侧栏切到运维概览
      focus: () => opsFocus(cliConfig.baseUrl),
    }, cliConfig),

  ]
}
