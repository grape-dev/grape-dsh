/**
 * grape-dsh client half —— 浏览器侧入口。
 *
 * 注册四样东西（见 SIDEBAR-AUTO-NAV-DESIGN.md）：
 *   1. 侧栏 Tab 类型 + body（Grape 实时观察窗）           — P4（含 guide 入口）
 *   2. 每个 grape 工具的 toolview（观察结果里的焦点）      — P3
 *   3. 配置页（plugins.bundle.config）                    — P10
 *   4. 配置页（settings.section，Settings 里的独立一页）   — 借鉴 dsh-jenkins-plugin
 *
 * 打包格式由 scripts/build-client.mjs 包裹成 dsh 的
 * `window.__ModuleLoader__.load({ id, factory })` envelope。
 *
 * 注意：注册 toolview 会**接管工具行渲染**（dsh 文档：occupied key replaces
 * its view），所以 GrapeToolView 必须自己渲染卡片。
 */

import { GrapeToolView } from './GrapeToolView.js'
import { GrapeTab } from './GrapeTab.js'
import { GrapeConfigPanel } from './GrapeConfigPanel.js'
import { bindCtx, GRAPE_TAB_ID, GRAPE_TAB_KIND } from './panel-control.js'
import { registerGrapeTheme, bindGrapeTheme, GRAPE_THEME_ID } from './grape-theme.js'
import { registerGrapeBrand } from './grape-brand.js'
import { registerGrapeMention } from './grape-mention.js'
import { GRAPE_TOOL_NAMES } from '../tool-names.js'
import { resumeTakeoverAfterReload, setApiSessionCreator, tkLog } from './takeover-switch.js'
import { setApiSessionStopper } from './session-ctl.js'

/** 依赖的客户端服务（服务名，不是包名）。theme 用于注册 Grape 主题。 */
export const inject: string[] = ['slots', 'sidebarRightTabs', 'sidebarRight', 'configForms', 'theme', 'sessions']

interface SlotRegistry {
  inject: (name: string, register: () => unknown) => unknown
  register: (options: Record<string, unknown>, component: unknown) => unknown
}

/**
 * 页面加载时接着做完接管。
 *
 * 为什么需要它：`workspaceRegistry.create()` 不会让前端侧栏重渲染，
 * 点接管时新 workspace 往往还不在 DOM 里 → switchToTakeoverWorkspace
 * 找不到行，会 reload 一次；reload 后由这里接着找行、开会话、发 prompt。
 */
function resumePendingTakeover(logger?: { info?: (m: string) => void; warn?: (m: string) => void }): void {
  resumeTakeoverAfterReload(logger)
}

interface TabTypeRegistry {
  register: (definition: Record<string, unknown>) => () => void
}

interface EffectCtx {
  effect: (fn: () => unknown, name?: string) => unknown
}

interface SessionsClientService {
  create(opts: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<string>
  using<T>(id: string, opts: { source: string }, op: (ref: {
    binding?: {
      session?: {
        prompt: (content: Array<{ type: 'text'; text: string }>, mode: 'queue' | 'steer') => Promise<{ ok?: boolean; error?: { code?: string } } | undefined>
        /** 停止当前这一轮（会话本身保留在列表里，可回看） */
        cancel?: () => Promise<{ ok?: boolean; error?: { code?: string; message?: string } | string } | undefined>
        getSnapshot?: () => { running?: boolean } | undefined
      }
    }
  }) => Promise<T>): Promise<T>
}

interface ClientCtx extends EffectCtx {
  sessions?: SessionsClientService
  slots: SlotRegistry
  sidebarRightTabs: TabTypeRegistry
  sidebarRight?: { openTab?: (kind: string, options?: Record<string, unknown>) => unknown }
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }
}

const TAB_LABEL = 'Grape'
/** 本包的 npm 名（`plugins.bundle.config` 槽位的 key 就是这个） */
const GRAPE_PACKAGE_NAME = '@grape-dev/grape-dsh'
/**
 * `settings.section` 槽位的 section id。
 *
 * 该槽位是 **list** 类型（用 `id` 不是 `key`）：取一个自己的 id 会在官方
 * General/Models/Account 旁边**新增**一页；复用官方 id 则会替换它。
 * order：官方取值为 account -10 / general 0 / models 10 / agent-presets 20，
 * 我们排在它们之后。
 */
const GRAPE_SETTINGS_SECTION_ID = 'grape'
const GRAPE_SETTINGS_SECTION_ORDER = 40

/**
 * 客户端插件入口。bundle 被 dsh 物化时调用。
 *
 * @param ctx 客户端根 context
 */
