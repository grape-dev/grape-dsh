/**
 * Grape 主题 —— 把 dsh 的界面换成 Grape 的视觉语言。
 *
 * ── 配色来源 ──
 * 品牌色取自 Grape 官网 `/root/grape-website/index.html` 的 `:root`（权威）：
 *
 *   --accent #7170ff  --accent-2 #828fff  --grad #5e6ad2 → #828fff
 *   --text #f7f8f8  --text-2 #d0d6e0  --text-3 #8a8f98
 *   品牌紫（葡萄珠/茎）#542667   语义 #10b981 / #f87171 / #f59e0b / #3b82f6
 *
 * 但**底色不用官网的 #08090a 黑** —— 按用户要求改成**半透明淡紫**，
 * 于是整体走浅色：淡紫半透明底 + 深紫黑文字 + 靛紫强调。
 *
 * ── 映射策略（为什么不逐个改 107 个 alias）──
 * dsh 的 static 色板是**明暗同值**的绝对阶（`00`=白 … `1000`=近黑），
 * 而 alias 层几乎全是 `var(--dsw-static-*)` 的引用，所以**重定义 static 阶**
 * （保持明度次序、换 Grape 色相）就能带动全站；剩下的语义底/边框/文字
 * 用显式 token 覆盖成淡紫浅色。
 *
 * ── 方案绑定 ──
 * 覆盖层对 `light`/`dark` 给**同一套值**（淡紫浅色），并在开启时把配色偏好
 * 切到 `light` —— 这样无论用户原本选什么，看到的都是同一套 Grape 淡紫界面。
 * 关闭时撤销覆盖层并还原原偏好。
 *
 * ── 注册方式 ──
 * `ctx.theme.register` 只入册：官方「外观」行写死 light/dark/system 三选一
 * （`THEME_PREFERENCES`），注册的主题在标准 UI 里**选不到**。
 * 真正生效靠 `ctx.theme.overrideTokens(source, { light, dark })` 叠加层。
 *
 * 机制依据：@deepseek-ai/dsh-client-ui-theme。
 */

/**
 * 覆盖层 token 表（`ctx.theme.overrideTokens` 用）：每个 token 必须同时给明暗两值。
 * 对应官方 `ThemeTokenOverrides = Record<string, { light: string; dark: string }>`。
 */
export type ThemeTokenOverrides = Record<string, { light: string; dark: string }>

export const GRAPE_THEME_ID = 'grape'

/**
 * Grape 插件在 profile 里的 cordis entry id。
 *
 * ⚠️ 取配置用的是它，**不是包名**（用包名会得到 `status:'unavailable'`）。
 * 由 cordis.patch.yml 的 `- id: grape-tools` 固定。
 */
export const GRAPE_ENTRY_ID = 'grape-tools'

// ─────────────── 淡紫浅色（用户指定的界面底色，本站唯一视觉入口）───────────────

/** 半透明淡紫界面参数。改这里 = 改整体观感。 */
export const GRAPE_LIGHT = {
  /** 主背景：半透明淡紫 */
  bg: 'rgba(237,231,252,.72)',
  /** 需要更「实」的底（文档预览 / 登录页） */
  bgSolid: 'rgba(240,235,253,.88)',
  layer1: 'rgba(255,255,255,.92)',
  layer2: '#f9f6ff',
  layer3: '#fcfaff',
  /** 侧栏 */
  sidebar: 'rgba(243,238,255,.58)',
  /** 输入框（大） */
  input: 'rgba(255,255,255,.66)',
  /** 浮层（菜单/弹窗/设置面板）：必须够「实」，否则叠在半透明底上会看不清 */
  surfaceSolid: '#f9f6ff',
  surfaceSolidAlt: '#fcfaff',
  /** 消息气泡 */
  bubble: 'rgba(113,112,255,.10)',
  bubbleStrong: 'rgba(113,112,255,.16)',
  codeBlock: 'rgba(255,255,255,.58)',
  codeBanner: 'rgba(233,227,250,.72)',
  inlineCode: 'rgba(113,112,255,.09)',
  /** 边框：淡紫墨色低透明 */
  border1: 'rgba(84,60,150,.08)',
  border2: 'rgba(84,60,150,.14)',
  border3: 'rgba(84,60,150,.20)',
  border4: 'rgba(84,60,150,.28)',
  /** 文字：深紫黑系 */
  text1: '#241f38',
  text2: '#4b4560',
  text3: '#6e6885',
  textDim: '#9a94ad',
  /** 强调（官网靛紫，浅底上略压深以保对比） */
  accent: '#6f6cff',
  accentBright: '#8f8cff',
  accentDeep: '#5e6ad2',
  hover: 'rgba(113,112,255,.09)',
  active: 'rgba(113,112,255,.16)',
  skeleton: 'rgba(113,112,255,.08)',
} as const

