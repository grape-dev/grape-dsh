/**
 * 接管期间禁止派发 —— 插件侧守门的单元测试。
 *
 * 跑的是 tsc 产物（`lib/`），与其它单测一致：`npm test` 先 build 再跑。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  evaluateRedispatchGuard,
  eventDetailPath,
  mapRedispatchReply,
  takeoverBlockMessage,
  takeoverListPath,
} from '../lib/takeover-dispatch.js'

const EVENT = { repo_key: 'gitcode:grape-dev/grape', issue_id: '#3201' }

test('evaluateRedispatchGuard：拿不到事件 → 放行（探测失败不能让排障入口不可用）', () => {
  const r = evaluateRedispatchGuard({ event: null, sessions: [{ id: 'tk1' }] })
  assert.equal(r.blocked, false)
})

test('evaluateRedispatchGuard：该 issue 没有 active 接管 → 放行', () => {
  const r = evaluateRedispatchGuard({ event: EVENT, sessions: [] })
  assert.equal(r.blocked, false)
  assert.equal(r.status, 200)
})

test('evaluateRedispatchGuard：事件没有 issue 维度（PR 订阅等）→ 放行，不拿 repo 级接管挡别的单', () => {
  const r = evaluateRedispatchGuard({
    event: { repo_key: 'gitcode:grape-dev/grape', issue_id: '' },
    sessions: [{ id: 'tk1', issue_id: '#3201', agent_type: 'coding' }],
  })
  assert.equal(r.blocked, false)
})

test('evaluateRedispatchGuard：会话属于别的 issue → 放行（服务端过滤失效时的兜底）', () => {
  const r = evaluateRedispatchGuard({
    event: EVENT,
    sessions: [{ id: 'tk1', issue_id: '#9999', agent_type: 'coding' }],
  })
  assert.equal(r.blocked, false)
})

test('evaluateRedispatchGuard：会话的 `#3201` 与事件的 `#3201` 归一后命中', () => {
  const r = evaluateRedispatchGuard({
    event: EVENT,
    sessions: [{ id: 'tk1', issue_id: '#3201', agent_type: 'coding' }],
  })
  assert.equal(r.blocked, true)
  assert.equal(r.status, 409)
})

test('evaluateRedispatchGuard：有接管 → 409，且原因里带节点/接管人/接管 id', () => {
  const r = evaluateRedispatchGuard({
    event: EVENT,
    sessions: [{ id: 'tk_abc', username: 'developer_ch', agent_type: 'coding' }],
  })
  assert.equal(r.blocked, true)
  assert.equal(r.status, 409)
  const detail = r.body.detail
  assert.equal(String(r.body.error), 'takeover_active')
  assert.equal(String(detail.error), 'takeover_active')
  assert.match(String(detail.message), /coding/)
  assert.match(String(detail.message), /developer_ch/)
  assert.match(String(detail.message), /tk_abc/)
  assert.match(String(detail.message), /确认完成/)
})

test('takeoverBlockMessage：多条接管时给出条数，缺字段时不出现空占位', () => {
  const msg = takeoverBlockMessage([{ id: 'a' }, { id: 'b' }])
  assert.match(msg, /2 条接管/)
  assert.doesNotMatch(msg, /@\s*·/)
  assert.doesNotMatch(msg, /undefined|null/)
  assert.match(takeoverBlockMessage([{}]), /该 issue 正被接管/)
})

test('mapRedispatchReply：成功原样透传', () => {
  const r = mapRedispatchReply({ ok: true, status: 200, data: { status: 'redispatched', task_id: 't1' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.task_id, 't1')
})

test('mapRedispatchReply：平台 409 already_taken_over → 翻成中文可读原因', () => {
  const r = mapRedispatchReply({
    ok: false,
    status: 409,
    data: { detail: { code: 'already_taken_over', message: 'Issue #3201 正被 developer_ch 接管中' } },
  })
  assert.equal(r.status, 409)
  assert.equal(String(r.body.error), 'takeover_active')
  assert.match(String(r.body.detail.message), /放弃接管/)
})

test('mapRedispatchReply：其它错误不篡改（保留平台原文，便于排障）', () => {
  const data = { detail: { code: 500, message: 'boom' } }
  const r = mapRedispatchReply({ ok: false, status: 500, data })
  assert.equal(r.status, 500)
  assert.deepEqual(r.body, data)
})

// ── 下面三条钉住 URL 拼装：路径写错时守门会静默失效（实测踩过 `/api/events/{seq}` 404）──

test('eventDetailPath：必须是平台真实路由 /api/events/detail/{seq}', () => {
  assert.equal(eventDetailPath(83444), '/api/events/detail/83444')
  // 反例：/api/events/83444 在 beta:9443 与 www 上都是 404，会让守门永远放行
  assert.doesNotMatch(eventDetailPath(83444), /^\/api\/events\/\d/)
})

test('takeoverListPath：固定 status=active，issue_id 用裸号', () => {
  assert.equal(
    takeoverListPath({ repoKey: 'gitcode:grape-dev/grape', issueId: '#3201' }),
    '/api/takeover/sessions?repo_key=gitcode%3Agrape-dev%2Fgrape&status=active&issue_id=3201',
  )
  assert.match(takeoverListPath({ repoKey: 'r', issueId: '3201' }), /issue_id=3201$/)
})

test('takeoverListPath：没有 issue 维度 → 空串（调用方放行，绝不下发整仓查询）', () => {
  assert.equal(takeoverListPath({ repoKey: 'gitcode:grape-dev/grape' }), '')
  assert.equal(takeoverListPath({ repoKey: 'gitcode:grape-dev/grape', issueId: '   ' }), '')
})
