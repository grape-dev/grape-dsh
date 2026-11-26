/**
 * Grape 品牌位：把 dsh 侧栏的品牌标记/名称换成 Grape 的。
 *
 * 图形来源：官网 `assets/grape-logo.jpg`（1996×1996 权威 logo），处理流程
 *  1. 从四角 flood fill 去掉白底（保留葡萄珠**内部**的白色小图标）；
 *  2. 侵蚀 ~7px（1996 尺度 ≈ 128 尺度 1px）去掉抗锯齿留下的白边毛刺；
 *  3. 裁到内容 bbox → 缩到 64×64 → 内联为 data URL。
 * 实测：边缘像素 0% 偏白（无白边），珠内白图标完整保留。
 *
 * 为什么不手绘 SVG：用户视觉铁律 —— logo 必须与官方完全一致，手绘近似会被打回。
 * 为什么内联而不外链：客户端 bundle 是单文件 envelope，没有静态资源目录；
 * 64×64 透明 PNG 仅 5.7KB，内联成本可接受。
 *
 * 槽位（都是 single、root、无 registerOptions）：
 *   sidebar.brand.mark       侧栏品牌标记（ownerProps: { size }）
 *   sidebar.brand.name       侧栏品牌名（无 props）
 *   conversation.hero.brand.mark  空会话首屏标题前的标记（ownerProps: { size, className? }）
 * 官方由 client-ui-brand-official 占用，第三方注册即替换。
 */

import type { ReactNode } from 'react'

/** 透明葡萄 logo（64×64 PNG，由官方 logo 键白底 + 去白边得到） */
export const GRAPE_BRAND_MARK =
  'data:image/png;base64,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'

/** 侧栏品牌标记 */
export function GrapeBrandMark(props: { size?: number }): ReactNode {
  const size = props.size ?? 20
  return (
    <img
      src={GRAPE_BRAND_MARK}
      width={size}
      height={size}
      alt="Grape"
      style={{ display: 'block', width: size, height: size }}
    />
  )
}

/** 侧栏品牌名 */
export function GrapeBrandName(): ReactNode {
  return (
    <span style={{ fontWeight: 590, letterSpacing: '-0.01em' }}>Grape</span>
  )
}

/** 空会话首屏的标记 */
export function GrapeHeroMark(props: { size?: number; className?: string }): ReactNode {
  const size = props.size ?? 48
  return (
    <img
      className={props.className}
      src={GRAPE_BRAND_MARK}
      width={size}
      height={size}
      alt="Grape"
      style={{ display: 'block', width: size, height: size }}
    />
  )
}

/** 槽位注册器的最小面 */
interface SlotRegistry {
  inject: (name: string, register: () => unknown) => unknown
  register: (options: Record<string, unknown>, component: unknown) => unknown
}

/**
 * 注册三个品牌位（替换官方品牌插件的占位）。
 *
 * 注意：**无条件注册**（不跟 `grapeTheme` 开关走）—— 品牌是插件自身的身份，
 * 不是主题的一部分。卸载插件即恢复 dsh 原生品牌。
 *
 * @param ctx 客户端根 context（须已把 `slots` 加进 inject）
 */
export function registerGrapeBrand(ctx: unknown): void {
  const c = ctx as { slots?: SlotRegistry; logger?: { warn?: (m: string) => void } }
  const slots = c.slots
  if (!slots) return
  const targets: Array<[string, unknown]> = [
    ['sidebar.brand.mark', GrapeBrandMark],
    ['sidebar.brand.name', GrapeBrandName],
    ['conversation.hero.brand.mark', GrapeHeroMark],
  ]
  for (const [name, component] of targets) {
    try {
      slots.inject(name, () => slots.register({ name }, component))
    } catch (err) {
      console.warn(`[grape-dsh] brand slot '${name}' failed: ${String(err)}`)
    }
  }
}