// ─────────────────────────── 绝对中性阶（明暗同值）───────────────────────────

/** `--dsw-static-neutral-bluish-*`：保持明度次序，换成淡紫冷调 */
const NEUTRAL_BLUISH: Record<string, string> = {
  '--dsw-static-neutral-bluish-00': '#ffffff',
  '--dsw-static-neutral-bluish-50': '#faf9ff',
  '--dsw-static-neutral-bluish-60': '#f5f3fc',
  '--dsw-static-neutral-bluish-75': '#eeeaf9',
  '--dsw-static-neutral-bluish-100': '#e6e2f4',
  '--dsw-static-neutral-bluish-150': '#dcd7ec',
  '--dsw-static-neutral-bluish-200': '#cfc9e2',
  '--dsw-static-neutral-bluish-300': '#b3abc9',
  '--dsw-static-neutral-bluish-400': '#8e87a6',
  '--dsw-static-neutral-bluish-500': '#79728f',
  '--dsw-static-neutral-bluish-600': '#655f78',
  '--dsw-static-neutral-bluish-700': '#524c62',
  '--dsw-static-neutral-bluish-750': '#443f52',
  '--dsw-static-neutral-bluish-800': '#373342',
  '--dsw-static-neutral-bluish-850': '#2c2937',
  '--dsw-static-neutral-bluish-875': '#25222e',
  '--dsw-static-neutral-bluish-900': '#1d1b25',
  '--dsw-static-neutral-bluish-950': '#15131b',
  '--dsw-static-neutral-bluish-1000': '#0e0d13',
}

/** `--dsw-static-neutral-*`：纯中性，同样带一点紫调 */
const NEUTRAL: Record<string, string> = {
  '--dsw-static-neutral-00': '#ffffff',
  '--dsw-static-neutral-50': '#fafafa',
  '--dsw-static-neutral-100': '#f5f4f8',
  '--dsw-static-neutral-150': '#eeecf3',
  '--dsw-static-neutral-200': '#e5e3ec',
  '--dsw-static-neutral-250': '#dbd9e2',
  '--dsw-static-neutral-300': '#d0ced8',
  '--dsw-static-neutral-400': '#8e8c98',
  '--dsw-static-neutral-500': '#77757f',
  '--dsw-static-neutral-550': '#66646d',
  '--dsw-static-neutral-600': '#57555d',
  '--dsw-static-neutral-700': '#3e3c43',
  '--dsw-static-neutral-800': '#29272d',
  '--dsw-static-neutral-850': '#201f24',
  '--dsw-static-neutral-900': '#100f13',
  '--dsw-static-neutral-1000': '#000000',
}

/** `--dsw-static-deepseek-*`：品牌蓝阶 → 官网靛紫 */
const BRAND: Record<string, string> = {
  '--dsw-static-deepseek-50': '#f0efff',
  '--dsw-static-deepseek-100': '#e3e2ff',
  '--dsw-static-deepseek-200': '#cdccff',
  '--dsw-static-deepseek-300': '#b0aeff',
  '--dsw-static-deepseek-400': GRAPE_LIGHT.accentBright,
  '--dsw-static-deepseek-450': GRAPE_LIGHT.accentBright,
  '--dsw-static-deepseek-500': GRAPE_LIGHT.accent,
  '--dsw-static-deepseek-600': GRAPE_LIGHT.accentDeep,
  '--dsw-static-deepseek-700-delete': '#4a55b0',
  '--dsw-static-deepseek-800': '#3a4289',
  '--dsw-static-deepseek-900': '#2b3060',
}

/** 语义色：官网色点 */
const SEMANTIC: Record<string, string> = {
  '--dsw-static-green-100': '#d9f7e7',
  '--dsw-static-green-400': '#34d399',
  '--dsw-static-green-500': '#10b981',
  '--dsw-static-green-500-a08': '#10b98114',
  '--dsw-static-green-500-a12': '#10b9811f',
  '--dsw-static-green-900': '#0b2e22',
  '--dsw-static-red-50': '#fef2f2',
  '--dsw-static-red-100': '#ffe0e0',
  '--dsw-static-red-400': '#f87171',
  '--dsw-static-red-400-a12': '#f871711f',
  '--dsw-static-red-500': '#ef4444',
  '--dsw-static-red-600': '#dc2626',
  '--dsw-static-red-600-a08': '#dc262614',
  '--dsw-static-red-900': '#3d0f0f',
  '--dsw-static-amber-100': '#fef3e2',
  '--dsw-static-amber-400': '#f59e0b',
  '--dsw-static-amber-500': '#d97706',
  '--dsw-static-amber-600': '#b45309',
  '--dsw-static-amber-900': '#27241f',
  '--dsw-static-blue-400': '#3b82f6',
  '--dsw-static-blue-450': '#3b82f6',
  '--dsw-static-blue-500': '#2563eb',
}

