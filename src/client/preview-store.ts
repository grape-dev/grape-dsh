/**
 * 「自动预览」的浏览器侧状态（Issue #28）— **绝不落盘**。
 *
 * 预览 = 实时面板顶部临时展示的「当前仓库最近活跃 issue」。它与正式 pin 的分工：
 *   · 正式 pin：用户点图钉 → `pins-store` 持久化 + 20s 轮询；
 *   · 预览：从浏览面板已有的 `/issues` 缓存里**派生**出来，不写本地存档、
 *     不进 pins 数组、不参与拖拽排序，也不额外开 timer / 发请求。
 *
 * 选择规则在纯模块 `preview-select.ts`（可单测）；这里只做三件事：
 *   1. 把「当前仓库 / issues 缓存 / pin 数」组装成 `PreviewState`；
 *   2. 固定为观察时复用既有 `addPin`（持久化与上限语义完全一致）；
 *   3. 有已缓存的流水线数据时复用 `pinToFocus` 组装，交给 `FocusBody` 渲染。
 */

import { useCallback, useEffect, useState } from 'react'

import type { GrapeFocus } from '../focus.js'
import {
  pickPreviewIssue,
  shouldShowPreview,
  type PreviewIssue,
  type PreviewPick,
} from '../preview-select.js'
import {
  cachedIssues,
  currentRepo,
  ensureIssuesLoaded,
  useBrowse,
  viewState,
  type CurrentRepo,
} from './browse-store.js'
import {
  MAX_PINS,
  addPin,
  pinToFocus,
  setNotice,
  usePins,
  type Pin,
} from './pins-store.js'
import { setMode } from './tab-mode.js'
import { previewCollapsedFor, savePreviewCollapsed } from './preview-collapse.js'

export interface PreviewState {
  /** 侧栏当前仓库（未进过仓库时为 null） */
  repo: CurrentRepo | null
  /** 选择结果（含空态原因） */
  pick: PreviewPick
  /** 预览卡是否显示：只在没有正式 pin 且选中了 issue 时显示 */
  visible: boolean
  /** 当前正式 pin 数（空态引导卡据此判断是否显示） */
  pinCount: number
  /** 可复用 `FocusBody` 渲染的数据；对应 pipeline 未缓存时为 null（不额外拉取） */
  focus: GrapeFocus | null
  /** 预览依据的 `/issues` 缓存时间（毫秒）；未知为 undefined（Issue #28 R2：卡片要标注数据时间） */
  dataAt?: number
  /** 预览卡是否收起：默认展开，用户收起后按仓库记忆 */
  collapsed: boolean
  /** 切换收起/展开（偏好持久化在 preview-collapse.ts，按仓库维度） */
  toggleCollapsed: () => void
}

/**
 * 从**已缓存的** `/pipeline` 数据组装 `GrapeFocus`（复用 pin 的同一套组装/渲染）。
 *
 * 注意：这里**不**调用任何网络请求。用户没在浏览里打开过这条流水线时，预览卡
 * 退化为摘要（见面板实现），而不是为了预览再 spawn 一次子进程。
 */
function focusFromCache(issue: PreviewIssue): GrapeFocus | null {
  const cached = viewState({
    kind: 'pipeline',
    owner: issue.owner,
    repo: issue.repo,
    number: issue.number,
    platform: issue.platform,
  })
  if (!cached.data) return null
  // `pinToFocus` 只读取 identity/data（其余字段占位即可），复用它与 FocusBody 的渲染口径。
  const pseudo: Pin = {
    id: `${issue.owner}/${issue.repo}#${issue.number}`,
    owner: issue.owner,
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    platform: issue.platform,
    expanded: false,
    data: cached.data,
    loading: false,
    error: null,
    updatedAt: 0,
    pinnedAt: 0,
  }
  return pinToFocus(pseudo)
}

/**
 * React 钩子：订阅 pins 与浏览缓存，派生当前预览状态。
 *
 * `useBrowse()` 只是订阅浏览 store 的变更（仓库栈切换 / `/issues` 刷新都会 emit），
 * 实际取值走只读选择器 `currentRepo()` / `cachedIssues()`——不触发任何拉取。
 */
