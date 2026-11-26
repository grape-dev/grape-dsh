/**
 * `@` 引用已跟随的 issue（P2）—— 对话输入框里像 `@文件` 那样指定一个 issue。
 *
 * ## 机制（实测自官方契约与内置实现，见 MULTI-PIN-AND-MENTION-DESIGN.md §2）
 *
 * dsh 的 `@` 菜单由官方包 `dsh-client-ui-input-trigger` 提供，客户端服务是
 * `ctx.inputTriggers`。注册一个 `@` 源后，用户打 `@` 就会看到我们的分组：
 *
 *   candidates() → 菜单候选行（我们从**本地 pin 列表**出，零请求 → 菜单即时）
 *   onPick()     → { insert: ReferenceInsert }  插入引用胶囊
 *   codec        → clipboardText（复制出去的样子）+ serialize（**模型实际看到的文本**）
 *
 * 🔴 关键：**必须自带 codec**。内置 `@文件` 源（`dsh-client-ui-reference`）的 codec 是
 * `serialize: ref => ref` —— 即"文件提及原样送模型"，`ref` 会被当成**文件路径**。
 * 我们的 issue 不是文件，复用它的 codec 会让模型看到一个不存在的路径。
 * 自带 codec 才能把 issue 身份写成模型能直接用的结构化文本。
 *
 * ## 边界
 * `@` 只是"把目标说清楚"，**不写任何东西**：指令仍由 AI 走既有 9 个写工具 + 写确认。
 * 这延续"只触发、只观察、可推进、不干预 A2A 交接"的原则。
 */

import { formatIssueRefForModel } from '../issue-number.js'
import { getPins, subscribePins } from './pins-store.js'

/**
 * 源名 = 菜单分组标题 = 引用路由键 —— **三者必须同一个字符串**（同一 trigger 下唯一；
 * 内置文件源用的是 'reference'）。
 *
 * 🔴 路由硬约束（源码实证 `InputTriggerController.serializeReference`）：
 *     const owner = roster.all().find((s) => s.name === source)
 *     if (owner?.codec === void 0) reject(`slash: no serializer for reference source "${source}"`)
 * 发送时按引用节点的 `source` 反查源、再取该源的 codec 序列化成模型文本；
 * **查不到就 reject，整条消息发不出去**（契约原话："failure blocks the send"）。
 * 所以 `insert.source` 只能是注册时的 `name`，两者绝不能各写一个常量
 * ——（曾写成 `source:'grape-issue'` + `name:'已跟随的 issue'`，带引用的消息一发即失败）。
 *
 * 展示：菜单分组标题走 `slash.menu` 本地化键（键 = 源名，未收录则**原样显示源名**）；
 * 我们不注册该命名空间，所以源名本身就是给用户看的文案 —— 直接写中文。
 */
export const MENTION_SOURCE = '已跟随的 issue'

/**
 * 分组显示顺序。**放最前面**（内置默认 0）。
 *
 * 用户钉住 issue 就是为了"快速指定"，如果排在 ~20 个文件 + ~10 个会话之后，
 * 每次都要滚很远才够得着，等于把"快速"抵消掉。我们的组通常很短（1–8 行），
 * 放在最前对文件用户几乎无成本。
 */
const MENTION_ORDER = -1

/** 极小取值器 */
const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''

/** 状态中文（与面板口径一致；未收录保留原样） */
const STATUS_ZH: Record<string, string> = {
  active: '活跃', processing: '处理中', pending: '待处理', running: '运行中',
  awaiting_input: '待澄清', pending_review: '待审核',
  completed: '已完成', cancelled: '已取消', failed: '失败',
}

/** 候选行的显示标题 `#N 标题` */
function pinLabel(owner: string, repo: string, number: string, title: string): string {
  void owner; void repo
  return `#${number}${title ? ` ${title}` : ''}`
}

/**
 * 把引用序列化成**模型侧文本**。
 *
 * ⚠️ **本函数绝不抛错**。契约规定 `serialize` 失败会**阻止整条消息发送**
 * （"failure blocks the send — never a silent downgrade"），所以任何解析不了的
 * `ref` 都必须返回一个降级文本 —— 宁可文本不完美，也不能让用户发不出消息。
 *
 * 编号口径（字母数字白名单、拒绝 `"0"`）与转义/降级语义统一在
 * `issue-number.ts` 的 `formatIssueRefForModel`（Issue #39）：客户端不再内联编号正则，
 * 这里只负责把**本地 pin 的已知身份**（可能已被取消或过期）与 ref 反解结果合并。
 *
 * 输出形如（与 33 个工具的 owner/repo/number 参数直接对齐，模型不用猜）：
 *   <grape-issue repo="wdmike/snake-game-9" number="3" platform="gitcode" title="probe-confirm-test"/>
 */
