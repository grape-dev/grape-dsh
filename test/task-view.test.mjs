/**
 * 需求卡只读视图的投影单测（Issue #42 P1/P5）。
 *
 * 测试 seam：`findMineIssue` / `projectTaskView` / `projectScenesView` /
 * `projectHandoffTargets` —— 全部是纯函数（不依赖 DOM / CLI），宿主路由只做接线。
 * 数据形态取自实测：`issues mine`（id / repo_key / issue_number / task_description …）、
 * `issues detail`（issue_id / scene_id / events[]）、`events detail`（payload.object_attributes）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  findMineIssue,
  projectHandoffTargets,
  projectScenesView,
  projectTaskView,
} from '../lib/task-view.js'

/** 实测 #42 的 `issues mine` 行（截取投影用到的字段） */
const MINE_42 = {
  id: 20864,
  repo_key: 'gitcode:grape-dev/grape-dsh',
  issue_number: 42,
  title: '[新增] 需求卡片 4 个操作按钮',
  status: 'processing',
  stage: 'coding',
  scene_id: 'custom-5f5c87a1',
  task_description: '',
  conversation_id: '41fb4d5e-3e85-4996-988b-0a8429180683',
  is_running: true,
}

const MINE_LIST = {
  issues: [
    { ...MINE_42, id: 20792, issue_number: 41, status: 'completed', is_running: false },
    MINE_42,
  ],
  total: 2,
}

const DETAIL_42 = {
  number: 42,
  issue_id: 20864,
  title: MINE_42.title,
  stage: 'coding',
  task_status: 'processing',
  scene_id: 'custom-5f5c87a1',
  events: [
    { seq: 108746, event_type: 'issue_opened' },
    { seq: 108754, event_type: 'a2a_event' },
  ],
}

const OPENED_EVENT = {
  seq: 108746,
  event_type: 'issue_opened',
  payload: { object_attributes: { iid: 42, description: '## 背景\n\n需求原文' } },
}

test('findMineIssue：按 repo_key + 编号命中，跨仓库/跨编号不命中', () => {
  const hit = findMineIssue(MINE_LIST, { repoKey: 'gitcode:grape-dev/grape-dsh', number: '42' })
  assert.equal(hit?.id, 20864, '整数编号应命中同一条')
  assert.equal(findMineIssue(MINE_LIST, { repoKey: 'gitcode:grape-dev/grape-dsh', number: 42 })?.id, 20864, '数字编号也命中')

  assert.equal(findMineIssue(MINE_LIST, { repoKey: 'gitcode:grape-dev/grape-dsh', number: '43' }), null)
  assert.equal(findMineIssue(MINE_LIST, { repoKey: 'gitcode:other/repo', number: '42' }), null, 'repo_key 不同不得命中')
  assert.equal(findMineIssue(null, { repoKey: 'gitcode:grape-dev/grape-dsh', number: '42' }), null)
})

test('projectTaskView：字段齐全（id / issue_number / repo_key / status / scene_id / description / conversation_id）', () => {
  const row = findMineIssue(MINE_LIST, { repoKey: 'gitcode:grape-dev/grape-dsh', number: '42' })
  const view = projectTaskView({ row, detail: DETAIL_42, firstEvent: OPENED_EVENT, repoKey: 'gitcode:grape-dev/grape-dsh' })
  assert.equal(view.id, 20864)
  assert.equal(view.issue_number, '42')
  assert.equal(view.repo_key, 'gitcode:grape-dev/grape-dsh')
  assert.equal(view.status, 'processing')
  assert.equal(view.scene_id, 'custom-5f5c87a1')
  assert.equal(view.conversation_id, '41fb4d5e-3e85-4996-988b-0a8429180683')
  assert.equal(view.is_running, true)
  assert.equal(view.title, MINE_42.title)
  assert.equal(view.stage, 'coding')
  assert.equal(view.task_description, '## 背景\n\n需求原文', 'issues mine 描述为空时回退首个 issue_opened 事件')
})

test('projectTaskView：GitCode 整数编号归一为字符串，Gitee 字母数字编号原样保留', () => {
  const gitcode = projectTaskView({ row: { ...MINE_42, issue_number: 42 }, repoKey: 'gitcode:o/r' })
  assert.equal(gitcode.issue_number, '42')

  const gitee = projectTaskView({
    row: { ...MINE_42, issue_number: 'IKXR3B', repo_key: 'gitee:o/r' },
    repoKey: 'gitee:o/r',
  })
  assert.equal(gitee.issue_number, 'IKXR3B', 'Gitee 编号大小写敏感，不得转数字')
  assert.equal(gitee.repo_key, 'gitee:o/r')
})

test('projectTaskView：描述三级回退（mine → 首个 issue_opened → 空串）', () => {
  const withMine = projectTaskView({ row: { ...MINE_42, task_description: '  来自 mine  ' }, firstEvent: OPENED_EVENT })
  assert.equal(withMine.task_description, '来自 mine', '第一级优先且 trim')

  const fromEvent = projectTaskView({ row: MINE_42, firstEvent: OPENED_EVENT })
  assert.equal(fromEvent.task_description, '## 背景\n\n需求原文')

  const empty = projectTaskView({ row: MINE_42, firstEvent: { payload: { object_attributes: {} } } })
  assert.equal(empty.task_description, '', '都没有时给空串（前端只展示标题 + 链接）')
})

