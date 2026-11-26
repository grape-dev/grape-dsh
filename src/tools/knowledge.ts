/**
 * Knowledge 工具（2 个）：
 * list_knowledge / get_knowledge_detail
 */

import type { GrapeCliConfig } from '../types.js'
import { makeToolFromConfig } from './helper.js'

export function createKnowledgeTools(cliConfig: GrapeCliConfig): Record<string, unknown>[] {
  return [

    // 1. grape_list_knowledge
    makeToolFromConfig({
      name: 'grape_list_knowledge',
      description: '[Grape-unique] List project knowledge entries. ' +
        'Knowledge entries are reusable context documents used by pipeline agents.',
      parameters: {
        repo_key: { type: 'string', required: true, description: 'Repo key (e.g. gitcode:owner/repo or owner/repo)' },
        page: { type: 'number', description: 'Page number (default 1)' },
        page_size: { type: 'number', description: 'Page size (default 20)' },
      },
      cliArgs: (args) => {
        const a = ['knowledge', 'list', '--repo', args.repo_key as string]
        if (args.page) a.push('--page', String(args.page))
        if (args.page_size) a.push('--page_size', String(args.page_size))
        a.push('--json-out')
        return a
      },
      renderType: 'knowledgeTable',
      presentCall: { title: '查询知识库', kind: 'search' },
    }, cliConfig),

    // 2. grape_get_knowledge_detail
    makeToolFromConfig({
      name: 'grape_get_knowledge_detail',
      description: '[Grape-unique] Get knowledge entry detail including full content.',
      parameters: {
        knowledge_id: { type: 'string', required: true, description: 'Knowledge entry ID' },
      },
      cliArgs: (args) => ['knowledge', 'detail', '--knowledge_id', args.knowledge_id as string, '--json-out'],
      renderType: 'dashboard',
      presentCall: { title: '查询知识详情: ${knowledge_id}', kind: 'read' },
    }, cliConfig),

  ]
}