// ───────────────────── 显式覆盖：淡紫底 / 文字 / 边框 / 强调 ─────────────────────

const LAVENDER: Record<string, string> = {
  // 背景：半透明淡紫
  '--dsw-alias-bg-base': GRAPE_LIGHT.bg,
  '--dsw-alias-bg-document-preview': GRAPE_LIGHT.bgSolid,
  '--dsw-alias-bg-layer-1': GRAPE_LIGHT.layer1,
  '--dsw-alias-bg-layer-2': GRAPE_LIGHT.layer2,
  '--dsw-alias-bg-layer-3': GRAPE_LIGHT.layer3,
  '--dsw-alias-bg-overlay': 'rgba(120,100,190,.16)',
  '--dsw-alias-bg-module-platform': GRAPE_LIGHT.layer2,
  '--dsw-alias-bg-multi-select': GRAPE_LIGHT.hover,
  '--dsw-alias-bg-skeleton': GRAPE_LIGHT.skeleton,

  // 浮层：菜单 / 弹窗 / 下拉 —— 一律实底，避免叠在半透明画布上糊成一片
  '--dsw-specific-menu': GRAPE_LIGHT.surfaceSolid,
  '--dsw-alias-menu-group-header-fill': GRAPE_LIGHT.surfaceSolidAlt,

  // 文字
  '--dsw-alias-label-primary': GRAPE_LIGHT.text1,
  '--dsw-alias-label-primary-bluish': GRAPE_LIGHT.text1,
  '--dsw-alias-label-primary-dimmed': GRAPE_LIGHT.text2,
  '--dsw-alias-label-primary-foreground': '#ffffff',
  '--dsw-alias-label-primary-inverted': GRAPE_LIGHT.text1,
  '--dsw-alias-label-secondary': GRAPE_LIGHT.text2,
  '--dsw-alias-label-tertiary': GRAPE_LIGHT.text3,
  '--dsw-alias-label-caption': GRAPE_LIGHT.text3,
  '--dsw-alias-label-dimmed': GRAPE_LIGHT.textDim,
  '--dsw-alias-label-document-preview': GRAPE_LIGHT.text2,

  // 边框
  '--dsw-alias-border-l1': GRAPE_LIGHT.border1,
  '--dsw-alias-border-l2': GRAPE_LIGHT.border2,
  '--dsw-alias-border-l2-darkmode-thin': GRAPE_LIGHT.border2,
  '--dsw-alias-border-l3': GRAPE_LIGHT.border3,
  '--dsw-alias-border-l4': GRAPE_LIGHT.border4,
  '--dsw-alias-border-inverted': GRAPE_LIGHT.border2,
  '--dsw-alias-border-inverted2': GRAPE_LIGHT.border2,
  '--dsw-alias-settings-card-stroke': GRAPE_LIGHT.border2,

  // 品牌 / 链接
  '--dsw-alias-brand-primary': GRAPE_LIGHT.accent,
  '--dsw-alias-brand-primary-invert': GRAPE_LIGHT.accent,
  '--dsw-alias-brand-text': GRAPE_LIGHT.accent,
  '--dsw-alias-brand-primary-new-colorprimary-new-color': GRAPE_LIGHT.accent,
  '--dsw-alias-link': GRAPE_LIGHT.accentDeep,
  '--dsw-alias-onboarding-accent': GRAPE_LIGHT.accent,

  // 交互
  '--dsw-alias-interactive-bg-hover': GRAPE_LIGHT.hover,
  '--dsw-alias-interactive-bg-active': GRAPE_LIGHT.active,
  '--dsw-alias-interactive-bg-hover-accent': 'rgba(113,112,255,.20)',
  '--dsw-alias-interactive-bg-hover-solid': 'rgba(226,221,246,.9)',
  '--dsw-alias-interactive-bg-hover-danger': 'rgba(248,113,113,.14)',

  // 面板 / 气泡 / 代码
  '--dsw-specific-sidebar-fill': GRAPE_LIGHT.sidebar,
  '--dsw-specific-sidebar-nav-item-hover': GRAPE_LIGHT.hover,
  '--dsw-specific-sidebar-nav-item-active': GRAPE_LIGHT.active,
  '--dsw-specific-sidebar-nav-item-active-accent': 'rgba(113,112,255,.20)',
  '--dsw-specific-bubble': GRAPE_LIGHT.bubble,
  '--dsw-specific-bubble-highlight': GRAPE_LIGHT.bubbleStrong,
  '--dsw-specific-input-major': GRAPE_LIGHT.input,
  '--dsw-specific-selector': 'rgba(255,255,255,.55)',
  '--dsw-specific-tip': 'rgba(255,255,255,.55)',
  '--dsw-specific-login-input': 'rgba(255,255,255,.70)',
  '--dsw-alias-markdown-code-block': GRAPE_LIGHT.codeBlock,
  '--dsw-alias-markdown-code-block-banner': GRAPE_LIGHT.codeBanner,
  '--dsw-alias-markdown-code-segment-selected': GRAPE_LIGHT.hover,
  '--dsw-alias-markdown-code-segment-unselected': 'rgba(255,255,255,.45)',
  '--dsw-alias-markdown-inline-code': GRAPE_LIGHT.inlineCode,
  '--dsw-alias-markdown-tag': GRAPE_LIGHT.hover,
  '--dsw-alias-markdown-placeholder': 'rgba(226,221,246,.6)',
  '--dsw-alias-markdown-citation': GRAPE_LIGHT.hover,
  '--dsw-alias-settings-card-fill': GRAPE_LIGHT.surfaceSolid,
  '--dsw-alias-turn-trigger-bg': GRAPE_LIGHT.codeBlock,
  '--dsw-alias-turn-trigger-bg-hover': GRAPE_LIGHT.hover,
  '--dsw-alias-button-elevated-fill': 'rgba(255,255,255,.96)',
  '--dsw-alias-button-floating-fill': '#fdfcff',
  '--dsw-alias-button-floating-hover': 'rgba(255,255,255,.95)',
  '--dsw-alias-button-tool-bar-fill': 'rgba(84,60,150,.08)',
  '--dsw-alias-button-tool-bar-hover': 'rgba(84,60,150,.14)',
  '--dsw-alias-button-ghost-active-fill': GRAPE_LIGHT.active,
  '--dsw-alias-button-ghost-active-hover': GRAPE_LIGHT.hover,
  '--dsw-alias-button-ghost-active-border': GRAPE_LIGHT.border3,
  '--dsw-alias-button-primary-dimmed': 'rgba(111,108,255,.45)',
  '--dsw-alias-button-primary-hover': GRAPE_LIGHT.accentBright,
  '--dsw-alias-button-info-fill': GRAPE_LIGHT.accent,
  '--dsw-alias-button-info-hover': GRAPE_LIGHT.accentDeep,
  '--dsw-alias-button-contrast-fill': GRAPE_LIGHT.text1,
  '--dsw-alias-switch-thumb': '#ffffff',
  '--dsw-alias-toast-bg': 'rgba(36,31,56,.92)',
  '--dsw-alias-toast-label': '#ffffff',
  '--dsw-alias-tooltip-bg': 'rgba(36,31,56,.92)',
  '--dsw-alias-onboarding-card-fill': GRAPE_LIGHT.surfaceSolid,
  '--dsw-alias-onboarding-secondary-fill': GRAPE_LIGHT.surfaceSolidAlt,
  '--dsw-alias-scrollbar-bg-l1': 'rgba(84,60,150,.18)',
  '--dsw-alias-scrollbar-bg-l2': 'rgba(84,60,150,.18)',
  '--dsw-alias-scrollbar-hover-l1': 'rgba(84,60,150,.30)',
  '--dsw-alias-scrollbar-hover-l2': 'rgba(84,60,150,.30)',

  // 差异视图
  '--dsw-alias-file-diff-added-bg': 'rgba(16,185,129,.12)',
  '--dsw-alias-file-diff-added-gutter': 'rgba(16,185,129,.08)',
  '--dsw-alias-file-diff-added-marker': '#10b981',
  '--dsw-alias-file-diff-deleted-bg': 'rgba(248,113,113,.12)',
  '--dsw-alias-file-diff-deleted-gutter': 'rgba(248,113,113,.08)',
  '--dsw-alias-file-diff-deleted-marker': '#f87171',
}