test('projectTaskView：id 取不到或非法归 0（绝不用 issue number 兜底）', () => {
  assert.equal(projectTaskView({ row: { ...MINE_42, id: 0 }, detail: { issue_id: 20864 } }).id, 20864, 'mine 无 id 时用 detail.issue_id')
  assert.equal(projectTaskView({ row: { ...MINE_42, id: '#42' }, detail: { issue_id: '' } }).id, 0, '非法 id 归 0')
  assert.equal(projectTaskView({ row: null, detail: null }).id, 0)
  assert.equal(projectTaskView({ row: null, detail: null, repoKey: 'gitcode:o/r' }).issue_number, '', '没有编号就空串')
})

test('projectScenesView：只透出 id / display_name / work_branch / pipeline.nodes 白名单字段', () => {
  const raw = {
    scenes: [
      {
        id: 'custom-5f5c87a1',
        display_name: '常辉的开发流水线',
        name: 'fallback-name',
        work_branch: 'dev-ch-11',
        created_by: 'developer_ch',
        agents: [{ id: 'a1' }],
        engine_runtime_ids: ['r1'],
        nodes: [
          { id: 'n1', tag: 'vod', skill: 'vod-cli', next: 'issue', enabled: true, runtime: 'x' },
          { id: 'n2', tag: 'issue', next: 'done', enabled: false },
        ],
      },
      { id: '', display_name: '无 id 丢弃' },
    ],
  }
  const out = projectScenesView(raw)
  assert.equal(out.length, 1, '无 id 的项丢弃')
  const s = out[0]
  assert.deepEqual(Object.keys(s).sort(), ['display_name', 'id', 'pipeline', 'work_branch'])
  assert.equal(s.id, 'custom-5f5c87a1')
  assert.equal(s.display_name, '常辉的开发流水线')
  assert.equal(s.work_branch, 'dev-ch-11')
  assert.deepEqual(s.pipeline.nodes.map((n) => n.tag), ['vod', 'issue'])
  assert.equal(s.pipeline.nodes[0].next, 'issue')
  assert.equal(s.pipeline.nodes[1].enabled, false)
  assert.equal(s.pipeline.nodes[0].runtime, undefined, '节点只透出白名单字段')
})

test('projectScenesView：接受单场景对象（CLI 降级）并打 degraded 标记', () => {
  const single = { id: 'custom-5f5c87a1', display_name: '源场景', work_branch: 'dev-ch-11', nodes: [] }
  const out = projectScenesView(single, { degraded: true })
  assert.equal(out.length, 1)
  assert.equal(out[0].degraded, true)
  assert.equal(out[0].display_name, '源场景')

  const plain = projectScenesView({ scenes: [{ id: 's1', display_name: 'x' }] })
  assert.equal(plain[0].degraded, undefined, '快路径不带 degraded')
  assert.deepEqual(projectScenesView(null), [])
})

test('projectHandoffTargets：兼容数组 / scenes / targets 信封，保留 is_current，丢弃无 id', () => {
  const rows = projectHandoffTargets({
    targets: [
      { id: 'custom-5f5c87a1', display_name: '当前流水线', work_branch: 'dev-ch-11', is_current: true },
      { scene_id: 'other-1', name: '另一条', work_branch: 'dev' },
      { display_name: '无 id' },
    ],
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    id: 'custom-5f5c87a1',
    display_name: '当前流水线',
    work_branch: 'dev-ch-11',
    is_current: true,
  })
  assert.equal(rows[1].id, 'other-1')
  assert.equal(rows[1].is_current, false, '未标记的按非当前处理')

  assert.equal(projectHandoffTargets([{ id: 'a', scene_name: '数组形态' }])[0].display_name, '数组形态')
  assert.deepEqual(projectHandoffTargets(null), [])
})

test('projectHandoffTargets：顶层 current_scene_id 回填 is_current（真实响应形状：targets 无 is_current）', () => {
  // 实测 GET /api/issues/20864/handoff/targets：当前场景只在**顶层**，targets[] 没有 is_current
  const real = {
    current_scene_id: 'custom-5f5c87a1',
    targets: [
      { id: 'custom-5f5c87a1', name: '默认流水线', display_name: '默认流水线', description: '', work_branch: 'dev-ch-11', scene_type: 'custom' },
      { id: 'default', name: '默认场景', display_name: '默认场景', description: '', work_branch: 'main', scene_type: 'default' },
      { id: 'weekly-1', name: '周迭代', display_name: '周迭代', description: '', work_branch: 'weekly-1', scene_type: 'custom' },
      { id: 'custom-aaaa0000', name: '另一条', display_name: '另一条', description: '', work_branch: 'dev', scene_type: 'custom' },
    ],
  }
  const rows = projectHandoffTargets(real)
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map((r) => r.is_current), [true, false, false, false],
    '只有 id === current_scene_id 的那一项是当前场景（前端据此显示「当前」并禁用）')
  assert.equal(rows[0].id, 'custom-5f5c87a1')
  assert.equal(rows[1].work_branch, 'main')

  // 嵌套信封同样取到顶层 current_scene_id
  const nested = projectHandoffTargets({
    data: { current_scene_id: 'b', targets: [{ id: 'a' }, { id: 'b' }] },
  })
  assert.deepEqual(nested.map((r) => r.is_current), [false, true])

  // 没有 current_scene_id 也没有 per-item is_current → 全部非当前（不猜）
  assert.deepEqual(
    projectHandoffTargets({ targets: [{ id: 'custom-5f5c87a1' }] }).map((r) => r.is_current),
    [false],
  )

  // per-item 显式 true 仍优先（旧形态 / 其它平台兼容）
  assert.equal(
    projectHandoffTargets({ current_scene_id: 'x', targets: [{ id: 'a', is_current: true }] })[0].is_current,
    true,
  )
})