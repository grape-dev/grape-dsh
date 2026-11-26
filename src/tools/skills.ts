/**
 * Skill 工具（3 个）：
 * list_skills / get_skill_detail / search_skills
 */

import type { GrapeCliConfig } from '../types.js'
import { makeToolFromConfig } from './helper.js'

export function createSkillTools(cliConfig: GrapeCliConfig): Record<string, unknown>[] {
  return [

    // 1. grape_list_skills
    makeToolFromConfig({
      name: 'grape_list_skills',
      description: '[Grape-unique] List all skills available in Grape. ' +
        'Skills are reusable agent capabilities used by pipeline nodes.',
      parameters: {},
      cliArgs: () => ['skills', 'list', '--json-out'],
      renderType: 'skillTable',
      presentCall: { title: '查询 Skill 列表', kind: 'search' },
    }, cliConfig),

    // 2. grape_get_skill_detail
    makeToolFromConfig({
      name: 'grape_get_skill_detail',
      description: '[Grape-unique] Get skill detail including SKILL.md content. ' +
        'Returns the skill\'s full instructions and configuration.',
      parameters: {
        skill_id: { type: 'string', required: true, description: 'Skill ID' },
      },
      cliArgs: (args) => ['skills', 'detail', '--skill_id', args.skill_id as string, '--json-out'],
      renderType: 'dashboard',
      presentCall: { title: '查询 Skill 详情: ${skill_id}', kind: 'read' },
    }, cliConfig),

    // 3. grape_search_skills
    makeToolFromConfig({
      name: 'grape_search_skills',
      description: '[Grape-unique] Search skills by keyword. ' +
        'Returns matching skills with name, category, and agent type.',
      parameters: {
        q: { type: 'string', required: true, description: 'Search query' },
      },
      cliArgs: (args) => ['skills', 'search', '--q', args.q as string, '--json-out'],
      renderType: 'skillTable',
      presentCall: { title: '搜索 Skill: ${q}', kind: 'search' },
    }, cliConfig),

  ]
}
