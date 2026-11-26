/**
 * 表格类渲染函数。
 * 用于 list 类工具的 render 和 presentResult。
 */

import type { GrapeScene, GrapeManagedRepo, GrapeIssue, GrapeSkill, GrapeKnowledge, GrapeProjectTemplate } from '../types.js'
import { formatTime } from '../time-format.js'
import {
  statusIcon, truncate, agentProgressCompact, agentProgressList, extractArray, extractNum, extractStr,
  textBlock,
} from './helpers.js'

/** 场景表格 */
export function renderSceneTable(data: unknown): string {
  const scenes = extractArray(data, 'scenes') as GrapeScene[]
  if (scenes.length === 0) return '没有找到场景'

  const rows = scenes.map(s => {
    const name = s.name || s.scene_id || '?'
    const display = s.display_name || name
    const version = s.version || '-'
    const skills = s.skills?.length || 0
    const repoCount = s.repo_count ?? 0
    return `| ${name} | ${display} | ${version} | ${skills} | ${repoCount} |`
  })

  return `| 名称 | 显示名 | 版本 | 节点数 | 仓库数 |\n|------|--------|------|--------|--------|\n${rows.join('\n')}\n\n共 ${scenes.length} 个场景`
}

/** 仓库表格 */
export function renderRepoTable(data: unknown): string {
  const repos = extractArray(data, 'repos') as GrapeManagedRepo[]
  if (repos.length === 0) return '没有找到仓库'

  const rows = repos.map(r => {
    const name = r.full_name || r.repo_key
    const role = r.role || '-'
    const status = r.status || '-'
    const webhook = r.webhook_ok ? '✅' : '❌'
    const branch = r.branch || '-'
    return `| ${name} | ${role} | ${status} | ${webhook} | ${branch} |`
  })

  return `| 仓库 | 角色 | 状态 | Webhook | 分支 |\n|------|------|------|---------|------|\n${rows.join('\n')}\n\n共 ${repos.length} 个仓库`
}

/** Issue 表格 */
export function renderIssueTable(data: unknown): string {
  const issues = extractArray(data, 'issues') as GrapeIssue[]
  if (issues.length === 0) return '没有找到 Issue'

  const rows = issues.map(i => {
    const num = i.number || i.issue_number || '?'
    const title = truncate(i.title, 40)
    const scene = i.scene_name || i.scene_id || '-'
    const stage = i.stage || '-'
    const running = i.is_running ? '✅' : '⬜'
    const progress = agentProgressCompact(i.agent_statuses)
    return `| #${num} | ${title} | ${scene} | ${stage} | ${running} | ${progress} |`
  })

  return `| # | 标题 | 场景 | 阶段 | 运行中 | agent 进度 |\n|---|------|------|------|--------|------------|\n${rows.join('\n')}\n\n共 ${issues.length} 条 Issue`
}

/** Issue 详情摘要 */
export function renderIssueDetail(data: unknown): string {
  const issue = data as GrapeIssue
  if (!issue || typeof issue !== 'object') return String(data)

  const num = issue.number || issue.issue_number || '?'
  const title = issue.title || '?'
  const status = issue.status || issue.task_status || '-'
  const stage = issue.stage || '-'
  const scene = issue.scene_name || issue.scene_id || '-'
  const running = issue.is_running ? '✅ 是' : '⬜ 否'
  const isPr = issue.is_pr ? '有' : '无'
  const eventsCount = issue.events_count ?? 0
  // 服务端时间一律 UTC：直接透出会让用户在工具输出里看到差 8 小时的时间
  const created = formatTime(issue.created_at) || '-'

  const latestEvent = issue.latest_event
    ? `seq=${issue.latest_event.seq} (${issue.latest_event.agent_type}, ${issue.latest_event.status})`
    : '无'

  const progressList = agentProgressList(issue.agent_statuses)

  return `**Issue #${num}「${title}」**

- 状态: ${statusIcon(status)} ${status} | 阶段: ${stage} | 场景: ${scene}
- 创建: ${created} | 运行中: ${running} | PR: ${isPr}
- 事件数: ${eventsCount} | 最新事件: ${latestEvent}

**Agent 进度:**
${progressList}`
}

/** Skill 表格 */
export function renderSkillTable(data: unknown): string {
  const skills = extractArray(data, 'skills') as GrapeSkill[]
  if (skills.length === 0) return '没有找到 Skill'

  const rows = skills.map(s => {
    const name = s.name || s.skill_id || s.id || '?'
    const cat = s.category || '-'
    const agent = s.agent_type || '-'
    const status = s.status || '-'
    return `| ${name} | ${cat} | ${agent} | ${status} |`
  })

  return `| 名称 | 分类 | Agent | 状态 |\n|------|------|-------|------|\n${rows.join('\n')}\n\n共 ${skills.length} 个 Skill`
}

/** Knowledge 表格 */
export function renderKnowledgeTable(data: unknown): string {
  const items = extractArray(data, 'knowledge') as GrapeKnowledge[]
  if (items.length === 0) return '没有找到知识条目'

  const rows = items.map(k => {
    const id = k.knowledge_id || k.id || '?'
    const title = truncate(k.title, 50)
    const scope = k.scope || '-'
    return `| ${id} | ${title} | ${scope} |`
  })

  return `| ID | 标题 | 范围 |\n|----|------|------|\n${rows.join('\n')}\n\n共 ${items.length} 条知识`
}

/** 项目模板表格 */
export function renderTemplateTable(data: unknown): string {
  const templates = extractArray(data, 'templates') as GrapeProjectTemplate[]
  if (templates.length === 0) return '没有找到项目模板'

  const rows = templates.map(t => {
    const id = t.template_id || t.id || '?'
    const name = t.name || '-'
    const cat = t.category || '-'
    return `| ${id} | ${name} | ${cat} |`
  })

  return `| 模板 ID | 名称 | 分类 |\n|---------|------|------|\n${rows.join('\n')}\n\n共 ${templates.length} 个模板`
}

/** 搜索结果渲染 */
export function renderSearchResults(data: unknown): string {
  const result = data as Record<string, unknown>
  if (!result || typeof result !== 'object') return String(data)

  const parts: string[] = []

  const issues = result.issues as GrapeIssue[] | undefined
  if (issues && issues.length > 0) {
    parts.push(`**Issues (${issues.length})**\n${renderIssueTable({ issues })}`)
  }

  const repos = result.repos as GrapeManagedRepo[] | undefined
  if (repos && repos.length > 0) {
    parts.push(`**仓库 (${repos.length})**\n${renderRepoTable({ repos })}`)
  }

  const skills = result.skills as GrapeSkill[] | undefined
  if (skills && skills.length > 0) {
    parts.push(`**Skills (${skills.length})**\n${renderSkillTable({ skills })}`)
  }

  if (parts.length === 0) return '没有找到搜索结果'
  return parts.join('\n\n---\n\n')
}