/**
 * 上一次「可渲染」的预览结果（按仓库键）。
 *
 * 为什么需要：预览完全派生自浏览面板的 `/issues` 缓存，缓存每次刷新会把 `data` 置空
 * （`loading=true`）→ `pick.kind` 从 `ready` 变成 `none` → 卡片消失、数据回来又出现，
 * 表现为「第一个楼层一会有一会没有」。这里在**同一仓库刷新期间**沿用上一份结果，
 * 切换仓库或真的没有 issue 时仍然按新结果处理（不会拿 A 仓的卡片糊在 B 仓上）。
 */
let lastReady: { key: string; pick: PreviewPick } | null = null

export function usePreview(): PreviewState {
  const pins = usePins()
  useBrowse()
  /**
   * 预览用哪个仓库？
   *   ① 浏览页当前打开的仓库（正常路径）；
   *   ② 兜底：观察中第一条 pin 的仓库 —— 页面刷新后浏览栈回到根，若只认 ①，
   *      预览卡就会"消失"（2026-11-20 用户反馈）。有 pin 就说明用户关心这个仓库，用它继续预览。
   */
  const browseRepo = currentRepo()
  const pinRepo = pins.find((p) => p.owner && p.repo)
  const repo: CurrentRepo | null = browseRepo
    ?? (pinRepo ? { owner: pinRepo.owner, repo: pinRepo.repo, platform: pinRepo.platform } : null)
  // 兜底仓库的 /issues 可能没缓存（刷新后清空）：按需只读加载一次，不改导航栈
  useEffect(() => {
    if (!repo) return
    ensureIssuesLoaded(repo.owner, repo.repo, repo.platform)
  }, [repo?.owner, repo?.repo, repo?.platform])
  const cache = repo
    ? cachedIssues(repo.owner, repo.repo, repo.platform)
    : { loading: false, error: null as string | null, data: null as unknown, savedAt: undefined as number | undefined }
  const repoKey = repo ? `${repo.platform}:${repo.owner}/${repo.repo}` : ''
  /** 预览卡是否收起：默认展开；用户手动收起后按仓库记忆 */
  const [collapsed, setCollapsed] = useState<boolean>(() => previewCollapsedFor(repoKey))
  // 切仓库 → 读取该仓库自己的选择（未操作过则展开）
  useEffect(() => {
    setCollapsed(previewCollapsedFor(repoKey))
  }, [repoKey])
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      savePreviewCollapsed(repoKey, next)
      return next
    })
  }, [repoKey])
  let pick = pickPreviewIssue({
    repo,
    data: cache.data,
    loading: cache.loading,
    error: cache.error,
    pinCount: pins.length,
    maxPins: MAX_PINS,
  })
  if (pick.kind === 'ready') {
    lastReady = { key: repoKey, pick }
  }
  else if (cache.loading && lastReady && lastReady.key === repoKey) {
    // 刷新中：沿用上一份可渲染结果，卡片不闪
    pick = lastReady.pick
  }
  return {
    repo,
    pick,
    visible: shouldShowPreview(pins.length, MAX_PINS) && pick.kind === 'ready',
    pinCount: pins.length,
    focus: pick.kind === 'ready' ? focusFromCache(pick.issue) : null,
    dataAt: cache.savedAt,
    collapsed,
    toggleCollapsed,
  }
}

/**
 * 「固定为观察」：把预览 issue 转成正式 pin（走既有 `addPin`）。
 *
 * 持久化、上限、立即取数与轮询都由 pins-store 负责；预览侧不重复实现，
 * 固定后 `visible` 因 `pins.length > 0` 自动变 false，徽标随之消失。
 */
export function pinPreview(issue: PreviewIssue): void {
  const result = addPin({
    owner: issue.owner,
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    platform: issue.platform,
  })
  if (result === 'added') {
    setNotice(`已加入观察：#${issue.number}${issue.title ? ` ${issue.title}` : ''}`)
  } else if (result === 'exists') {
    setNotice(`#${issue.number} 已在观察中`)
  } else if (result === 'full') {
    setNotice(`最多同时观察 ${MAX_PINS} 个，请先取消一些`)
  } else {
    setNotice('无法加入观察：issue 信息不完整')
  }
}

/** 「换一条」/ 空态主按钮：切到浏览页签（不自动切 tab，只响应用户点击）。 */
export function openBrowse(): void {
  setMode('browse')
}