export function apply(ctx: unknown): void {
  const c = ctx as ClientCtx

  // 让逃生舱按钮 / 自动开 Tab 能拿到 ctx
  bindCtx(ctx)

  c.logger?.info?.('[grape-dsh] client half applying')

  // ── 0-before. 接管后的续接：把暂存的 prompt 发进刚切过去的会话 ──
  //  流程：点接管 → 宿主侧在任务 cwd 上建新 session → 前端写
  //  localStorage['dsh.sessions.current'] 并刷新 → 这里把 prompt 送出去。
  //  prompt 存在 sessionStorage（刷新后仍在），取出后立刻删除，避免重复发送。
  //  ⚠️ 必须延后一拍：它走 API 建会话依赖下面第 0-before-2 段的 setApiSessionCreator，
  //  直接同步调用会在注入之前执行 → 退回 DOM 阶梯，中文界面下必然等超时。
  setTimeout(() => resumePendingTakeover(c.logger), 0)

  // ── 0-before-2. 会话创建走 dsh 接口（不模拟点击）──
  //  ctx.sessions.create({workspaceId})  → 落盘 + 绑定 workspace 的 session-<uuid>
  //  sessions.using(id).binding.session.prompt([...]) → 首条消息进 agent 收件箱
  //  失败则 takeover-switch 自动回退到旧的 UI 阶梯（并记录 api_session_failed）。
  try {
    const sessions = c.sessions
    if (sessions && typeof sessions.create === 'function' && typeof sessions.using === 'function') {
      setApiSessionCreator(async (workspaceId: string, prompt: string) => {
        const sid = await sessions.create({ workspaceId })
        await sessions.using(sid, { source: 'grapeTakeover' }, async (ref) => {
          const result = await ref?.binding?.session?.prompt([{ type: 'text', text: prompt }], 'queue')
          if (result && result.ok === false) {
            throw new Error(`prompt 被拒绝: ${result.error?.code || 'unknown'}`)
          }
        })
        return sid
      })
      c.logger?.info?.('[grape-dsh] takeover: dsh sessions API ready (create+prompt, no UI automation)')
      // 把「客户端会话 API 是否可用」回传到宿主控制台（/grape-worker-api/takeover-log，仅 log，不落盘）
      tkLog('sessions_api', { ready: true })
    } else {
      c.logger?.warn?.('[grape-dsh] takeover: ctx.sessions unavailable, keep UI fallback')
      tkLog('sessions_api', { ready: false, keys: c.sessions ? Object.keys(c.sessions as object) : null })
    }
  } catch (err) {
    c.logger?.warn?.(`[grape-dsh] takeover: sessions API wiring failed: ${String(err)}`)
    tkLog('sessions_api_failed', { error: String(err) })
  }

  // ── 0-before-3. 接管结束后停掉这次接管新建的会话 ──
  //  会话对象只在前端，`Session.cancel()` 即「停止当前这一轮」（会话留在列表里可回看）。
  //  只在面板点「确认完成 / 放弃接管」且用户二次确认后调用；失败只提示，绝不改写平台结果。
  try {
    const sessions = c.sessions
    if (sessions && typeof sessions.using === 'function') {
      setApiSessionStopper(async (sessionId: string) => {
        // 先看有没有「在跑的这一轮」：已经跑完时 cancel() 可能返回 ok:false，
        // 那不是失败，面板不该提示「停止会话失败」。
        let idle = false
        try {
          await sessions.using(sessionId, { source: 'grapeTakeover' }, async (ref) => {
            const session = ref?.binding?.session
            if (!session) throw new Error('会话不存在或已关闭')
            if (typeof session.getSnapshot === 'function') {
              try {
                if (session.getSnapshot()?.running === false) {
                  idle = true
                  return
                }
              } catch { /* 注入实现读不到快照就按「未知」处理，照常 cancel */ }
            }
            if (typeof session.cancel !== 'function') throw new Error('当前 DSH 版本不支持停止会话')
            const r = await session.cancel()
            if (r && r.ok === false) {
              const e = r.error
              const code = typeof e === 'string' ? e : (e?.code || e?.message || '')
              throw new Error(code ? `cancel 被拒绝: ${code}` : 'cancel 被拒绝')
            }
          })
        } catch (err) {
          tkLog('stop_session_failed', { sessionId, error: String(err) })
          throw err
        }
        if (idle) {
          tkLog('stop_session_idle', { sessionId })
          return { ok: true, message: '接管会话已空闲（这一轮已结束），无需停止' }
        }
        tkLog('stop_session_ok', { sessionId })
        return { ok: true, message: '接管会话已停止（会话仍在列表里，可回看）' }
      })
      c.logger?.info?.('[grape-dsh] takeover: session stopper ready (cancel on finish/abort)')
    }
  } catch (err) {
    c.logger?.warn?.(`[grape-dsh] takeover: session stopper wiring failed: ${String(err)}`)
  }

  // ── 0. Grape 主题：注册进 registry + 由配置开关驱动覆盖层 ──
  //  register 只入册（官方外观行写死三选一，选不到）；
  //  bind 用 overrideTokens 叠加，config.grapeTheme 一开即生效、一关即还原。
  try {
    c.effect(() => registerGrapeTheme(ctx), 'grape-dsh.theme-register')
    c.effect(() => bindGrapeTheme(ctx), 'grape-dsh.theme-bind')
    c.logger?.info?.(`[grape-dsh] grape theme ready ('${GRAPE_THEME_ID}', 由 config.grapeTheme 开关驱动)`)
  } catch (err) {
    c.logger?.warn?.(`[grape-dsh] theme wiring failed: ${String(err)}`)
  }

  // ── 0b. Grape 品牌位（侧栏标记/名称 + 空会话首屏标记）──
  //  无条件替换 dsh 原生品牌（品牌是插件身份，不跟主题开关）；卸载即还原。
  try {
    registerGrapeBrand(ctx)
    c.logger?.info?.('[grape-dsh] brand slots registered (sidebar mark/name + hero mark)')
  } catch (err) {
    c.logger?.warn?.(`[grape-dsh] brand registration failed: ${String(err)}`)
  }

  // ── 0c. `@` 引用已跟随的 issue（对话输入框里的提及源）──
  //  用可选依赖注册：没有 inputTriggers 的部署（headless）里插件照常加载，只是少一个菜单。
  try {
    registerGrapeMention(ctx as Parameters<typeof registerGrapeMention>[0])
    c.logger?.info?.('[grape-dsh] @ issue mention source registered')
  } catch (err) {
    c.logger?.warn?.(`[grape-dsh] mention registration failed: ${String(err)}`)
  }

  // ── 1. 侧栏 Tab 类型（page 类型：无 patterns，按 kind 打开）──
  try {
    c.effect(() => c.sidebarRightTabs.register({
      id: GRAPE_TAB_ID,
      kind: GRAPE_TAB_KIND,
      priority: 'extension',   // 第三方扩展（非 builtin）
      multiple: false,         // 单 Tab 常驻，焦点切换而非多开
      title: () => TAB_LABEL,
      keepMounted: true,       // 切换 Session/折叠后保留面板体，避免重挂
      // guide：在侧栏「引导页」放一个入口盒，用户可**主动**打开本面板。
      // 没有它，面板只能等 AI 先调工具才出现（用户找不到的地方 → 官方原话：
      // "where a user looks for a column that has no tab of this type open yet"）。
      guide: [{
        id: `${GRAPE_TAB_KIND}-open`,
        order: 60,
        title: () => TAB_LABEL,
        description: () => '查看 AI 操作过的 Grape 流水线、事件与仓库概览',
      }],
    }), 'grape-dsh.focus-tab-type')
  } catch (err) {
    c.logger?.warn?.(`[grape-dsh] sidebar tab type registration failed: ${String(err)}`)
  }

  // ── 2. Tab body（外壳：同一 Tab 内「实时 / 浏览」切换）──
  try {
    c.slots.inject('sidebar.right.pane.tab', () => c.slots.register({
      name: 'sidebar.right.pane.tab',
      key: GRAPE_TAB_ID,
    }, GrapeTab))
  } catch (err) {
    c.logger?.warn?.(`[grape-dsh] sidebar tab body registration failed: ${String(err)}`)
  }

  // ── 3. 配置页：plugins.bundle.config（keyed by 包名，藏在插件详情页）──
  try {
    c.slots.inject('plugins.bundle.config', () => c.slots.register({
      name: 'plugins.bundle.config',
      key: GRAPE_PACKAGE_NAME,
    }, GrapeConfigPanel))
  } catch (err) {
    console.warn(`[grape-dsh] config panel registration failed: ${String(err)}`)
  }

  // ── 4. 配置页：settings.section（Settings 里的独立一页，好找）──
  // 该槽位是 list/root：用 `id` 而非 `key`，`label` 是导航文案，
  // `order` 决定在 General/Models/Account 之间的位置。
  try {
    c.slots.inject('settings.section', () => c.slots.register({
      name: 'settings.section',
      id: GRAPE_SETTINGS_SECTION_ID,
      order: GRAPE_SETTINGS_SECTION_ORDER,
      label: 'Grape',
    }, GrapeConfigPanel))
  } catch (err) {
    console.warn(`[grape-dsh] settings section registration failed: ${String(err)}`)
  }

  // ── 5. 每个 grape 工具的 toolview（按工具名 keyed）──
  for (const toolName of GRAPE_TOOL_NAMES) {
    try {
      c.slots.inject('tool.call.toolview', () => c.slots.register({
        name: 'tool.call.toolview',
        key: toolName,
      }, GrapeToolView))
    } catch (err) {
      c.logger?.warn?.(`[grape-dsh] toolview registration failed for ${toolName}: ${String(err)}`)
    }
  }

  c.logger?.info?.(`[grape-dsh] client half applied (${GRAPE_TOOL_NAMES.length} toolviews + 1 sidebar tab)`)
}