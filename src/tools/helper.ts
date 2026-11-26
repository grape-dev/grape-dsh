/**
 * 声明式工具定义辅助函数。
 *
 * 每个工具只需定义一个 ToolConfig 配置对象，
 * makeToolFromConfig() 自动生成完整的 dsh ToolDefinition。
 */

import type { GrapeCliConfig } from '../types.js'
import { execGrape, pollGrapeUntilTerminal } from '../cli-client.js'
import type { GrapeFocus } from '../focus.js'

/**
 * 「交接类」工具 —— 调用它们意味着**把工作交给 Grape 流水线去做**。
 *
 * ### 为什么要在这里单独标注（2026-10-23 实测事故）
 * 用户在一个工作区为本插件仓库的会话里说"在这个 ISSUE 中实现这个功能"，模型却
 * clone 业务仓库 → 自己 edit 代码 → 自己建分支 → push → 开 PR，**完全绕开了流水线**，
 * 还污染了工作区。事后看工具描述，问题很清楚：
 *
 *   `[Grape-unique] Start/open an issue session. Advances the pipeline.`
 *
 * ——模型看不出"这就是把需求交出去的动作"，更看不出"你不该自己动手"。
 *
 * ### 为什么用集中追加而不是改 4 处字符串
 * 交接类工具的措辞必须**一致**（模型的判断依据之一就是几个工具描述的一致性）；
 * 散在 4 个文件里各写一句，迟早出现措辞漂移甚至漏改新增的交接工具。
 *
 * 提示很短是刻意的：这 4 条描述**始终**在上下文里（和完整规则放在 skill 里按需加载不同，
 * 见 src/skill.ts），所以只说最要紧的一句。
 */
const HAND_OFF_TOOLS: ReadonlySet<string> = new Set([
  'grape_create_issue',     // 建单 + 触发流水线
  'grape_start_issue',      // 让流水线在既有 issue 上开工
  'grape_resume_issue',     // 恢复中断的流水线
  'grape_trigger_pipeline', // A2A 交接
])

const HAND_OFF_NOTE =
  ' Hand-off: this call gives the work to the Grape pipeline — do NOT do it yourself ' +
  '(no cloning the repo, no editing its code, no branch or PR of your own).'

// ── 参数定义 ──

export interface ParamSpec {
  type: 'string' | 'number' | 'boolean' | 'integer'
  description?: string
  required?: boolean
  enum?: string[] | number[]
  default?: unknown
}

/** 构造 JSON Schema parameters 对象 */
export function buildParameters(specs: Record<string, ParamSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [name, spec] of Object.entries(specs)) {
    const prop: Record<string, unknown> = {
      type: spec.type,
      description: spec.description || name,
    }
    if (spec.enum) prop.enum = spec.enum
    if (spec.default !== undefined) prop.default = spec.default

    properties[name] = prop
    if (spec.required) required.push(name)
  }

  const result: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  }
  if (required.length > 0) result.required = required
  return result
}

// ── 渲染类型 ──

export type RenderType =
  | 'sceneTable' | 'repoTable' | 'issueTable' | 'issueDetail'
  | 'skillTable' | 'knowledgeTable' | 'templateTable' | 'searchResults'
  | 'pipelineCard' | 'pipelineNodes' | 'pipelineRoadmap'
  | 'eventTimeline'
  | 'taskStatus' | 'issueStatus' | 'dashboard'
  | 'action'

// ── presentCall 配置 ──

export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

export interface PresentCallConfig {
  /** 卡片标题模板，用 ${argName} 引用参数值 */
  title: string
  /** 图标分类 */
  kind?: ToolCallKind
}

// ── 工具配置 ──

export interface ToolConfig {
  name: string
  description: string
  parameters: Record<string, ParamSpec>

  /** 拼 CLI args 函数，返回 grape 子命令参数（不含全局选项） */
  cliArgs: (args: Record<string, unknown>) => string[]

  /** render 类型，决定给模型看的文本格式 */
  renderType: RenderType

  /** presentCall 配置（可选，省略则无 presentCall） */
  presentCall?: PresentCallConfig

  /** 是否是 wait_task 类轮询工具（特殊处理） */
  isPoll?: {
    seqArg: string
    timeoutArg: string
    intervalArg: string
  }

  /** action 工具的动作名称（renderType='action' 时用） */
  actionName?: string

