/**
 * 写路由（issue-start / issue-confirm-done / issue-handoff*）的纯逻辑单测（Issue #42）。
 *
 * 测试 seam：`src/issue-action-api.ts` —— 入参解析 / 校验 / 错误映射 / handoff 结果分类。
 * 路由（`src/index.ts`）只做 `grapeApiCall` + 这些函数，和 #40 的 `create-issue.ts`
 * 同一分界线：任何映射回归都能被单测挡住，而不是靠人点按钮。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyHandoffResult,
  isAlreadyStarted,
  parseIssueActionId,
  toIssueActionError,
  validateHandoffInput,
} from '../lib/issue-action-api.js'

test('parseIssueActionId：id / issue_id 都接受，正整数字符串归一', () => {
  assert.deepEqual(parseIssueActionId({ id: 20864 }), { ok: true, id: 20864 })
  assert.deepEqual(parseIssueActionId({ issue_id: 20864 }), { ok: true, id: 20864 })
  assert.deepEqual(parseIssueActionId({ id: '20864' }), { ok: true, id: 20864 })
  assert.deepEqual(parseIssueActionId({ id: ' 20864 ' }), { ok: true, id: 20864 }, 'query 字符串会带空白')
})

test('parseIssueActionId：issue number / 0 / 负数 / 元字符 → invalid_id（不允许拿编号冒充分号）', () => {
  for (const bad of [{}, { id: 0 }, { issue_id: '0' }, { id: -1 }, { id: '#42' }, { id: '42.0' }, { id: 'IKXR3B' }, null, 'x', 42]) {
    const r = parseIssueActionId(bad)
    assert.equal(r.ok, false, `非法入参应拒绝：${JSON.stringify(bad)}`)
    if (!r.ok) {
      assert.equal(r.code, 'invalid_id')
      assert.match(r.message, /id/i)
    }
  }
})

test('validateHandoffInput：id + target_scene_id 白名单', () => {
  const ok = validateHandoffInput({ id: 20864, target_scene_id: 'custom-5f5c87a1' })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.deepEqual(ok.value, { id: 20864, target_scene_id: 'custom-5f5c87a1' })

  for (const bad of ['', ' ', '-x', 'a b', 'a/b', 'a'.repeat(65), '../etc']) {
    const r = validateHandoffInput({ id: 20864, target_scene_id: bad })
    assert.equal(r.ok, false, `非法目标场景应拒绝：${JSON.stringify(bad)}`)
    if (!r.ok) assert.equal(r.code, 'invalid_target_scene')
  }

  const noId = validateHandoffInput({ target_scene_id: 'scene-1' })
  assert.equal(noId.ok, false)
  if (!noId.ok) assert.equal(noId.code, 'invalid_id', 'id 校验优先于场景校验')
})

test('错误映射：4xx 原状态透传（403 / 404 / 409），带平台 code / message / request_id', () => {
  const r403 = toIssueActionError({
    status: 403, data: { code: 'forbidden', message: '没有权限' }, requestId: 'req-h-1',
  })
  assert.equal(r403.status, 403)
  assert.equal(r403.body.code, 'forbidden')
  assert.equal(r403.body.message, '没有权限')
  assert.equal(r403.body.request_id, 'req-h-1')

  const r404 = toIssueActionError({ status: 404, data: { error: 'issue not found' } })
  assert.equal(r404.status, 404)
  assert.equal(r404.body.code, 'issue_action_failed', '平台没给 code 时用默认业务码')
  assert.equal(r404.body.message, 'issue not found')

  const r409 = toIssueActionError({ status: 409, data: { message: '状态冲突' } })
  assert.equal(r409.status, 409, '409 必须原状态透传（前端据此给「已处理」提示）')
  assert.equal(r409.body.message, '状态冲突')
})

test('错误映射：5xx / 网络层失败 → 502 upstream_unavailable + 可读文案', () => {
  const r500 = toIssueActionError({ status: 500, data: { message: '内部错误' } })
  assert.equal(r500.status, 502)
  assert.equal(r500.body.code, 'upstream_unavailable')
  assert.equal(r500.body.message, '内部错误')

  const offline = toIssueActionError({ status: 0 })
  assert.equal(offline.status, 502)
  assert.equal(offline.body.code, 'upstream_unavailable')
  assert.match(String(offline.body.message), /无法连接/)

  const bare = toIssueActionError({})
  assert.equal(bare.status, 502)
})

test('issue-start 的 409 视为已启动（继续打开深链，不报错）', () => {
  assert.equal(isAlreadyStarted(409), true)
  assert.equal(isAlreadyStarted(200), false)
  assert.equal(isAlreadyStarted(0), false)
})

test('classifyHandoffResult：seq>0 成功', () => {
  const r = classifyHandoffResult({ seq: 108900, handoff_id: 'x' })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.seq, 108900)
})

test('classifyHandoffResult：duplicate_handoff / target_scene_missing_node 两类 skipped', () => {
  const dup = classifyHandoffResult({ skipped: 'duplicate_handoff' })
  assert.equal(dup.ok, false)
  if (!dup.ok) assert.equal(dup.skipped, 'duplicate_handoff')

  const missing = classifyHandoffResult({ skipped: 'target_scene_missing_node' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.skipped, 'target_scene_missing_node')

  const viaCode = classifyHandoffResult({ code: 'duplicate_handoff' })
  assert.equal(viaCode.ok, false)
  if (!viaCode.ok) assert.equal(viaCode.skipped, 'duplicate_handoff', '平台也可能把 skipped 放进 code')
})

test('classifyHandoffResult：未知失败保留原文与 code，不伪装成 skipped', () => {
  const r = classifyHandoffResult({ message: '目标场景不存在', code: 'bad_target' })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.skipped, '')
    assert.equal(r.message, '目标场景不存在')
    assert.equal(r.code, 'bad_target')
  }

  const empty = classifyHandoffResult(null)
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.equal(empty.skipped, '')
})