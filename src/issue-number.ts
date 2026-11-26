/**
 * issue 编号口径单点 —— 校验 / 归一 / 引用反解 / 模型文本（Issue #39）。
 *
 * 为什么要有它：issue 编号是**平台相关的不透明标识**，不是整数。
 *   · GitCode / GitHub / GitLab：整数（`32`），投影时 `String(v)` 归一；
 *   · Gitee：字母数字字符串（`IKXR3B`），大小写敏感；
 *   · `"0"` 是 Gitee `parent_issue_number` 的「非子任务」占位值，**不是编号**。
 *
 * 同一个白名单原先散在四处（宿主投影与路由、pins 存档、预览选择，以及客户端 `@` 引用
 * 反解与创建后自动 pin 各内联一份正则），任何一处放宽/收紧都会漏改 —— 这正是 Issue #39
 * 复审要求收敛的架构问题。本模块是该口径的**唯一**定义点，`test/issue-number.test.mjs`
 * 用源码扫描守护「仓库内只出现一次」。
 *
 * 纯模块：不 import 任何 React / DOM / Node 内置，宿主与客户端 bundle 都能直接用，
 * 也因此能被 `node:test` 直接覆盖（客户端文件不进 `lib/`，无法单独 import）。
 */

/**
 * 编号白名单：首字符必须字母数字（挡 `-1` 这类会被 CLI 当成 flag 的值），
 * 其余允许字母数字 / `_` / `-`，总长 ≤ 32。不含空格、`/`、`.`、引号等元字符。
 */
export const ISSUE_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/**
 * 编号校验（**唯一**口径）：白名单 **且** 不是 Gitee 的 `"0"` 占位。
 * 宿主路由参数、pins 写入/存档、预览候选、`@` 引用反解全部走这一个函数。
 */
export function isValidIssueNumber(v: string): boolean {
  return v !== '0' && ISSUE_NUMBER_RE.test(v)
}

/**
 * 编号归一：数字/字符串统一转字符串（GitCode 的整数也变 `"32"`，去首尾空白）。
 * 缺失 / 空 / `"0"` / 非法形态一律返回 `''` —— 绝不产生 `0` 假编号。
 */
export function normalizeIssueNumber(v: unknown): string {
  const s =
    typeof v === 'string' ? v.trim()
      : typeof v === 'number' && Number.isFinite(v) ? String(v)
        : ''
  return isValidIssueNumber(s) ? s : ''
}

/** 一条 issue 引用的身份（owner/repo/number 全部为归一后的字符串） */
export interface IssueRef {
  owner: string
  repo: string
  number: string
}

/**
 * `owner/repo#<编号>` 形态的引用（`@` 胶囊的 ref / clipboardText）。
 * 编号段与白名单同源；仓库段只排除 `/` 与 `#`，因此 `my-org/my_repo` 也成立。
 */
const ISSUE_REF_RE = /^(.+?)\/([^/#]+)#([A-Za-z0-9][A-Za-z0-9_-]{0,31})$/

/**
 * 反解 `@` 引用的 ref。解析不出（pin 已取消但引用还留在输入框、用户手写错）返回 `null`，
 * 由调用方降级 —— 这里的 `null` 不代表错误，只代表「这条 ref 不携带可用身份」。
 */
export function parseIssueRef(ref: string): IssueRef | null {
  if (!ref) return null
  const m = ISSUE_REF_RE.exec(ref)
  if (!m) return null
  const owner = m[1]
  const repo = m[2]
  const number = m[3]
  if (!owner || !repo || !isValidIssueNumber(number)) return null
  return { owner, repo, number }
}

/** XML 属性转义（标题里可能有 `"` `&` `<`，不转义会让标签坏掉） */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** `@` 引用可携带的已知身份（来自本地 pin；可能已失效或被取消） */
export interface IssueRefView {
  owner?: string
  repo?: string
  number?: string
  platform?: string
  title?: string
}

/**
 * 把一条 issue 引用序列化成**模型侧文本**（33 个工具的 owner/repo/number 参数直接对齐）。
 *
 * ⚠️ **本函数绝不抛错、绝不返回空串**。dsh 契约规定 codec.serialize 失败会**阻止整条
 * 消息发送**（"failure blocks the send — never a silent downgrade"），所以解析不了的 ref
 * 必须退化成可读文本 —— 宁可文本不完美，也不能让用户发不出消息。
 *
 * 输出形如：
 *   <grape-issue repo="wdmike/snake-game-9" number="3" platform="gitcode" title="probe-confirm-test"/>
 */
export function formatIssueRefForModel(ref: string, known?: IssueRefView): string {
  try {
    const parsed = parseIssueRef(ref)
    const owner = known?.owner || parsed?.owner || ''
    const repo = known?.repo || parsed?.repo || ''
    const number = normalizeIssueNumber(known?.number) || parsed?.number || ''
    if (!owner || !repo || !number) return `[Grape issue ${ref}]`

    const attrs = [
      `repo="${escapeAttr(`${owner}/${repo}`)}"`,
      `number="${number}"`,
      known?.platform ? `platform="${escapeAttr(known.platform)}"` : '',
      known?.title ? `title="${escapeAttr(known.title)}"` : '',
    ].filter(Boolean)
    return `<grape-issue ${attrs.join(' ')}/>`
  } catch {
    // 兜底：任何意外都退化成可读文本，绝不让发送失败
    return `[Grape issue ${ref}]`
  }
}

/**
 * 从工具结果文本里取 issue 编号（创建 issue 成功后自动 pin 用）。
 *
 * `renderActionConfirm` 输出的形态是 `✅ 创建 Issue 完成 #IKXR3B`（编号后可能还有
 * `seq=`/`agent=` 等字段），所以不能要求行尾锚定；但编号右侧必须不是编号字符，
 * 否则超长串会被截断成前 32 位。取到的值仍过一遍归一，`#0` 不会变成 pin。
 */
const TEXT_NUMBER_RE = /#([A-Za-z0-9][A-Za-z0-9_-]{0,31})(?![A-Za-z0-9_-])/

export function extractIssueNumberFromText(text: string): string {
  const m = TEXT_NUMBER_RE.exec(text || '')
  return m ? normalizeIssueNumber(m[1]) : ''
}