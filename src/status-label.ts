/**
 * 状态文字 → 中文标签（Issue #28）。
 *
 * 后端是英文枚举，直接显示会与全中文界面混种。浏览列表、流水线详情与实时面板
 * 的自动预览卡共用这份映射，避免同一状态在不同面板出现不同中文（如
 * `pending_review` 一处「待审核」、一处被压成「待处理」）。
 */

export const STATUS_LABEL: Record<string, string> = {
  active: '活跃',
  // 平台已把 takeover 归一为 running（方案 A）；这里兜底原始口径：
  // 顶层 pipeline.status 是最后一条事件的透传，未归一的接口/分支仍可能漏出英文值。
  takeover: '接管中',
  processing: '处理中',
  pending: '待处理',
  running: '运行中',
  awaiting_input: '待澄清',
  pending_review: '待审核',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
}

/** 状态中文标签（未收录保留原样） */
export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s