  /**
   * 结果补充器（可选）：CLI 返回后追加只读信息。
   *
   * 用途（Issue #26）：`issues pipeline` 不带场景节点，但文本渲染需要按场景骨架画卡片；
   * 这里在结果上补 `scene_id / scene_name / scene_nodes / node_count`。
   * 失败必须静默（渲染会退化为事件段顺序并标注「场景未知」），不能影响主结果。
   */
  enrich?: (args: Record<string, unknown>, result: unknown) => Promise<unknown>

  /**
   * 焦点构造器（可选）。
   *
   * ⚠️ **当前不产生任何可观察效果**：原本它同时驱动「结果里的 `_focus`」和
   * 「展示文本里的 `<!--grape-focus:…-->` 标记」，而这两条都在 2026-10-23 移除了
   * （原因见 execute 里的说明）。留在这里是为了不让 8 处 `focus:` 声明立刻变成编译错误，
   * 但它们现在是**惰性的** —— 新工具不要再照抄。
   *
   * 见 SIDEBAR-AUTO-NAV-DESIGN.md §5.1 触发策略。
   */
  focus?: (args: Record<string, unknown>, result: unknown) => GrapeFocus | null
}

// ── render 函数映射 ──

// 同步导入渲染函数
import * as renderMod from '../render/index.js'

function renderValueSync(renderType: RenderType, value: unknown, actionName?: string): string {
  switch (renderType) {
    case 'sceneTable':      return renderMod.renderSceneTable(value)
    case 'repoTable':       return renderMod.renderRepoTable(value)
    case 'issueTable':      return renderMod.renderIssueTable(value)
    case 'issueDetail':     return renderMod.renderIssueDetail(value)
    case 'skillTable':      return renderMod.renderSkillTable(value)
    case 'knowledgeTable':  return renderMod.renderKnowledgeTable(value)
    case 'templateTable':   return renderMod.renderTemplateTable(value)
    case 'searchResults':   return renderMod.renderSearchResults(value)
    case 'pipelineCard':    return renderMod.renderPipelineCard(value)
    case 'pipelineNodes':   return renderMod.renderPipelineNodes(value)
    case 'pipelineRoadmap': return renderMod.renderPipelineRoadmap(value)
    case 'eventTimeline':   return renderMod.renderEventTimeline(value)
    case 'taskStatus':      return renderMod.renderTaskStatus(value)
    case 'issueStatus':     return renderMod.renderIssueStatus(value)
    case 'dashboard':       return renderMod.renderDashboard(value)
    case 'action':          return renderMod.renderActionConfirm(value, actionName || '操作')
    default:                return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }
}

/** 从模板字符串 + args 构建 presentCall title */
function resolveTitle(template: string, args: Record<string, unknown>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    const v = args[key]
    return v != null ? String(v) : ''
  })
}

// ── 工厂函数 ──

/** 参数属性定义（保留旧接口兼容） */
export interface SimpleToolDef {
  name: string
  description: string
  parameters: Record<string, ParamSpec>
  execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
}

/** 构造 dsh ToolDefinition 对象（旧接口，无 presentCall/presentResult） */
export function makeTool(def: SimpleToolDef): Record<string, unknown> {
  return {
    name: def.name,
    description: def.description,
    parameters: buildParameters(def.parameters),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        return [{ type: 'text', text }]
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown> {
      return await def.execute(args as Record<string, unknown>, exec.signal)
    },
  }
}

/**
 * 从 ToolConfig 构建完整的 dsh ToolDefinition（含 presentCall/presentResult/render）。
 */
