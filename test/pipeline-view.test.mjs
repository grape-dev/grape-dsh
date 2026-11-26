/**
 * 流水线视图模型单测（Issue #26）。
 *
 * 覆盖 Spec 验收口径：
 *  · 场景 1/3/5 节点，节点链格数 = 场景节点数（不再固定 5）
 *  · 场景内 skip / enabled=false
 *  · segments 含重复节点（重派/重试）→ 链上只占一格 + 重试次数
 *  · pending_review 不再退化为 pending；整体状态按业务字段
 *  · 场景拉取失败 → 退化为 segments 首次出现顺序并标记 sceneUnknown
 *  · 进度不变式：done ≤ total，且 total == 渲染格数
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSceneChain,
  deriveOverall,
  derivePipelineViewFromData,
  projectSceneNodes,
} from '../lib/pipeline-model.js'
import { renderPipelineCard } from '../lib/render/pipeline.js'
import { statusToNum, statusNumText } from '../lib/focus.js'

const node = (tag, extra = {}) => ({ id: tag, tag, next: extra.next ?? null, ...extra })
const chainOf = (tags) => tags.map((tag, i) => node(tag, { next: i === tags.length - 1 ? 'done' : tags[i + 1] }))
const seg = (tag, seq, status = 'completed') => ({ agent: tag, seq, status, event_type: 'a2a_event' })

test('1 节点场景：链只有 1 格，进度 1/1', () => {
  const view = derivePipelineViewFromData({
    segments: [seg('vod', 1)],
    scene_nodes: chainOf(['vod']),
    issue_task_status: 'completed',
  })
  assert.equal(view.total, 1)
  assert.equal(view.done, 1)
  assert.deepEqual(view.nodes.map((n) => n.tag), ['vod'])
  assert.equal(view.sceneUnknown, false)
})

test('3 节点场景：按场景节点渲染，未跑过的节点为待开始', () => {
  const view = derivePipelineViewFromData({
    segments: [seg('vod', 1), seg('issue', 2)],
    scene_nodes: chainOf(['vod', 'issue', 'coding']),
    issue_stage: 'coding',
    issue_task_status: 'processing',
  })
  assert.deepEqual(view.nodes.map((n) => n.tag), ['vod', 'issue', 'coding'])
  assert.deepEqual(view.nodes.map((n) => n.status), [2, 2, 0])
  assert.equal(view.done, 2)
  assert.equal(view.total, 3)
})

test('5 节点场景 + pending_review：qa 显示待审核，进度按 completed 计（4/5，对齐 #22）', () => {
  const view = derivePipelineViewFromData({
    segments: [
      seg('vod', 1), seg('vod', 3),
      seg('issue', 4),
      seg('coding', 5), seg('coding', 7),
      seg('qa', 8), seg('qa', 9),
    ],
    scene_nodes: chainOf(['vod', 'issue', 'coding', 'qa', 'sre']),
    issue_stage: 'qa',
    issue_task_status: 'pending_review',
    review_status: 'pending_review',
    status: 'completed', // 顶层 status = 事件跑完，不允许据此显示已完成
  })
  assert.equal(view.total, 5)
  assert.equal(view.done, 4)
  assert.ok(view.done <= view.total)
  assert.equal(view.overallCode, 6)
  assert.equal(view.overallLabel, '待审核')
  assert.match(view.overallDetail, /qa.*待审核（pending_review）/)
  const qa = view.nodes.find((n) => n.tag === 'qa')
  // 节点 status 只表示执行状态：平台上 qa 已经跑完 → 2；「待审核」是 issue 级业务状态，
  // 用 reviewTag 旁注，不得改写节点 status（否则会出现"平台说完成、面板说待审核"）。
  assert.equal(qa.status, 2)
  assert.equal(view.reviewTag, 'qa', '待审核发生在 qa 格，用 reviewTag 旁注')
  assert.ok(!view.nodes.some((n) => n.status === 6), '不得把审核状态写进节点 status')
  const sre = view.nodes.find((n) => n.tag === 'sre')
  assert.equal(sre.status, 0)
})

test('重复 segments：同 tag 只占一格并记录重试次数（#11 重派场景）', () => {
  const view = derivePipelineViewFromData({
    segments: [seg('vod', 1), seg('vod', 2), seg('vod', 5), seg('issue', 6)],
    scene_nodes: chainOf(['vod', 'issue', 'coding']),
    issue_task_status: 'processing',
    issue_stage: 'coding',
  })
  assert.deepEqual(view.nodes.map((n) => n.tag), ['vod', 'issue', 'coding'])
  const vod = view.nodes[0]
  assert.equal(vod.retries, 2)
  assert.equal(vod.status, 2)
  assert.equal(view.total, 3)
})

test('场景内 skipped：出现在其他节点 skip 列表里的节点展示为已跳过', () => {
  const nodes = chainOf(['vod', 'issue', 'coding', 'qa', 'sre'])
  nodes[0].skip = ['qa'] // vod 的 skip 列表命中 qa
  const view = derivePipelineViewFromData({
    segments: [seg('vod', 1), seg('issue', 2), seg('coding', 3)],
    scene_nodes: nodes,
    issue_stage: 'coding',
    issue_task_status: 'processing',
  })
  const qa = view.nodes.find((n) => n.tag === 'qa')
  assert.equal(qa.status, 5)
  assert.equal(view.total, 5)
})

test('enabled=false 的节点不进入链', () => {
  const nodes = chainOf(['vod', 'issue', 'coding'])
  nodes[1].enabled = false
  const chain = buildSceneChain(nodes)
  assert.deepEqual(chain.map((n) => n.tag), ['vod', 'coding'])
})

test('场景外节点照常展示并标记 outsideScene', () => {
  const view = derivePipelineViewFromData({
    segments: [seg('vod', 1), seg('issue', 2), seg('sre', 3)],
    scene_nodes: chainOf(['vod', 'issue']),
    issue_task_status: 'processing',
  })
  assert.deepEqual(view.nodes.map((n) => n.tag), ['vod', 'issue', 'sre'])
  assert.equal(view.nodes[2].outsideScene, true)
  assert.equal(view.total, 3)
})

test('场景拉取失败：退化为 segments 首次出现顺序并标记 sceneUnknown（不退回 5 格）', () => {
  const view = derivePipelineViewFromData({
    segments: [seg('vod', 1), seg('issue', 2), seg('coding', 3, 'running')],
    issue_stage: 'coding',
    issue_task_status: 'processing',
    // 富化方试过拉场景但失败（Issue #26 R2：未尝试不标「场景未知」）
    scene_unknown: true,
  })
  assert.equal(view.sceneUnknown, true)
  assert.deepEqual(view.nodes.map((n) => n.tag), ['vod', 'issue', 'coding'])
  assert.equal(view.total, 3)
  assert.equal(view.done, 2)
})

test('整体状态映射表：业务字段优先，pending_review / active / failed / cancelled / completed', () => {
  assert.equal(deriveOverall({ issue_task_status: 'completed' }, []).code, 2)
  assert.equal(deriveOverall({ issue_stage: 'done' }, []).code, 2)
  assert.equal(deriveOverall({ issue_task_status: 'pending_review' }, []).code, 6)
  assert.equal(deriveOverall({ review_status: 'pending_review' }, []).code, 6)
  assert.equal(deriveOverall({ issue_task_status: 'processing', issue_stage: 'coding' }, []).code, 1)
  assert.equal(deriveOverall({ issue_task_status: 'failed' }, []).code, 3)
  assert.equal(deriveOverall({ issue_task_status: 'cancelled' }, []).code, 4)
  // 顶层 status 不得单独判定「已完成」
  assert.equal(deriveOverall({ status: 'completed' }, []).code, 0)
})

test('状态码：pending_review 映射为 6（待审核），不再退化为 pending', () => {
  assert.equal(statusToNum('pending_review'), 6)
  assert.equal(statusNumText(6), '待审核')
})

test('projectSceneNodes：只保留链相关字段', () => {
  const nodes = projectSceneNodes({
    nodes: [
      { id: 'vod', tag: 'vod', skill: 'vod-cli', next: 'issue', skip: [], enabled: true, engine_runtime_ids: [1] },
      { id: 'issue', tag: 'issue', next: 'done', enabled: false },
    ],
  })
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].id, 'vod')
  assert.equal(nodes[0].next, 'issue')
  assert.equal(nodes[1].enabled, false)
  assert.equal('engine_runtime_ids' in nodes[0], false)
})

test('文本渲染：按场景节点画框，同 tag 不重复画框，pending_review 显示待审核', () => {
  const text = renderPipelineCard({
    issue: { number: 22 },
    segments: [seg('vod', 1), seg('vod', 2), seg('qa', 8), seg('qa', 9)],
    scene_nodes: chainOf(['vod', 'issue', 'qa', 'sre']),
    scene_id: 'custom-x',
    scene_name: '通用开发',
    issue_stage: 'qa',
    issue_task_status: 'pending_review',
    review_status: 'pending_review',
    status: 'completed',
  })
  assert.match(text, /Pipeline: 通用开发 · Issue 22/)
  assert.equal((text.match(/┌/g) || []).length, 4) // 4 个格，而不是按 segments 条数（4 条）凑巧相等
  assert.match(text, /待审核/)
  assert.match(text, /整体: qa · 待审核（pending_review）/)
})

test('文本渲染：重复节点只画一格，并显示重试次数', () => {
  const text = renderPipelineCard({
    issue: { number: 11 },
    segments: [seg('vod', 1), seg('vod', 2), seg('vod', 3), seg('issue', 4)],
    scene_nodes: chainOf(['vod', 'issue', 'coding']),
    issue_stage: 'coding',
    issue_task_status: 'processing',
  })
  assert.equal((text.match(/┌/g) || []).length, 3)
  assert.match(text, /重试 2 次/)
})

test('文本渲染：场景未知时明确标注，并按 segments 顺序画框', () => {
  const text = renderPipelineCard({
    issue: { number: 21 },
    segments: [seg('vod', 1)],
    issue_task_status: 'processing',
    issue_stage: 'vod',
    // 富化方试过拉场景但失败（Issue #26 R2：只有显式标记才提示「场景未知」）
    scene_unknown: true,
  })
  assert.equal((text.match(/┌/g) || []).length, 1)
  assert.match(text, /场景未知，按事件推断/)
})
test('业务词出现在 issue_stage：不当作阶段前缀，且链上有一格标待审核（Issue #26 R1）', () => {
  const tags = ['vod', 'issue', 'coding', 'qa', 'sre']
  const view = derivePipelineViewFromData({
    issue_stage: 'pending_review',
    issue_task_status: 'pending_review',
    review_status: 'pending_review',
    scene_id: 'custom-x',
    scene_nodes: chainOf(tags),
    segments: tags.map((t, i) => seg(t, i + 1)),
  })
  assert.equal(view.overallLabel, '待审核')
  assert.doesNotMatch(view.overallDetail, /^pending_review/, '业务词不得当阶段前缀重复一遍')
  assert.equal(view.stage, undefined, '业务词不得透出成「阶段」')
  assert.ok(!view.nodes.some((n) => n.status === 6), '审核状态不得写进节点 status（节点 status 只表示执行结果）')
  assert.equal(view.reviewTag, view.nodes[view.nodes.length - 1].tag, '没有同名节点时，待审核旁注给链上最后一格')
  assert.equal(view.done, 5, '进度只按节点执行状态统计，不受审核状态影响')
  assert.equal(view.total, 5)
})

test('active.stage 不再冒充 issue_stage：pipeline get 缺业务字段时按事件推断（Issue #26 R3）', () => {
  const view = derivePipelineViewFromData({
    active: {
      stage: 'qa',
      segments: [{ agent: 'qa', seq: 1, status: 'failed' }],
    },
  })
  assert.equal(view.overallCode, 3, '应按事件推断出失败，而不是恒判「进行中」')
  assert.match(view.overallDetail, /qa.*失败（按事件推断）/)
})

test('issue_stage 是节点 tag 时仍是阶段（vod + active），不被业务词逻辑吞掉（Issue #26 R1 回归）', () => {
  const d = deriveOverall({ issue_stage: 'vod', issue_task_status: 'active' }, [])
  assert.equal(d.code, 1)
  assert.match(d.detail, /^vod · 进行中（active）$/)
})


test('按事件推断按 tag 取最新：首跑失败、重派成功不算整体失败（Issue #26 R4）', () => {
  const view = derivePipelineViewFromData({
    segments: [
      { agent: 'coding', seq: 1, status: 'failed' },
      { agent: 'coding', seq: 2, status: 'completed' },
    ],
  })
  assert.notEqual(view.overallCode, 3, '重试成功的节点不应让整体判成失败')
  assert.equal(view.overallCode, 2)
  assert.equal(view.nodes.length, 1, '同 tag 只占一格')
  assert.equal(view.nodes[0].retries, 1)
})


test('场景未知只在「试过且失败」时标记：原始 pipeline 数据不再谎报（Issue #26 R2）', () => {
  // 没有 scene_nodes 也没有标记（例如 grape_wait_task 的轮询结果）
  const plain = derivePipelineViewFromData({ segments: [seg('vod', 1)] })
  assert.equal(plain.sceneUnknown, false, '从未尝试补场景时不得提示「场景未知」')

  // 富化方明确标记失败
  const failed = derivePipelineViewFromData({ segments: [seg('vod', 1)], scene_unknown: true })
  assert.equal(failed.sceneUnknown, true)
})
