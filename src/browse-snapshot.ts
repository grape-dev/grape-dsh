/**
 * 浏览页签首屏的本地快照（纯逻辑，无 React / 浏览器全局依赖）。
 *
 * 目的（Issue #27）：刷新页面/重启宿主后，「仓库」首屏不必等一次完整取数。
 * 模块加载时先从 `localStorage` 还原上一份结果先渲染，后台再 revalidate
 * （stale-while-revalidate），首字节只受 localStorage 读取 + JSON.parse 影响。
 *
 * 存储布局：
 * - 快照：`grape-dsh.browse.v1:{baseUrl}:{account}` → `{ schema, savedAt, data }`
 *   —— baseUrl + 账号分键：切换环境或换账号不会把别人的数据画出来。
 * - 指针：`grape-dsh.browse.latest.v1` → `{ baseUrl, account }`
 *   —— 解决「模块加载时还不知道 baseUrl」的鸡生蛋问题。
 *
 * 失效策略：schema 版本不符 / JSON 损坏 / savedAt 非法 → 一律返回 null（安全失效）。
 * 与 `pins-persist.ts` 一样独立成模块：storage 注入后可被 `node:test` 确定性覆盖。
 */

/** 快照结构版本；字段或语义变化时 +1，旧快照自动失效 */
export const BROWSE_SNAPSHOT_SCHEMA = 1

/** 快照键前缀（含版本，便于将来整体清理旧代数据） */
export const BROWSE_STORAGE_PREFIX = 'grape-dsh.browse.v1'

/** 最近一次快照的指针键 */
export const BROWSE_LATEST_KEY = 'grape-dsh.browse.latest.v1'

/** 只依赖的最小 Storage 接口（浏览器 `localStorage` 天然满足，测试可注入假实现） */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 一份快照 */
export interface BrowseSnapshot {
  schema: number
  savedAt: number
  data: unknown
}

/** 由 latest 指针还原出的快照（含定位信息） */
export interface LatestBrowseSnapshot extends BrowseSnapshot {
  baseUrl: string
  account: string
}

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 快照键（baseUrl + 账号隔离） */
export function snapshotKey(baseUrl: string, account: string): string {
  return `${BROWSE_STORAGE_PREFIX}:${baseUrl}:${account}`
}

/**
 * 解析快照原文。**任何非法形态返回 null**：
 * - 不是 JSON 对象 / 不是对象
 * - `schema` 与当前版本不符
 * - `savedAt` 不是有限数字
 * - 缺少 `data` 字段
 */
export function parseBrowseSnapshot(raw: string | null): BrowseSnapshot | null {
  if (raw === null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  if (o.schema !== BROWSE_SNAPSHOT_SCHEMA) return null
  if (typeof o.savedAt !== 'number' || !Number.isFinite(o.savedAt)) return null
  if (!('data' in o) || o.data === null) return null
  return { schema: BROWSE_SNAPSHOT_SCHEMA, savedAt: o.savedAt, data: o.data }
}

/** 序列化快照（始终带当前 schema 版本） */
export function serializeBrowseSnapshot(data: unknown, savedAt: number): string {
  return JSON.stringify({ schema: BROWSE_SNAPSHOT_SCHEMA, savedAt, data })
}

function read(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

/** 读取某 baseUrl + 账号下的快照（无 / 已失效 → null） */
export function loadBrowseSnapshot(
  storage: StorageLike | null | undefined,
  baseUrl: string,
  account: string,
): BrowseSnapshot | null {
  if (!storage || !baseUrl) return null
  return parseBrowseSnapshot(read(storage, snapshotKey(baseUrl, account)))
}

/**
 * 保存快照并更新 latest 指针。
 *
 * @returns 是否写入成功（配额满 / 隐私模式 / storage 抛错 → false，不影响本次会话）
 */
export function saveBrowseSnapshot(
  storage: StorageLike | null | undefined,
  input: { baseUrl: string; account: string; data: unknown; savedAt?: number },
  now: number = Date.now(),
): boolean {
  if (!storage || !input.baseUrl) return false
  const savedAt = input.savedAt ?? now
  try {
    storage.setItem(snapshotKey(input.baseUrl, input.account), serializeBrowseSnapshot(input.data, savedAt))
    storage.setItem(BROWSE_LATEST_KEY, JSON.stringify({ baseUrl: input.baseUrl, account: input.account }))
    return true
  } catch {
    return false
  }
}

/**
 * 按 latest 指针找回快照：模块加载时 baseUrl/账号尚未知，先用它完成首屏 hydrate。
 * 指针损坏或快照失效 → null（不抛错）。
 */
export function loadLatestBrowseSnapshot(storage: StorageLike | null | undefined): LatestBrowseSnapshot | null {
  if (!storage) return null
  let pointer: unknown
  try {
    pointer = JSON.parse(read(storage, BROWSE_LATEST_KEY) ?? 'null')
  } catch {
    return null
  }
  const p = asObj(pointer)
  const baseUrl = str(p.baseUrl)
  const account = str(p.account)
  if (!baseUrl) return null
  const snap = loadBrowseSnapshot(storage, baseUrl, account)
  if (!snap) return null
  return { ...snap, baseUrl, account }
}