export function makeToolFromConfig(
  config: ToolConfig,
  cliConfig: GrapeCliConfig,
): Record<string, unknown> {
  return {
    name: config.name,
    // 交接类工具统一追加一句"这是把活交给流水线、不是你自己动手"（理由见 HAND_OFF_NOTE）
    description: HAND_OFF_TOOLS.has(config.name)
      ? config.description + HAND_OFF_NOTE
      : config.description,
    parameters: buildParameters(config.parameters),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => {
        const text = renderValueSync(config.renderType, value, config.actionName)
        // 结果文本就是纯展示内容 —— 不再附任何机器标记（原因见 execute 里那段说明）
        return [{ type: 'text', text }]
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown> {
      const typedArgs = args as Record<string, unknown>

      let result: unknown

      if (config.isPoll) {
        // 轮询工具特殊处理
        const seq = typedArgs[config.isPoll.seqArg] as number
        const timeout = (typedArgs[config.isPoll.timeoutArg] as number) ?? 30
        const interval = (typedArgs[config.isPoll.intervalArg] as number) ?? 3

        // 如果有 owner/repo/number 参数，传入用于查完整流水线快照
        const owner = typedArgs.owner as string | undefined
        const repo = typedArgs.repo as string | undefined
        const number = typedArgs.number as string | undefined
        const repoInfo = owner && repo && number ? { owner, repo, number } : undefined

        result = await pollGrapeUntilTerminal(cliConfig, seq, timeout, interval, exec.signal, repoInfo)

        // 超时时不抛异常——正常返回当前状态 + 流水线快照
        // 让模型看到"还在 running"然后决定是否再次调用 wait_task
        const resultObj = result as Record<string, unknown>
        const status = (resultObj?._event_status as string) || (resultObj?.status as string) || 'unknown'
        // 如果不是终态，在结果里加一个提示字段，模型会看到
        if (status && !['completed', 'failed', 'cancelled'].includes(status)) {
          if (resultObj && typeof resultObj === 'object') {
            resultObj._still_running = true
            resultObj._suggestion = `Task is still ${status}. Call grape_wait_task again with the same event_seq to continue monitoring.`
          }
        }
      } else {
        // 普通工具：拼 args + 执行 CLI
        const args2 = config.cliArgs(typedArgs)
        result = await execGrape(cliConfig, args2, exec.signal)
      }

      // 🔴 这里原本把 `_focus`（"AI 当前在看哪个 issue"的完整对象）塞进**工具结果值**，
      //    再由 render 在展示文本末尾附一段 `<!--grape-focus:…-->` 标记，供客户端侧栏解析。
      //
      // 2026-10-23 移除，两个原因：
      //   ① 工具结果值是**模型也会读到的内容** —— 每次 Grape 工具调用都白背一份用不上的 JSON；
      //   ② "AI 在看什么"这个 UI（侧栏 AI 焦点卡）已按用户判断删掉，
      //      剩下唯一需要它的行为是"AI 调 Grape 工具时自动切到侧栏 Tab"，
      //      而那个已经从**工具调用参数**（client 侧 `StartedToolCall.argsRaw`）拿到了，
      //      不需要宿主往结果里塞任何东西。
      //
      // 注意：各工具配置里的 `focus:` 构造器**仍在原位但现在不产生任何可观察效果**
      //（约定见下面 ToolConfig.focus 的注释）。
      // 结果补充（如场景节点）：失败静默，主结果照常返回
      if (config.enrich) {
        try { result = await config.enrich(typedArgs, result) } catch { /* 渲染侧会退化处理 */ }
      }

      // 预渲染文本，存到 result 上供 render 同步读取
      // dsh 的 render 是同步的，不能 await
      // 所以我们在 execute 里预先算好渲染文本，放到一个 wrapper 里
      return result
    },

    // presentCall：工具开始执行前给用户看的卡片
    presentCall: config.presentCall
      ? (args: unknown) => {
          const typedArgs = args as Record<string, unknown>
          const title = resolveTitle(config.presentCall!.title, typedArgs)
          return {
            card: 'generic' as const,
            title,
            kind: config.presentCall!.kind || 'other',
          }
        }
      : undefined,

    // presentResult：工具执行完成后给用户看的结果卡片
    presentResult: (args: unknown, result: { content: unknown[]; isError: boolean; meta?: unknown }) => {
      if (result.isError) return undefined

      // 从 result.content 提取值——dsh 的 render 输出在 content[0].text 里
      // 但我们需要原始 value，不是 render 后的文本
      // presentResult 拿到的是 ToolResult，不含原始 value
      // 所以这里只能基于 args 生成标题，content 用 render 的文本
      // 官方工具也是这么做的：presentResult 的 content 是可选的，省略时保持 render 输出

      const typedArgs = args as Record<string, unknown>

      // 对于有 presentCall 的工具，生成结果标题
      if (config.presentCall) {
        const baseTitle = resolveTitle(config.presentCall.title, typedArgs)
        return {
          card: 'generic' as const,
          title: baseTitle,
        }
      }

      return undefined
    },
  }
}