export function formatIssueForModel(ref: string): string {
  try {
    const known = getPins().find((p) => p.id === ref)
    return formatIssueRefForModel(ref, known)
  } catch {
    // 兜底：任何意外都退化成可读文本，绝不让发送失败
    return `[Grape issue ${ref}]`
  }
}

/** 客户端 ctx 的最小可用面（避免 import 具体的 cordis 类型） */
interface ClientCtxLike {
  get?: (name: string) => unknown
  inject?: (names: string[], cb: (scoped: unknown) => void) => unknown
  effect?: (cb: () => unknown, label?: string) => unknown
}

/**
 * 注册 `@` 源。
 *
 * 用 `ctx.inject(['inputTriggers'], cb)` 拿**可选依赖**：没有该服务的部署
 * （headless / SDK-minimal）里插件照常加载，只是少一个 `@` 菜单 —— 33 个工具不受影响。
 */
export function registerGrapeMention(ctx: ClientCtxLike): void {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['inputTriggers'], (scoped) => {
    const s = scoped as ClientCtxLike
    const svc = (typeof s.get === 'function' ? s.get('inputTriggers') : undefined) as
      | { registerSource?: (src: unknown) => () => void }
      | undefined
    if (!svc || typeof svc.registerSource !== 'function') return
    const register = svc.registerSource.bind(svc)

    const source = {
      trigger: '@',
      // ⚠️ 必须与下面 insert.source 同源同名（发送时按此名反查 codec，查不到会 reject）
      name: MENTION_SOURCE,
      order: MENTION_ORDER,

      /**
       * 候选 = **已跟随的 pin 列表**（本地数据，零请求）。
       *
       * 不做跨仓 issue 搜索：Grape 没有这个接口（`issues list` 必须带 owner/repo），
       * 而 pin 正是用户主动标记"我在乎"的集合 —— 也正是 `@` 该列出的一批。
       */
      candidates: (_session: unknown, req: { query?: string }) => {
        const q = (req?.query ?? '').trim().toLowerCase()
        const rows = getPins().map((p) => {
          const summary = asObj(p.data)
          const statusZh = STATUS_ZH[str(summary.status)] ?? str(summary.status)
          return {
            // name 是「pick 负载 + 精确匹配键 + 第一个搜索键」，也用于把正文里的 @token 上色，
            // 所以取 owner/repo#N（唯一且可搜）；显示标题交给 label。
            name: `${p.owner}/${p.repo}#${p.number}`,
            label: pinLabel(p.owner, p.repo, p.number, p.title),
            description: [p.owner ? `${p.owner}/${p.repo}` : '', statusZh].filter(Boolean).join(' · '),
            icon: 'file' as const,
            value: p.id,
          }
        }).filter((r) => !q || r.name.toLowerCase().includes(q) || r.label.toLowerCase().includes(q))
        return Promise.resolve(rows)
      },

      /** 选中 → 插入引用胶囊（与内置 `@文件`、内置文件拖拽产生同一个 outcome） */
      onPick: (pick: { candidate?: { value?: string } }) => {
        const id = pick?.candidate?.value
        if (!id) return undefined
        const p = getPins().find((x) => x.id === id)
        if (!p) return undefined
        return {
          insert: {
            // ⚠️ 必须等于注册时的 `name`：发送时 `roster.find(s => s.name === source)`
            //    → 取该源 codec.serialize；查不到就 reject，整条消息发不出去。
            source: MENTION_SOURCE,
            ref: p.id,                                   // 我们自己的不透明 id
            label: pinLabel(p.owner, p.repo, p.number, p.title),
            appearance: 'file' as const,
            clipboardText: `@${p.owner}/${p.repo}#${p.number}`,
          },
        }
      },

      /** 正文里的 `@<name>` 上色：pin 列表就是词表（同步、无副作用，契约要求） */
      lexicon: () => getPins().map((p) => `${p.owner}/${p.repo}#${p.number}`),

      /** pin 增删时通知渲染侧重新取词表 */
      subscribeLexicon: (_session: unknown, listener: () => void) => subscribePins(listener),

      codec: {
        // 复制出去的样子（可再粘回输入框）
        clipboardText: (ref: string) => `@${ref}`,
        // ⭐ 模型侧文本
        serialize: (ref: string) => Promise.resolve(formatIssueForModel(ref)),
      },
    }

    // 与其他注册一致：用 effect 包住，插件卸载时自动撤销
    if (typeof ctx.effect === 'function') ctx.effect(() => register(source), 'grape: @ issue source')
    else register(source)
  })
}