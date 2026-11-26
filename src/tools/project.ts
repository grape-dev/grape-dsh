/**
 * 项目模板工具（2 个）：
 * list_project_templates / create_project
 */

import type { GrapeCliConfig } from '../types.js'
import { makeToolFromConfig } from './helper.js'

export function createProjectTools(cliConfig: GrapeCliConfig): Record<string, unknown>[] {
  return [

    // 1. grape_list_project_templates
    makeToolFromConfig({
      name: 'grape_list_project_templates',
      description: '[Grape-unique] List available project templates. ' +
        'Templates are starter projects that can be created with one call.',
      parameters: {},
      cliArgs: () => ['project', 'templates', 'list', '--json-out'],
      renderType: 'templateTable',
      presentCall: { title: '查询项目模板', kind: 'search' },
    }, cliConfig),

    // 2. grape_create_project
    makeToolFromConfig({
      name: 'grape_create_project',
      description: '[Grape-unique] Create a new project from a template in your own account. ' +
        'Creates a GitCode repo + triggers initial pipeline. Has side effects.',
      parameters: {
        template_id: { type: 'string', required: true, description: 'Template ID' },
        repo_name: { type: 'string', required: true, description: 'New repo name' },
      },
      cliArgs: (args) => {
        // API 契约（POST /api/project-templates/create）只接受 template_id + repo_name，
        // 没有 owner 字段：项目固定建在当前账号的命名空间下。
        const body = JSON.stringify({
          template_id: args.template_id,
          repo_name: args.repo_name,
        })
        return ['project', 'template', 'create', '--json', body, '--json-out']
      },
      renderType: 'action',
      actionName: '项目已创建',
      presentCall: { title: '从模板创建项目: ${template_id}', kind: 'execute' },
    }, cliConfig),

  ]
}
