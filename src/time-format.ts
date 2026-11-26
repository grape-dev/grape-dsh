/**
 * 时间展示（浏览器与单测共用）。
 *
 * 事故背景：面板过去直接把 ISO 串 `slice(0, 19).replace('T',' ')` —— 服务端返回的是
 * **UTC**（`2026-11-13T07:07:54.078089+00:00`），截断后当成北京时间显示，于是「最后在线」
 * 永远少 8 小时。这里统一走一次真正的时区换算：
 *
 *   ① 字符串没有 `Z` 也没有 `±HH:MM` 偏移 → 视为 UTC（服务端历史数据就是这么写的），补 `Z`；
 *   ② 用 `Intl.DateTimeFormat` 按目标时区渲染（默认浏览器时区）；
 *   ③ 无法解析时**原样返回**，宁可显示带时区的原文，也不吞信息。
 */

/** 渲染选项（默认全走浏览器环境：`undefined` = 浏览器 locale / 时区） */
export interface FormatTimeOptions {
  /** BCP 47 语言标签，如 `zh-CN`；默认浏览器 locale */
  locale?: string
  /** IANA 时区，如 `Asia/Shanghai`；默认浏览器时区 */
  timeZone?: string
}

/** 是否已自带时区信息（`Z` 或 `±HH:MM` / `±HHMM`） */
const HAS_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/

/**
 * 把服务端时间串解析成毫秒时间戳（无法解析返回 NaN）。
 *
 * 与 {@link formatTime} 同一口径：**没有 `Z` 也没有 `±HH:MM` 偏移的串按 UTC 解析**。
 * 单独导出是因为「相对时间」（几秒前/几小时前）只需要时间戳，不需要格式化；
 * 直接 `Date.parse` 会把 UTC 串当本地时间，相差正好一个时区（本次「时间显示成 UTC」的直接原因）。
 */
export function parseServerTime(iso: string | null | undefined): number {
  const raw = String(iso ?? '').trim()
  if (!raw) return NaN
  return new Date(HAS_ZONE.test(raw) ? raw : `${raw}Z`).getTime()
}

/**
 * 把服务端 ISO 时间渲染成本地可读时间（`YYYY-MM-DD HH:mm:ss`）。
 *
 * @param iso 服务端时间串（可带或不带时区；不带时区按 UTC 解析）
 * @param opts 语言 / 时区覆盖（单测用；生产不传，取浏览器时区）
 * @returns 本地时间串；空值返回空串；无法解析时原样返回输入
 */
export function formatTime(iso: string | null | undefined, opts: FormatTimeOptions = {}): string {
  const raw = String(iso ?? '').trim()
  if (!raw) return ''
  const ms = parseServerTime(raw)
  if (Number.isNaN(ms)) return raw
  const date = new Date(ms)

  const fmt = new Intl.DateTimeFormat(opts.locale || undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: opts.timeZone || undefined,
  })
  const parts = fmt.formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  // 部分 locale 用 24 表示午夜（`24:00:00`）：归一成 00 点，避免「24:00」这种不存在的写法
  const hour = part('hour') === '24' ? '00' : part('hour')
  return `${part('year')}-${part('month')}-${part('day')} ${hour}:${part('minute')}:${part('second')}`
}