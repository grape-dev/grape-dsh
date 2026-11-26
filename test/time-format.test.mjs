/**
 * 时间口径单测：服务端时间一律 UTC，展示必须换算成本地时间。
 *
 * 事故背景：面板/工具输出里出现「差 8 小时」的时间 —— 服务端 `2026-11-18T03:24:47.6+00:00`
 * 被 `slice(0,19).replace('T',' ')` 或裸 `Date.parse`（无时区后缀按本地解析）当成本地时间。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { formatTime, parseServerTime } from '../lib/time-format.js'

const zone = { timeZone: 'Asia/Shanghai', locale: 'zh-CN' }

test('parseServerTime：无时区后缀按 UTC 解析（不是本地时间）', () => {
  assert.equal(parseServerTime('2026-11-18T03:24:47'), Date.parse('2026-11-18T03:24:47Z'))
  assert.equal(parseServerTime('2026-11-18 03:24:47'), Date.parse('2026-11-18T03:24:47Z'))
})

test('parseServerTime：带 Z / ±HH:MM 的串按自身偏移解析，不再补 Z', () => {
  assert.equal(parseServerTime('2026-11-18T03:24:47Z'), Date.parse('2026-11-18T03:24:47Z'))
  assert.equal(parseServerTime('2026-11-18T03:24:47+00:00'), Date.parse('2026-11-18T03:24:47Z'))
  assert.equal(parseServerTime('2026-11-18T11:24:47+08:00'), Date.parse('2026-11-18T03:24:47Z'))
})

test('parseServerTime：空值/非法值返回 NaN（调用方据此跳过而不是显示 1970）', () => {
  assert.ok(Number.isNaN(parseServerTime('')))
  assert.ok(Number.isNaN(parseServerTime(null)))
  assert.ok(Number.isNaN(parseServerTime(undefined)))
  assert.ok(Number.isNaN(parseServerTime('不是时间')))
})

test('formatTime：UTC 串按目标时区渲染（+08 差 8 小时就是回归）', () => {
  assert.equal(formatTime('2026-11-18T03:24:47.698628+00:00', zone), '2026-11-18 11:24:47')
  assert.equal(formatTime('2026-11-18T03:24:47', zone), '2026-11-18 11:24:47')
})

test('formatTime：空值 → 空串；无法解析 → 原样返回（不吞信息）', () => {
  assert.equal(formatTime('', zone), '')
  assert.equal(formatTime(null, zone), '')
  assert.equal(formatTime('不是时间', zone), '不是时间')
})
