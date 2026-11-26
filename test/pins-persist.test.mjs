/**
 * 「观察列表」本地存档迁移单测（Issue #15 复审 R1）。
 *
 * 改名后存储 key 由「旧包名 + `.pins.v1`」变为 `grape-dsh.pins.v1`。升级不能让用户
 * 已钉住的 issue 凭空消失，因此读取时做一次性兜底迁移：
 * - 新 key 有值 → 以新 key 为准，旧 key 原样不动；
 * - 仅旧 key → 解析成功才写回新 key，写回成功后才删旧 key；
 * - 旧值非法 → 按空列表处理，且保留旧 key（留证、防二次覆盖）；
 * - 写回失败 → 仍返回旧数据，旧 key 不删（不制造数据丢失）。
 *
 * `pins-store.ts` 依赖 React / 浏览器全局，这里测的是抽出的纯模块
 * `src/pins-persist.ts`（storage 由参数注入）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LEGACY_PINS_STORAGE_KEY,
  PINS_STORAGE_KEY,
  loadPersistedPins,
} from '../lib/pins-persist.js'

const NEW_KEY = PINS_STORAGE_KEY
const OLD_KEY = LEGACY_PINS_STORAGE_KEY

const PIN_A = { owner: 'grape-dev', repo: 'grape-dsh', number: '15', title: 'A', pinnedAt: 1000 }
const PIN_B = { owner: 'grape-dev', repo: 'grape', number: 'IKXR3B', title: 'B', pinnedAt: 2000 }

/** 最小 localStorage 假实现（含写入/删除记录与可注入的失败模式） */
function fakeStorage(initial = {}, { failSet = false, failRemove = false } = {}) {
  const data = new Map(Object.entries(initial))
  const calls = { set: [], remove: [] }
  return {
    data,
    calls,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem(key, value) {
      if (failSet) throw new Error('QuotaExceededError')
      calls.set.push(key)
      data.set(key, value)
    },
    removeItem(key) {
      if (failRemove) throw new Error('removeItem failed')
      calls.remove.push(key)
      data.delete(key)
    },
  }
}

function storedPins(storage, key) {
  const raw = storage.getItem(key)
  return raw === null ? null : JSON.parse(raw)
}

test('新 key 有值 → 优先新 key，旧 key 原样不动', () => {
  const storage = fakeStorage({
    [NEW_KEY]: JSON.stringify([PIN_A]),
    [OLD_KEY]: JSON.stringify([PIN_B]),
  })

  const pins = loadPersistedPins(storage)

  assert.deepEqual(pins, [PIN_A], '应以新 key 的列表为准')
  assert.deepEqual(storedPins(storage, OLD_KEY), [PIN_B], '旧 key 不应被读取后删除/覆盖')
  assert.deepEqual(storage.calls.set, [], '已有新 key 时不再写回')
  assert.deepEqual(storage.calls.remove, [], '已有新 key 时不删除旧 key')
})

test('只有旧 key → 迁移到新 key，并删除旧 key', () => {
  const storage = fakeStorage({ [OLD_KEY]: JSON.stringify([PIN_A, PIN_B]) })

  const pins = loadPersistedPins(storage)

  assert.deepEqual(pins, [PIN_A, PIN_B], '旧 key 的数据应被读出')
  assert.deepEqual(storedPins(storage, NEW_KEY), [PIN_A, PIN_B], '应写回新 key 等价数据')
  assert.equal(storage.getItem(OLD_KEY), null, '写回成功后应删除旧 key')
  assert.deepEqual(storage.calls.set, [NEW_KEY], '只写新 key')
  assert.deepEqual(storage.calls.remove, [OLD_KEY], '只删旧 key')
})

test('两者都有 → 以新为准，旧 key 保留', () => {
  const storage = fakeStorage({
    [NEW_KEY]: JSON.stringify([PIN_A]),
    [OLD_KEY]: JSON.stringify([PIN_B]),
  })

  const pins = loadPersistedPins(storage)

  assert.deepEqual(pins, [PIN_A])
  assert.equal(storage.getItem(OLD_KEY), JSON.stringify([PIN_B]), '旧 key 不得被覆盖或删除')
})

test('新 key 为空数组 → 视为有效空列表，不回头迁移旧 key', () => {
  const storage = fakeStorage({
    [NEW_KEY]: '[]',
    [OLD_KEY]: JSON.stringify([PIN_B]),
  })

  const pins = loadPersistedPins(storage)

  assert.deepEqual(pins, [], '用户已清空的列表不能被旧值复活')
  assert.equal(storage.getItem(OLD_KEY), JSON.stringify([PIN_B]), '旧 key 不动')
})

test('旧值损坏 → 返回空列表且保留旧 key', () => {
  const corruptValues = [
    'not-json',
    '{"owner":"grape-dev"}',
    JSON.stringify([{ owner: 'grape-dev', repo: 'grape-dsh' }]),
    JSON.stringify([{ ...PIN_A, owner: '' }]),
  ]

  for (const legacy of corruptValues) {
    const storage = fakeStorage({ [OLD_KEY]: legacy })

    const pins = loadPersistedPins(storage)

    assert.deepEqual(pins, [], `非法旧值（${legacy}）应按空列表处理`)
    assert.equal(storage.getItem(OLD_KEY), legacy, '非法旧值应保留，不删除')
    assert.equal(storage.getItem(NEW_KEY), null, '非法旧值不应写回新 key')
  }
})

test('写回新 key 失败 → 返回旧数据且保留旧 key', () => {
  const storage = fakeStorage({ [OLD_KEY]: JSON.stringify([PIN_A]) }, { failSet: true })

  const pins = loadPersistedPins(storage)

  assert.deepEqual(pins, [PIN_A], '写回失败也要让本次会话看到旧数据')
  assert.equal(storage.getItem(OLD_KEY), JSON.stringify([PIN_A]), '写回失败不得删除旧 key')
  assert.deepEqual(storage.calls.remove, [], '未成功写回前不得删除旧 key')
})

test('无 storage（Node / 非浏览器）→ 直接返回空列表', () => {
  assert.deepEqual(loadPersistedPins(null), [])
  assert.deepEqual(loadPersistedPins(undefined), [])
})

test('旧存档里的数字编号归一为字符串（Issue #39）', () => {
  const storage = fakeStorage({
    [NEW_KEY]: JSON.stringify([{ owner: 'gitee', repo: 'hello', number: 42, title: 'legacy', pinnedAt: 1 }]),
  })

  const pins = loadPersistedPins(storage)

  assert.equal(pins[0].number, '42', '数字编号应归一为字符串，旧存档不丢失')
})

test('编号为 "0" / 空 / 缺失 / 非法的存档视为损坏（不产生 0 假编号）', () => {
  // `a b` / `../x` 是复审实测过的漏网形态：只判「非空且非 "0"」会放行它们（Issue #39 复审）
  for (const bad of ['0', 0, '', null, undefined, 'a b', '../x', 'a.b']) {
    const storage = fakeStorage({
      [NEW_KEY]: JSON.stringify([{ owner: 'o', repo: 'r', number: bad, title: 'x', pinnedAt: 1 }]),
    })
    assert.deepEqual(loadPersistedPins(storage), [], `编号 ${String(bad)} 不应成为合法 pin`)
  }
})

test('Gitee 字母数字编号可持久化并读回', () => {
  const storage = fakeStorage({ [NEW_KEY]: JSON.stringify([PIN_B]) })
  assert.deepEqual(loadPersistedPins(storage), [PIN_B])
})