/** 完整 token 表（`ThemeDefinition.tokens` 用；单套值） */
export const GRAPE_TOKENS: Record<string, string> = {
  ...NEUTRAL_BLUISH,
  ...NEUTRAL,
  ...BRAND,
  ...SEMANTIC,
  ...LAVENDER,
}

/**
 * 明暗两套（`ctx.theme.overrideTokens` 用）。
 *
 * 两套给**同一组值**（淡紫浅色）：覆盖层要保证"用户切到另一方案也不会变得不可读"，
 * 而我们的界面不随方案变化 —— 同时在启用时把偏好切到 `light`，避免基础方案
 * 是 dark 时其余未被覆盖的 token 取下暗色值而与本底冲突。
 */
export function grapeTokenOverrides(): ThemeTokenOverrides {
  const out: ThemeTokenOverrides = {}
  for (const [k, v] of Object.entries(GRAPE_TOKENS)) out[k] = { light: v, dark: v }
  return out
}

/**
 * 注册并返回 disposer。`ctx.theme` 缺失时静默跳过（老版本 dsh / 非 web 端）。
 *
 * ⚠️ 官方「外观」行写死 light/dark/system 三选一（`THEME_PREFERENCES`），
 * 设置 schema 也只收这三个，所以**注册的主题在标准 UI 里选不到**。
 * 真要让主题生效用 {@link bindGrapeTheme}（`overrideTokens` 叠加层）。
 * register 仍保留：让主题进入 registry，未来版本若开放主题列表即可见。
 *
 * @param ctx 客户端根 context
 * @returns 注销函数（无 theme 服务时为空操作）
 */
