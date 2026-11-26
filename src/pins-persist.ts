/**
 * 「观察列表」本地存档的读写与改名迁移 —— 纯逻辑，无 React / 浏览器全局依赖。
 *
 * Issue #15 把包名从 `@grape-dev/dsh-grape` 改为 `@grape-dev/grape-dsh`，pins 的
 * localStorage key 也随之由 `dsh-grape.pins.v1` 变为 `grape-dsh.pins.v1`。升级后旧 key
 * 里的钉住列表不能凭空消失，因此读取时做一次性兜底：
 *
 * - 新 key 有值 → 以新 key 为准（哪怕是空数组：用户主动清空的结果不能被旧值复活）；
 * - 仅旧 key → 解析出有效列表后才写回新 key，**写回成功后**才删除旧 key；
 * - 旧值非法（JSON 解析失败 / 不是数组 / 结构不符）→ 按空列表处理，且保留旧 key 留证；
 * - 写回失败 → 本次仍返回旧数据，旧 key 不删（绝不制造数据丢失）。
 *
 * 独立成模块的理由与 `follow-window.ts` 相同：`pins-store.ts` 依赖 React 与浏览器全局，
 * 无法在 `node:test` 里直接跑；把 key 常量、解析与迁移抽成 storage 注入的纯函数后，
 * 迁移语义可以被确定性覆盖，`pins-store.ts` 只负责传入 `localStorage` 并组装成 `Pin`。
 */

import { normalizeIssueNumber } from './issue-number.js'

/** 当前存储 key（改名后的新 key） */
export const PINS_STORAGE_KEY = 'grape-dsh.pins.v1'

/** 改名前的旧 key：仅用于一次性迁移读取 */
export const LEGACY_PINS_STORAGE_KEY = 'dsh-grape.pins.v1'

/** 存档里只存**身份**，不存会过期的流水线数据 */
export interface PersistedPin {
  owner: string
  repo: string
  /** Issue 编号（字符串；旧存档里的数字会在读取时归一，Issue #39） */
  number: string
  title: string
  platform?: string
  pinnedAt: number
}

/** 只依赖的最小 Storage 接口（浏览器 `localStorage` 天然满足，测试可注入假实现） */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/**
 * 解析存档。**任何非法形态都返回 null**（而非空数组），让调用方区分
 * 「没有存档 / 存档坏了」与「存的是空列表」：后者是有效状态，迁移时应当写回并清理旧 key。
 */
export function parsePersistedPins(raw: string | null): PersistedPin[] | null {
  if (raw === null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const pins: PersistedPin[] = []
  for (const item of parsed) {
    const v = asObj(item)
    const owner = str(v.owner)
    const repo = str(v.repo)
    const number = normalizeIssueNumber(v.number)
    if (!owner || !repo || !number) return null
    const platform = str(v.platform)
    const pin: PersistedPin = {
      owner,
      repo,
      number,
      title: str(v.title),
      pinnedAt: num(v.pinnedAt) ?? Date.now(),
    }
    if (platform) pin.platform = platform
    pins.push(pin)
  }
  return pins
}

function read(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

/**
 * 读取观察列表存档，并在需要时把旧 key 的数据迁移到新 key。
 *
 * `storage` 为空（Node 侧单测 / 非浏览器环境）时直接返回空列表，不触碰任何存储。
 */
export function loadPersistedPins(storage?: StorageLike | null): PersistedPin[] {
  if (!storage) return []

  const current = read(storage, PINS_STORAGE_KEY)
  if (current !== null) return parsePersistedPins(current) ?? []

  const legacy = read(storage, LEGACY_PINS_STORAGE_KEY)
  if (legacy === null) return []

  const migrated = parsePersistedPins(legacy)
  if (migrated === null) return []   // 旧值非法：留证，不删除、不覆盖

  try {
    storage.setItem(PINS_STORAGE_KEY, JSON.stringify(migrated))
  } catch {
    return migrated                 // 写回失败：保留旧 key，本次仍用迁移结果
  }
  try {
    storage.removeItem(LEGACY_PINS_STORAGE_KEY)
  } catch {
    // 删除失败最多导致下次再迁一次（新 key 已写好，下次直接走新 key），不影响数据
  }
  return migrated
}