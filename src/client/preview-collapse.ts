/**
 * 「自动预览」卡的**收起偏好**持久化（UI 偏好，不是预览数据）。
 *
 * 为什么单独成文件：`preview-select.test.mjs` 有一条硬约束 —— `preview-store.ts`
 * **不得出现 localStorage**（预览数据绝不落盘）。收起/展开属于界面偏好，
 * 与"预览内容"无关，因此单独落在这里，既不破坏那条约束，也能跨刷新保持。
 *
 * 规则：
 *   · 首次进入（无记录）→ **展开**（需求：实时页首次进入要看到内容）；
 *   · 用户收起后按**仓库**记忆（A 仓收起不影响 B 仓）；
 *   · 存储不可用（隐私模式/配额满）→ 静默退化为仅本次会话，不报错。
 */

export const PREVIEW_COLLAPSE_KEY = 'grape.preview.collapsed.v1'

type CollapseMap = Record<string, boolean>

function readMap(): CollapseMap {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(PREVIEW_COLLAPSE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: CollapseMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === true) out[k] = true
    }
    return out
  }
  catch {
    return {}
  }
}

/** 读某仓库的收起状态；没有记录 = 展开（默认） */
export function previewCollapsedFor(repoKey: string): boolean {
  if (!repoKey) return false
  return readMap()[repoKey] === true
}

/** 写某仓库的收起状态（只记 true，展开则删除该键，存档保持干净） */
export function savePreviewCollapsed(repoKey: string, collapsed: boolean): void {
  if (!repoKey) return
  try {
    if (typeof localStorage === 'undefined') return
    const map = readMap()
    if (collapsed) map[repoKey] = true
    else delete map[repoKey]
    localStorage.setItem(PREVIEW_COLLAPSE_KEY, JSON.stringify(map))
  }
  catch { /* 隐私模式 / 配额满：忽略，退化为仅本次会话 */ }
}
