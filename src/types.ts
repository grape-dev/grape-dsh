/**
 * Grape API 类型定义。
 * 这些类型对应 Grape API / CLI 返回的数据结构。
 */

/** Grape CLI 配置 */
export interface GrapeCliConfig {
  bin: string
  baseUrl: string
  token: string
  timeout: number
}

/** 流水线节点 */
export interface GrapePipelineNode {
  tag: string
  status: string
  summary?: string
  agent?: string
  label?: string
  status_num?: number
  latest_seq?: number | null
  latest_title?: string
  duration?: number | null
}

/**
 * 场景节点（scenes detail 的 nodes 元素）。
 * `next` 决定链走向，`skip` 里的节点在展示上视为跳过，`enabled=false` 不进入链。
 */
export interface GrapeSceneNode {
  id?: string
  tag?: string
  skill?: string
  next?: string | null
  skip?: string[]
  enabled?: boolean
}

/** 场景详情（scenes detail） */
export interface GrapeSceneDetail {
  id?: string
  scene_id?: string
  name?: string
  display_name?: string
  description?: string
  nodes?: GrapeSceneNode[]
}

/** 场景 */
export interface GrapeScene {
  id?: number
  scene_id?: string
  name: string
  display_name?: string
  description?: string
  market_description?: string
  version?: string
  nodes?: GrapePipelineNode[]
  skills?: string[]
  repo_count?: number
  scope?: string
  icon?: string
}

/** 托管仓库 */
export interface GrapeManagedRepo {
  repo_key: string
  full_name?: string
  role?: string
  webhook_ok?: boolean
  branch?: string
  status?: string
  has_bot_token?: boolean
}

/** Issue 摘要（原始 CLI 形态：GitCode 为整数编号，Gitee 为字母数字字符串，见 Issue #39） */
export interface GrapeIssue {
  id?: number
  number: string | number
  issue_number?: string | number
  title: string
  status?: string
  task_status?: string
  stage?: string
  scene_id?: string
  scene_name?: string
  is_running?: boolean
  is_pr?: boolean
  owner_agent?: string
  events_count?: number
  created_at?: string
  completed_at?: string | null
  agent_statuses?: GrapePipelineNode[]
  latest_event?: {
    seq: number
    event_type: string
    agent_type: string
    title: string
    status: string
    summary?: string
    created_at?: string
  } | null
}

/** 事件详情 */
export interface GrapeEvent {
  seq: number
  event_type?: string
  agent_type?: string
  title?: string
  summary?: string
  status: string
  result?: string
  payload?: Record<string, unknown>
  created_at?: string
  completed_at?: string | null
  duration?: number | null
  exit_code?: number | null
  runtime?: string
  skill?: string
  agent_logs?: Array<Record<string, unknown>>
  prev_seq?: number | null
  next_seq?: number | null
}

/** A2A 触发返回 */
export interface GrapeA2aResult {
  status: string
  seq: number
  agent: string
}

/** Skill 摘要 */
export interface GrapeSkill {
  skill_id?: string
  id?: string
  name?: string
  description?: string
  category?: string
  agent_type?: string
  status?: string
  scope?: string
}

/** Knowledge 条目 */
export interface GrapeKnowledge {
  knowledge_id?: string
  id?: string
  title?: string
  description?: string
  scope?: string
  content?: string
}

/** Dashboard 概览 */
export interface GrapeDashboard {
  total_repos?: number
  active_issues?: number
  running_issues?: number
  completed_issues?: number
  online_agents?: number
  [key: string]: unknown
}

/** 项目模板 */
export interface GrapeProjectTemplate {
  template_id?: string
  id?: string
  name?: string
  description?: string
  category?: string
}

/** 搜索结果 */
export interface GrapeSearchResult {
  issues?: GrapeIssue[]
  repos?: GrapeManagedRepo[]
  skills?: GrapeSkill[]
  [key: string]: unknown
}
