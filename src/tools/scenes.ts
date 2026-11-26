/**
 * 场景工具（3 个）：
 * list_scenes / apply_scene / list_scenes_for_repo
 */

import type { GrapeCliConfig } from '../types.js'
import { makeToolFromConfig } from './helper.js'

export function createSceneTools(cliConfig: GrapeCliConfig): Record<string, unknown>[] {
  return [

    // 1. grape_list_scenes
    makeToolFromConfig({
      name: 'grape_list_scenes',
      description: '[Grape-unique] List all available pipeline scenes (workflow types) in Grape scene market. ' +
        'Each scene defines a multi-agent pipeline (e.g. default=VOD→Issue→Coding→QA→SRE).',
      parameters: {},
      cliArgs: () => ['scenes', 'market', 'list', '--json-out'],
      renderType: 'sceneTable',
      presentCall: { title: '查询可用流水线场景', kind: 'search' },
    }, cliConfig),

    // 2. grape_apply_scene
    makeToolFromConfig({
      name: 'grape_apply_scene',
      description: '[Grape-unique] Apply (switch) a pipeline scene to a managed repository. ' +
        'Changes which multi-agent pipeline the repo uses.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner' },
        repo: { type: 'string', required: true, description: 'Repository name' },
        scene: { type: 'string', required: true, description: 'Scene ID to apply (e.g. "default", "blog-publish")' },
      },
      cliArgs: (args) => ['scenes', 'apply', '--owner', args.owner as string, '--repo', args.repo as string, '--json', JSON.stringify({ scene_id: args.scene }), '--json-out'],
      renderType: 'action',
      actionName: '场景已切换',
      presentCall: { title: '切换仓库场景 → ${scene}', kind: 'execute' },
    }, cliConfig),

    // 3. grape_list_scenes_for_repo
    makeToolFromConfig({
      name: 'grape_list_scenes_for_repo',
      description: '[Grape-unique] List scenes available for a specific repository (includes pipeline config). ' +
        'Alternative to get_repo_scene (which was removed due to dev_scene retirement).',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner' },
        repo: { type: 'string', required: true, description: 'Repository name' },
      },
      cliArgs: (args) => ['scenes', 'with', 'pipeline', '--repo', `${args.owner}/${args.repo}`, '--json-out'],
      renderType: 'sceneTable',
      presentCall: { title: '查询仓库可用场景 ${owner}/${repo}', kind: 'search' },
    }, cliConfig),

  ]
}
