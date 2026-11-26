/**
 * 仓库工具（5 个）：
 * list_managed_repos / list_repos_member / get_repo_project_info / host_repo / sync_repos
 */

import type { GrapeCliConfig } from '../types.js'
import { makeToolFromConfig } from './helper.js'

export function createRepoTools(cliConfig: GrapeCliConfig): Record<string, unknown>[] {
  return [

    // 1. grape_list_managed_repos
    makeToolFromConfig({
      name: 'grape_list_managed_repos',
      description: '[Grape-unique] List all repositories managed by Grape. ' +
        'Use this to discover which repos are available for pipeline triggers.',
      parameters: {},
      cliArgs: () => ['repos', 'managed', '--json-out'],
      renderType: 'repoTable',
      presentCall: { title: '查询纳管仓库', kind: 'search' },
    }, cliConfig),

    // 2. grape_list_repos_member
    makeToolFromConfig({
      name: 'grape_list_repos_member',
      description: '[Grape-unique] List repositories I can operate on. ' +
        'Similar to list_managed_repos but filtered by current user permissions.',
      parameters: {},
      cliArgs: () => ['repos', 'member', '--json-out'],
      renderType: 'repoTable',
      presentCall: { title: '查询我可操作的仓库', kind: 'search' },
    }, cliConfig),

    // 3. grape_get_repo_project_info
    makeToolFromConfig({
      name: 'grape_get_repo_project_info',
      description: '[Grape-unique] Get project info for a repository — knowledge, scene, and project metadata.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner' },
        repo: { type: 'string', required: true, description: 'Repository name' },
      },
      cliArgs: (args) => ['repos', 'project', 'info', '--owner', args.owner as string, '--repo', args.repo as string, '--json-out'],
      renderType: 'dashboard',
      presentCall: { title: '查询项目信息 ${owner}/${repo}', kind: 'read' },
    }, cliConfig),

    // 4. grape_host_repo
    makeToolFromConfig({
      name: 'grape_host_repo',
      description: '[Grape-unique] Host (onboard) a new repository into Grape. ' +
        'Has side effects (adds repo to Grape management). ' +
        'Requires GitCode OAuth to be configured.',
      parameters: {
        repo_key: { type: 'string', required: true, description: 'Repository identity — "owner/repo" or "gitcode:owner/repo"' },
      },
      cliArgs: (args) => {
        // API 契约（POST /api/repos/host）只接受 full_name=owner/repo；
        // 这里兼容调用方直接给 repo_key 形式（gitcode:owner/repo），自动去掉平台前缀。
        const raw = String(args.repo_key)
        const fullName = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw
        return ['repos', 'host', '--json', JSON.stringify({ full_name: fullName }), '--json-out']
      },
      renderType: 'action',
      actionName: '仓库已纳管',
      presentCall: { title: '纳管仓库 ${repo_key}', kind: 'execute' },
    }, cliConfig),

    // 5. grape_sync_repos
    makeToolFromConfig({
      name: 'grape_sync_repos',
      description: '[Grape-unique] Sync repository list from VCS (GitCode). ' +
        'Pulls latest repo list and updates Grape\'s managed repos.',
      parameters: {},
      cliArgs: () => ['repos', 'sync', '--json-out'],
      renderType: 'action',
      actionName: '仓库列表已同步',
      presentCall: { title: '同步仓库列表', kind: 'execute' },
    }, cliConfig),

  ]
}
