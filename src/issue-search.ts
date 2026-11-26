/**
 * Issue #41：issue 搜索词（平台 `q`）的归一、校验与缓存键段。
 *
 * 为什么单独成文件：宿主 `/issues` 的参数校验与前端 `browse-store` 的视图键
 * 必须共用同一份口径 —— 前端键里合法的词，宿主不能再判非法；反之亦然。
 * 纯函数、无运行时依赖，单测直接覆盖。
 */

/** 搜索词长度上限（字符数，含内部空格）。超过则拒绝，避免把超长串塞进 argv/缓存键 */
export const ISSUE_SEARCH_Q_MAX = 64

/** 搜索结果每页条数（只用于搜索；普通列表保持 CLI 默认，行为不变） */
export const ISSUE_SEARCH_PER_PAGE = 50

/** C0 / DEL / C1 控制字符：会污染 argv、缓存键与日志，一律拒绝 */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/

/**
 * 前导 `#` 仅在紧跟编号字符时剥离（Issue #41 复审 Required #1）。
 *
 * 占位符引导用户输入「#编号」，但平台 `q` 是字面匹配：实测 `q=#4341` → 0 条、
 * `q=4341` → #4341。`#` 只是用户心智里的编号前缀，不是平台检索词的一部分。
 * 编号字符沿用 `issue-number.ts` 的口径（字母 / 数字；Gitee 字母数字编号同样适用），
 * 因此 `# 4341`（`#` 后是空格）与孤立的 `#` 保持原样。
 */
const LEADING_HASH_RE = /^#(?=[A-Za-z0-9])/

/** 归一搜索词：去首尾空白 + 剥离前导 `#`；非字符串 / 只有空白 → 空串（= 不搜索） */
export function normalizeIssueSearchQ(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(LEADING_HASH_RE, '')
}

/**
 * 校验**已归一**的搜索词。
 *
 * 空串合法（= 不搜索）；超长、含控制字符、以 `-` 开头（会被 CLI 当成 flag，
 * 属于参数走私）→ false。
 */
export function isValidIssueSearchQ(q: string): boolean {
  if (!q) return true
  if (q.length > ISSUE_SEARCH_Q_MAX) return false
  if (CONTROL_CHAR_RE.test(q)) return false
  return !q.startsWith('-')
}

/**
 * 视图键 / 缓存键的搜索段。
 *
 * 空 q 返回空串：**默认列表保持旧键形态**，首页与实时页预览的缓存语义不变；
 * 非空 q 编码后入键（分隔符不会串味），第 2 页起再追加 page 段。
 */
export function issueSearchKeySuffix(q: string, page = 1): string {
  // 键也走归一：`#4341` 与 `4341` 必须落到同一个搜索视图，否则前端订阅键与
  // `ensureIssuesLoaded` 的取数键会错位（复审 Required #1 的连带问题）。
  const term = normalizeIssueSearchQ(q)
  if (!term) return ''
  const p = Number.isFinite(page) && page > 1 ? `:p=${Math.trunc(page)}` : ''
  return `:q=${encodeURIComponent(term)}${p}`
}
