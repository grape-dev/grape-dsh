/**
 * 接管动作后的加速轮询窗口（`src/follow-window.ts`）单元测试。
 *
 * 为什么单独抽纯逻辑：`pins-store.ts` 依赖 React 与浏览器全局，无法在 `node:test` 里直接跑；
 * 把「首拍立即 / 每 4s 一拍 / 60s 到期停止 / 后台跳过 / pin 移除后停止」抽成无依赖状态机，
 * 用假时钟驱动即可验证时序与清理，无需真实等待 60 秒。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { startFollowWindow } from '../lib/follow-window.js'

/** 假时钟 + 手动调度队列（不使用真实定时器） */
function fakeEnvironment() {
  let now = 0
  let seq = 0
  const queue = new Map()

  return {
    now: () => now,
    schedule(fn, ms) {
      const id = ++seq
      queue.set(id, { at: now + ms, fn })
      return id
    },
    cancel(id) {
      queue.delete(id)
    },
    /** 推进假时钟，按到期顺序执行队列里的任务（任务内新排的也会被消费） */
    advance(ms) {
      const target = now + ms
      for (;;) {
        const next = [...queue.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, task] = next
        queue.delete(id)
        now = task.at
        task.fn()
      }
      now = target
    },
    pending: () => queue.size,
    get current() {
      return now
    },
  }
}

function createFollow(env, overrides = {}) {
  const ticks = []
  const stops = []
  const win = startFollowWindow({
    durationMs: 60_000,
    stepMs: 4_000,
    now: env.now,
    schedule: env.schedule,
    cancel: env.cancel,
    onTick: () => ticks.push(env.current),
    isActive: () => true,
    isHidden: () => false,
    onStop: () => stops.push(env.current),
    ...overrides,
  })
  return { win, ticks, stops }
}

test('首拍立即执行，随后每 4s 一拍', () => {
  const env = fakeEnvironment()
  const { win, ticks } = createFollow(env)

  assert.deepEqual(ticks, [0], '启动后立即拍一次，不等 4s')
  env.advance(4_000)
  assert.deepEqual(ticks, [0, 4_000])
  env.advance(4_000)
  assert.deepEqual(ticks, [0, 4_000, 8_000])
  assert.equal(win.stopped, false)

  win.stop()
})

test('60s 到期自动停止：最后一拍在 56s，之后不再起定时器', () => {
  const env = fakeEnvironment()
  const { win, ticks, stops } = createFollow(env)

  env.advance(60_000)

  assert.equal(ticks.length, 15, '0/4/…/56 共 15 拍')
  assert.equal(ticks.at(-1), 56_000)
  assert.equal(win.stopped, true)
  assert.equal(env.pending(), 0, '到期后队列为空，无残留定时器')
  assert.deepEqual(stops, [60_000], '停表发生在 60s 到期时刻')

  env.advance(60_000)
  assert.equal(ticks.length, 15, '停止后继续推进也不再拍')
})

test('stop() 幂等，并清理已排队的定时器', () => {
  const env = fakeEnvironment()
  const { win, ticks } = createFollow(env)

  env.advance(4_000)
  win.stop()
  win.stop()

  assert.equal(win.stopped, true)
  assert.equal(env.pending(), 0)
  env.advance(60_000)
  assert.deepEqual(ticks, [0, 4_000], 'stop 之后不再拍')
})

test('document.hidden 时跳过该拍，回前台由下一拍补拉', () => {
  const env = fakeEnvironment()
  let hidden = false
  const { ticks } = createFollow(env, { isHidden: () => hidden })

  assert.deepEqual(ticks, [0])
  hidden = true
  env.advance(8_000)
  assert.deepEqual(ticks, [0], '后台 4s/8s 两拍都被跳过')
  assert.equal(env.pending(), 1, '跳过的那拍仍保留下一拍的排程')

  hidden = false
  env.advance(4_000)
  assert.deepEqual(ticks, [0, 12_000], '回前台后第一拍立即补拉')
})

test('pin 被移除后自动停止，不再空跑', () => {
  const env = fakeEnvironment()
  let active = true
  const { win, ticks } = createFollow(env, { isActive: () => active })

  assert.equal(ticks.length, 1)
  active = false
  env.advance(4_000)

  assert.equal(ticks.length, 1, '失效后不再拍')
  assert.equal(win.stopped, true)
  assert.equal(env.pending(), 0)
})

test('自定义窗口时长：10s / 4s → 只在 0/4/8s 拍三次', () => {
  const env = fakeEnvironment()
  const { win, ticks } = createFollow(env, { durationMs: 10_000, stepMs: 4_000 })

  env.advance(10_000)
  assert.deepEqual(ticks, [0, 4_000, 8_000])
  assert.equal(win.stopped, true)
  assert.equal(env.pending(), 0)
})