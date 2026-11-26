/**
 * Grape 工具名清单 —— host 与 client 共享。
 *
 * - host：注册工具、写操作确认白名单（tools/pre-execute）
 * - client：注册 toolview（tool.call.toolview 按工具名 keyed）
 *
 * 注意：新增/删除工具时必须同步这里，否则 client 的 toolview 与 host 的
 * 确认白名单会与真实注册集不一致。
 */

/** 全部 33 个 grape 工具名 */
export const GRAPE_TOOL_NAMES: readonly string[] = [
  'grape_apply_scene',
  'grape_cancel_issue',
  'grape_create_issue',
  'grape_create_project',
  'grape_get_issue_detail',
  'grape_get_issue_events',
  'grape_get_knowledge_detail',
  'grape_get_ops_overview',
  'grape_get_pipeline_info',
  'grape_get_pipeline_roadmap',
  'grape_get_repo_dashboard',
  'grape_get_repo_project_info',
  'grape_get_skill_detail',
  'grape_get_task_status',
  'grape_host_repo',
  'grape_list_issues',
  'grape_list_knowledge',
  'grape_list_managed_repos',
  'grape_list_my_issues',
  'grape_list_project_templates',
  'grape_list_repo_events',
  'grape_list_repos_member',
  'grape_list_scenes',
  'grape_list_scenes_for_repo',
  'grape_list_skills',
  'grape_resume_issue',
  'grape_search',
  'grape_search_skills',
  'grape_start_issue',
  'grape_sync_repos',
  'grape_terminate_event',
  'grape_trigger_pipeline',
  'grape_wait_task',
]

/**
 * 有副作用的写操作（执行前需用户确认）。
 *
 * 收录标准：会创建/取消/启动/终止 Grape 上的实体，或改动仓库配置。
 * 刻意排除 `grape_sync_repos`（只是刷新元数据，风险低且调用频繁，
 * 每次都弹确认会很吵）。
 */
export const GRAPE_WRITE_TOOL_NAMES: readonly string[] = [
  'grape_create_issue',
  'grape_cancel_issue',
  'grape_trigger_pipeline',
  'grape_resume_issue',
  'grape_start_issue',
  'grape_terminate_event',
  'grape_apply_scene',
  'grape_host_repo',
  'grape_create_project',
]
