/**
 * 侧栏 Tab 的"打开/切换"控制（client 侧）。
 *
 * 与 store 分离的原因：这里需要 client ctx（含 ctx.sidebarRight），
 * 而 store 要保持纯净可测。apply() 时通过 bindCtx() 注入。
 */

import { isManualPaused, markOpened, noteManualAction, hasOpened } from './store.js'

/** 我们注册的侧栏 Tab kind（与 index.tsx 的注册一致） */
export const GRAPE_TAB_KIND = 'grape-focus'

/** 侧栏 Tab 的实现 id（全局唯一） */
export const GRAPE_TAB_ID = '@grape-dev/grape-dsh/focus'

interface SidebarRightLike {
  openTab?: (kind: string, options?: Record<string, unknown>) => unknown
  isExpanded?: () => boolean
  /** 活动 Tab 的记录（字段名见下方 activeIsOurs 的兜底） */
  active?: () => unknown
}

let clientCtx: { sidebarRight?: SidebarRightLike } | null = null

/** apply() 时注入 client ctx */
export function bindCtx(ctx: unknown): void {
  clientCtx = ctx as { sidebarRight?: SidebarRightLike }
}

/** 在侧栏内置浏览器 Tab 里打开 URL（逃生舱用；未启用 sidebar-browser 时静默失败） */
export function openInSidebarBrowser(url: string): void {
  if (!url) return
  const sr = clientCtx?.sidebarRight
  if (!sr || typeof sr.openTab !== 'function') return
  try {
    sr.openTab('browser', { params: { url } })
  } catch { /* sidebar-browser 未启用 */ }
}

/** 取 apply 注入的 client ctx（服务访问必须经用户自己的 fiber ctx） */
export function getClientCtx(): unknown {
  return clientCtx
}

/** 用户手动操作侧栏 Tab 时调用 → 暂停自动跟随 */
/**
 * 在右栏打开一个【终端 Tab】（E：本机接入用）。
 *
 * 终端 Tab 的类型与参数契约由官方 sidebar-terminal 提供：
 *   SidebarRightTabParamsMap.terminal = { terminalId: WebTerminalId } | { shellPath: string }
 * 所以这里传 { terminalId }。官方终端插件自己也是这么开的
 * （读它 client half 得到：openTab("terminal", { terminalId })）。
 *
 * 返回是否成功：侧栏不可用/类型未注册时 false，由调用方决定提示文案，
 * 不在这里吞掉失败（与 openInSidebarBrowser 的静默降级不同 —— 这条是用户
 * 刚点了按钮的主动作，必须给反馈）。
 */
export function openTerminalTab(terminalId: string): boolean {
  const sr = clientCtx?.sidebarRight
  if (!sr || typeof sr.openTab !== 'function') return false
  try {
    // ⚠️ 实测踩过的坑（2026-10-26）：**类型参数必须嵌在 `params` 下**。
    //    平铺写 { terminalId } 会被忽略 → 侧栏会另开一个新终端（而不是挂到我们那个）。
    //    官方终端插件自己的写法即：openTab("terminal", { replaceTab: true, params: { shellPath } }).
    sr.openTab('terminal', { params: { terminalId } })
    return true
  } catch {
    return false
  }
}

export function onUserManualAction(): void {
  noteManualAction()
}

/** 连续失败计数——降级用（避免每次工具结果都抛错刷屏） */
let openFailures = 0
/** 超过该次数就不再尝试自动导航（侧栏不可用 → 永久降级） */
const MAX_OPEN_FAILURES = 3

/**
 * 判断当前活动 Tab 是不是我们自己的。
 *
 * TabRecord 的确切字段名未在公开类型里暴露（见 service.d.ts 的 `active()`），
 * 这里按常见字段名逐个比对，再退化为序列化包含判断。
 *
 * @returns true=是我们的；false=不是（用户切走了）；undefined=读不到（无活动 Tab）
 */
function activeIsOurs(sr: SidebarRightLike): boolean | undefined {
  if (typeof sr.active !== 'function') return undefined
  try {
    const rec = sr.active()
    if (!rec) return undefined
    const obj = rec as Record<string, unknown>
    for (const field of ['id', 'tabId', 'kind', 'type', 'pageId', 'contentId']) {
      const v = obj[field]
      if (typeof v === 'string' && (v === GRAPE_TAB_ID || v === GRAPE_TAB_KIND)) return true
    }
    const s = JSON.stringify(obj)
    return s.includes(GRAPE_TAB_ID) || s.includes(GRAPE_TAB_KIND)
  } catch {
    return undefined
  }
}

/**
 * 焦点到来时打开 / 切换侧栏 Tab。
 *
 * 决策 3：AI 首次操作后才出现 → 未打开过时 openTab（新建并展开）
 * 决策 4：折叠时自动展开 → 已打开且是我们的 Tab 时 openTab 会展开
 * 决策 9：不抢用户视线 → 用户切到别的 Tab 后，只更新内容不抢焦点
 *
 * 降级：侧栏不可用（未启用 sidebarRight / 老版本 / kind 未注册）时静默跳过，
 *       连续失败超阈值后彻底停止尝试（不刷错误）。
 *
 * @param focus 当前焦点
 * @param isNewFocus 是否是新目标（同目标重复轮询不算）
 */
export function autoOpenOrSwitch(): void {
  // 两个入参（focus / isNewFocus）已移除：焦点卡删掉后它们本就一直被 `void` 丢弃，
  // 调用方为了凑参数还得**伪造一个空焦点对象**，纯属噪音。
  // 判断依据只剩下面这三条。
  if (openFailures >= MAX_OPEN_FAILURES) return       // 已降级
  if (isManualPaused()) return                        // 用户手动操作中，静默

  const sr = clientCtx?.sidebarRight
  if (!sr || typeof sr.openTab !== 'function') return // 侧栏不可用 → 降级

  // 已打开过：只有当我们的 Tab 还是活动 Tab（或读不到）时才跟随，
  // 用户主动切走（activeIsOurs === false）就只更新内容，不抢焦点。
  if (hasOpened() && activeIsOurs(sr) === false) return

  try {
    sr.openTab(GRAPE_TAB_KIND, {})
    markOpened()
    openFailures = 0
  } catch {
    // 侧栏不可用 / kind 未注册 / 无活动 Session → 静默降级
    openFailures += 1
  }
}