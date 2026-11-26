/**
 * Issue #43 建会话并发协调器单测（R1–R4）。
 *
 * 覆盖：
 *   R1 并发 3 次只调用一次 create、返回同一 sessionId；
 *   R2 创建中禁止自动恢复、失败后恢复为可恢复；
 *   R3 创建成功后 10s 内不自动恢复，窗口过后恢复；
 *   R4 同一 key 下旧会话被取消、reconcile 保留平台已登记会话。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_RECOVERY_WINDOW_MS,
  TakeoverSessionCoordinator,
  fingerprintPrompt,
  takeoverSessionKey,
} from '../lib/takeover-session.js'

const ID = { takeoverId: 'tkos_1', workspaceId: 'ws_1', prompt: 'do the task' }

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('takeoverSessionKey：takeoverId 优先，否则 workspaceId+prompt 指纹', () => {
  assert.equal(takeoverSessionKey(ID), 'takeover:tkos_1')
  assert.equal(takeoverSessionKey({ takeoverId: '', workspaceId: 'ws_1', prompt: 'p' }), `workspace:ws_1|prompt:${fingerprintPrompt('p')}`)
  assert.equal(takeoverSessionKey({ workspaceId: 'ws_1' }), '')
  assert.notEqual(fingerprintPrompt('a'), fingerprintPrompt('b'))
  assert.equal(fingerprintPrompt('same'), fingerprintPrompt('same'))
})

test('R1 并发 3 次只建 1 个会话且共享同一 sessionId', async () => {
  const gate = deferred()
  const calls = []
  const create = (workspaceId, prompt) => {
    calls.push({ workspaceId, prompt })
    return gate.promise
  }
  const coordinator = new TakeoverSessionCoordinator()
  const input = { ...ID, create }

  const p1 = coordinator.createSession(input)
  const p2 = coordinator.createSession(input)
  const p3 = coordinator.createSession(input)

  assert.equal(calls.length, 1, '同 key 并发只应调用一次 create')
  assert.equal(coordinator.isCreating(ID), true)

  gate.resolve('session-1')
  const [r1, r2, r3] = await Promise.all([p1, p2, p3])

  assert.equal(calls.length, 1)
  assert.deepEqual([r1.sessionId, r2.sessionId, r3.sessionId], ['session-1', 'session-1', 'session-1'])
  assert.equal(r1.created, true)
  assert.equal(r2.created, false)
  assert.equal(r3.created, false)
  assert.equal(coordinator.isCreating(ID), false)
  assert.deepEqual(coordinator.trackedSessionIds(ID), ['session-1'])
})

test('R1 不同 key（不同 takeoverId）互不去重', async () => {
  const calls = []
  const coordinator = new TakeoverSessionCoordinator()
  const make = (takeoverId, sessionId) => ({
    ...ID,
    takeoverId,
    create: async () => { calls.push(takeoverId); return sessionId },
  })
  const [a, b] = await Promise.all([
    coordinator.createSession(make('tkos_a', 'sa')),
    coordinator.createSession(make('tkos_b', 'sb')),
  ])
  assert.equal(calls.length, 2)
  assert.equal(a.sessionId, 'sa')
  assert.equal(b.sessionId, 'sb')
})

test('R2 创建中禁止自动恢复、失败后恢复为可恢复', async () => {
  const gate = deferred()
  const coordinator = new TakeoverSessionCoordinator({ now: () => 1000 })
  const p = coordinator.createSession({ ...ID, create: () => gate.promise })

  assert.equal(coordinator.canAutoRecover(ID), false, '创建进行中不得自动恢复')

  gate.reject(new Error('create failed'))
  await assert.rejects(p, /create failed/)

  assert.equal(coordinator.isCreating(ID), false)
  assert.equal(coordinator.canAutoRecover(ID), true, '失败后应仍允许恢复')
})

test('R3 创建成功后 10s 内不自动恢复，窗口过后恢复', async () => {
  let t = 1_000
  const coordinator = new TakeoverSessionCoordinator({ now: () => t })
  await coordinator.createSession({ ...ID, create: async () => 'session-r3' })

  assert.equal(coordinator.canAutoRecover(ID), false, '窗口内不自动恢复')
  t += DEFAULT_RECOVERY_WINDOW_MS - 1
  assert.equal(coordinator.canAutoRecover(ID), false)
  t += 1
  assert.equal(coordinator.canAutoRecover(ID), true, '超过窗口后可恢复')
})

test('R4 同一 key 下旧会话被取消并留痕', async () => {
  const released = []
  const logs = []
  const coordinator = new TakeoverSessionCoordinator({
    release: async (sessionId) => { released.push(sessionId); return true },
    log: (step, extra) => logs.push({ step, extra }),
  })

  await coordinator.createSession({ ...ID, create: async () => 'old-session' })
  const second = await coordinator.createSession({ ...ID, create: async () => 'new-session' })

  assert.equal(second.created, true)
  assert.deepEqual(second.cancelled, ['old-session'])
  assert.deepEqual(released, ['old-session'])
  assert.deepEqual(coordinator.trackedSessionIds(ID), ['new-session'])
  assert.ok(logs.some((l) => l.step === 'duplicate_session_cancelled'))
})

test('R4 外部（DOM 回退）建会话纳入创建态门禁，TTL 到期自动解除', () => {
  let t = 1_000
  const coordinator = new TakeoverSessionCoordinator({
    now: () => t,
    externalCreateTtlMs: 60_000,
  })

  const key = coordinator.beginExternalCreate(ID)
  assert.equal(key, 'takeover:tkos_1')
  assert.equal(coordinator.isCreating(ID), true)
  assert.equal(coordinator.canAutoRecover(ID), false, 'DOM 回退建会话期间不得自动恢复')

  coordinator.endExternalCreate(key)
  assert.equal(coordinator.isExternalCreating(ID), false)
  assert.equal(coordinator.canAutoRecover(ID), true, '回退结束后应恢复自动恢复')

  // 页面异常没走到结束分支（如崩溃/跳走）也不能永久卡住恢复 → TTL 兜底
  coordinator.beginExternalCreate(ID, t)
  t += 59_000
  assert.equal(coordinator.isExternalCreating(ID), true, 'TTL 内仍视为创建中')
  t += 2_000
  assert.equal(coordinator.isExternalCreating(ID), false, '超过 TTL 自动解除')
  assert.equal(coordinator.canAutoRecover(ID), true)
})

test('R4 reconcile 保留平台已登记会话并取消其它已跟踪会话', async () => {
  const released = []
  const coordinator = new TakeoverSessionCoordinator({
    release: async (sessionId) => { released.push(sessionId); return true },
  })

  // 服务端已登记 session-reg（本端另建了一条未登记的 session-local）→ 保留已登记项、取消本地多余项
  await coordinator.createSession({ ...ID, create: async () => 'session-local' })
  const result = await coordinator.reconcile({ takeoverId: 'tkos_1', registeredSessionId: 'session-reg' })

  assert.equal(result.kept, 'session-reg')
  assert.deepEqual(result.cancelled, ['session-local'])
  assert.deepEqual(released, ['session-local'])
  assert.deepEqual(coordinator.trackedSessionIds(ID), ['session-reg'])
})

test('R4 reconcile 不复活已释放会话（唯一保留策略：已登记优先，但已取消的不复活）', async () => {
  const released = []
  const logs = []
  const coordinator = new TakeoverSessionCoordinator({
    release: async (sessionId) => { released.push(sessionId); return true },
    log: (step, extra) => logs.push({ step, extra }),
  })

  await coordinator.createSession({ ...ID, create: async () => 'session-a' })
  await coordinator.createSession({ ...ID, create: async () => 'session-b' })
  assert.deepEqual(released, ['session-a'], '建 b 时 a 已被取消')

  const result = await coordinator.reconcile({ takeoverId: 'tkos_1', registeredSessionId: 'session-a' })

  assert.equal(result.kept, 'session-b', '不得把已取消的 a 重新当作保留项')
  assert.deepEqual(result.cancelled, [], '当前跟踪项就是保留项，不应再取消')
  assert.deepEqual(released, ['session-a'], '不得再次释放/复活已取消会话')
  assert.deepEqual(coordinator.trackedSessionIds(ID), ['session-b'])
  assert.ok(logs.some((l) => l.step === 'registered_session_released'), '已登记项已释放需留痕')
})

test('R4 建新会话时不取消平台已登记会话（已登记优先）', async () => {
  const released = []
  const coordinator = new TakeoverSessionCoordinator({
    release: async (sessionId) => { released.push(sessionId); return true },
  })

  await coordinator.createSession({ ...ID, create: async () => 'registered-1' })
  const second = await coordinator.createSession({
    ...ID,
    registeredSessionId: 'registered-1',
    create: async () => 'new-1',
  })

  assert.equal(second.created, true)
  assert.deepEqual(second.cancelled, [], '已登记会话不得取消')
  assert.deepEqual(released, [])
  assert.deepEqual(coordinator.trackedSessionIds(ID), ['registered-1', 'new-1'])
})

test('reconcile 无已跟踪会话时只记录已登记项，不调用 release', async () => {
  const released = []
  const coordinator = new TakeoverSessionCoordinator({
    release: async (sessionId) => { released.push(sessionId); return true },
  })
  const result = await coordinator.reconcile({ takeoverId: 'tkos_new', registeredSessionId: 'registered-1' })
  assert.equal(result.kept, 'registered-1')
  assert.deepEqual(result.cancelled, [])
  assert.deepEqual(released, [])
})