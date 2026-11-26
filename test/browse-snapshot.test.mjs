/**
 * 浏览首屏持久化快照单元测试（Issue #27）。
 *
 * 测试 seam：`src/browse-snapshot.ts` 是纯逻辑模块（storage 注入、无 React/DOM），
 * 与 `pins-persist.ts` 同型，可在 node:test 里确定性覆盖：
 *   · 键按 baseUrl + 账号隔离
 *   · schema 版本不符 / JSON 损坏 / 字段非法 → 安全失效
 *   · 保存后可经 latest 指针找回（模块加载时 baseUrl 尚未知）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BROWSE_LATEST_KEY,
  BROWSE_SNAPSHOT_SCHEMA,
  loadBrowseSnapshot,
  loadLatestBrowseSnapshot,
  parseBrowseSnapshot,
  saveBrowseSnapshot,
  serializeBrowseSnapshot,
  snapshotKey,
} from '../lib/browse-snapshot.js'
import { PINS_STORAGE_KEY } from '../lib/pins-persist.js'

/** 最小 StorageLike（与浏览器 localStorage 同接口） */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null },
    setItem(k, v) { map.set(k, v) },
    removeItem(k) { map.delete(k) },
  }
}

const BASE = 'https://grape.example.com'

test('快照键按 baseUrl + 账号隔离', () => {
  const a = snapshotKey(BASE, 'alice')
  const b = snapshotKey(BASE, 'bob')
  const c = snapshotKey('https://other.example.com', 'alice')
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.match(a, /grape-dsh\.browse\.v1/)
  assert.ok(a.includes('alice'))
})

test('保存 → 读取 roundtrip 保留 schema / savedAt / data', () => {
  const s = fakeStorage()
  const savedAt = 1_700_000_000_000
  assert.equal(saveBrowseSnapshot(s, { baseUrl: BASE, account: 'alice', data: { repos: [1] }, savedAt }), true)

  const hit = loadBrowseSnapshot(s, BASE, 'alice')
  assert.equal(hit.schema, BROWSE_SNAPSHOT_SCHEMA)
  assert.equal(hit.savedAt, savedAt)
  assert.deepEqual(hit.data, { repos: [1] })

  assert.equal(loadBrowseSnapshot(s, BASE, 'bob'), null, '不同账号不串数据')
})

test('latest 指针可在不知道 baseUrl 时找回快照（模块加载首屏）', () => {
  const s = fakeStorage()
  saveBrowseSnapshot(s, { baseUrl: BASE, account: 'alice', data: { repos: [] }, savedAt: 123 })
  const latest = loadLatestBrowseSnapshot(s)
  assert.ok(latest)
  assert.equal(latest.baseUrl, BASE)
  assert.equal(latest.account, 'alice')
  assert.deepEqual(latest.data, { repos: [] })
  assert.equal(latest.savedAt, 123)
})

test('schema 版本不符 → 安全失效（不返回旧结构数据）', () => {
  const s = fakeStorage()
  const key = snapshotKey(BASE, 'alice')
  s.setItem(key, JSON.stringify({ schema: BROWSE_SNAPSHOT_SCHEMA + 1, savedAt: Date.now(), data: { repos: [1] } }))
  assert.equal(loadBrowseSnapshot(s, BASE, 'alice'), null)
  assert.equal(parseBrowseSnapshot('{"schema":0,"savedAt":1,"data":{}}'), null)
})

test('JSON 损坏 / 字段非法 → 安全失效', () => {
  const s = fakeStorage()
  const key = snapshotKey(BASE, 'alice')
  for (const raw of ['not-json', '[]', 'null', JSON.stringify({ schema: 1, savedAt: 'x', data: {} }), JSON.stringify({ schema: 1, savedAt: 1 })]) {
    s.setItem(key, raw)
    assert.equal(loadBrowseSnapshot(s, BASE, 'alice'), null, `非法快照应失效：${raw}`)
  }
})

test('storage 抛异常时读写都不崩溃', () => {
  const broken = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('quota') },
    removeItem() { throw new Error('denied') },
  }
  assert.equal(saveBrowseSnapshot(broken, { baseUrl: BASE, account: 'alice', data: {} }), false)
  assert.equal(loadBrowseSnapshot(broken, BASE, 'alice'), null)
  assert.equal(loadLatestBrowseSnapshot(broken), null)
})

test('序列化输出带 schema 版本，可被 parse 接受', () => {
  const raw = serializeBrowseSnapshot({ repos: [] }, 42)
  const parsed = parseBrowseSnapshot(raw)
  assert.equal(parsed.schema, BROWSE_SNAPSHOT_SCHEMA)
  assert.equal(parsed.savedAt, 42)
})

test('latest 指针与 pins 存档互不影响', () => {
  const s = fakeStorage({ [PINS_STORAGE_KEY]: JSON.stringify([]) })
  saveBrowseSnapshot(s, { baseUrl: BASE, account: 'alice', data: { repos: [] }, savedAt: 1 })
  assert.equal(s.getItem(PINS_STORAGE_KEY), JSON.stringify([]))
  assert.ok(s.getItem(BROWSE_LATEST_KEY))
})