export function registerGrapeTheme(ctx: unknown): () => void {
  const theme = (ctx as { theme?: { register?: (d: unknown) => () => void } })?.theme
  if (!theme || typeof theme.register !== 'function') return () => {}
  try {
    return theme.register({
      id: GRAPE_THEME_ID,
      colorScheme: 'light',
      tokens: GRAPE_TOKENS,
    })
  } catch (err) {
    console.warn(`[grape-dsh] grape theme registration failed: ${String(err)}`)
    return () => {}
  }
}

/** 客户端 configForm 的最小面（只用快照 + 订阅） */
interface FormLike {
  getSnapshot: () => { value?: unknown }
  subscribe: (listener: () => void) => () => void
}

/**
 * 把 Grape 主题接到插件配置开关上（`config.grapeTheme`）。
 *
 * 用 `ctx.theme.overrideTokens` 而不是 `setTheme`：
 *  · 叠加层作用于**当前生效的主题**，不需要改用户偏好、不需要重注册；
 *  · 可撤销 —— 关掉开关即原样恢复内置明/暗。
 *
 * 配置值走 `ctx.configForms.get(entryId)` 快照（host 侧 `grapeTheme` 是
 * `.volatile()`，热改立即生效，无需重启）。
 *
 * @param ctx 客户端根 context（须已把 `theme`/`configForms` 加进 inject）
 * @returns 解绑函数
 */
export function bindGrapeTheme(ctx: unknown): () => void {
  const c = ctx as {
    theme?: {
      overrideTokens?: (source: string, tokens: ThemeTokenOverrides) => () => void
      getTheme?: () => { preference?: string }
      setTheme?: (id: string) => void
    }
    configForms?: { get?: (entryId: string) => FormLike | undefined }
  }
  const theme = c.theme
  const form = c.configForms?.get?.(GRAPE_ENTRY_ID)
  if (!theme?.overrideTokens || !form) return () => {}

  let disposeLayer: (() => void) | null = null
  /** 开启前的配色偏好，关闭时还原（不擅自改用户的设置） */
  let prefBefore: string | null = null

  const sync = (): void => {
    const on = (form.getSnapshot()?.value as { grapeTheme?: boolean } | undefined)?.grapeTheme === true
    if (on && !disposeLayer) {
      try {
        disposeLayer = theme.overrideTokens!(GRAPE_THEME_ID, grapeTokenOverrides())
        // 覆盖层是浅色设计：切到 light，避免基础方案为 dark 时其余 token 冲突
        if (theme.getTheme && theme.setTheme) {
          prefBefore = theme.getTheme().preference ?? null
          if (prefBefore !== 'light') theme.setTheme('light')
        }
      } catch (err) {
        console.warn(`[grape-dsh] theme override failed: ${String(err)}`)
      }
    } else if (!on && disposeLayer) {
      const remove = disposeLayer
      disposeLayer = null
      try {
        remove()
      } catch { /* 已失效 */ }
      if (prefBefore && theme.setTheme) {
        try { theme.setTheme(prefBefore) } catch { /* 已失效 */ }
      }
      prefBefore = null
    }
  }

  const unsubscribe = form.subscribe(sync)
  sync()

  return () => {
    unsubscribe?.()
    if (disposeLayer) {
      const remove = disposeLayer
      disposeLayer = null
      try { remove() } catch { /* 已失效 */ }
    }
  }
}