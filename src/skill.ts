/**
 * 插件自带的默认 skill —— 用**行为约束**告诉模型：Grape issue 的实现不归你做。
 *
 * ## 为什么需要它（2026-10-23 实测的事故）
 *
 * 用户在一个工作区为本插件仓库（`/root/grape-dsh`）的会话里，用 `@` 引用了一个 Grape issue
 * 并说"在这个 ISSUE 中实现这个功能"。模型的反应是：
 *
 *   git clone 业务仓库 → edit 业务代码 → 写验证脚本 → git checkout -b feat/… →
 *   git commit → git push → 开 PR #1
 *
 * 全程**没有触发 Grape 流水线**（它明明有 `grape_start_issue` 可用），还在插件仓库里
 * 留下 `.scratch/` 污染工作区。根因有两条，都得治：
 *
 *   ① **工具描述太泛**：33 个工具都是 `[Grape-unique] Start/open an issue session.`
 *      这类英文短句 —— 它没说"什么时候该用"，更没说"不要自己动手"。模型只能按自己的
 *      通用开发习惯行事。
 *   ② **没有成体系的工作流说明**：散落在 33 条描述里的信息，拼不出"用户要我实现 issue 里的
 *      功能时，正确动作是把需求交进流水线"这个结论。
 *
 * 所以本文件提供插件的**默认 skill**（dsh 的 `ctx.skills` 运行时注册，无需文件、
 * 无需 provider 实现）—— 它作为"可被模型按需加载的完整规则"存在；同时 4 个交接类工具的
 * 描述里加一句短提示（见 `HAND_OFF_NOTE`），因为工具描述**始终**在上下文里，比 skill 更靠前。
 *
 * ## 为什么 skill 用中文
 * 这是给用户看、也给自己维护的规则文本，按本仓库「文档与 locale 全中文」的惯例写中文。
 * 若以后发现模型对英文规则遵循更好，改这一个文件即可。
 */

/**
 * skill 注册体的结构面（只声明我们真正用到的字段）。
 *
 * 刻意**不** `import type { SkillRegistration } from '@deepseek-ai/dsh-skill'`：
 * 那个包在 dsh 自己的 node_modules 下、不在本插件的依赖里，构建期解析不到。
 * 本仓库既有风格也是"只声明用得到的最小结构面"（见 cli-client / panel-api）。
 */
interface SkillRegistration {
  /** kebab-case 名称（dsh 的 isSkillName 校验） */
  name: string
  /** 一句话路由描述（进入模型的 skills 目录） */
  description: string
  /** 完整规则正文（被加载时进入上下文） */
  content: string
  /** 来源桶：'bundled' 表示随包分发 */
  source: string
  /** 调用策略；缺省表示模型与用户两侧都可用 */
  invocation?: { modelInvocable: boolean; userInvocable: boolean }
}

/** skill 名（kebab-case，dsh 的 isSkillName 校验） */
export const GRAPE_SKILL_NAME = 'grape-issue-workflow'

/**
 * 一句话路由描述（出现在模型的 skills 目录里）。
 *
 * ⚠️ 这段是**触发器**：模型靠它判断"该不该加载这个 skill"。
 * 必须写清触发场景（用户让你在某个 Grape issue 里实现/修改功能），
 * 而不是写"关于 Grape 的说明"——后者永远不会被匹配上。
 */
const DESCRIPTION =
  'Use when the user asks to implement, change, or publish something in a Grape issue ' +
  '(e.g. a <grape-issue repo=... number=.../> reference, or \"在这个 issue 里实现 X\"). ' +
  'Explains why the work belongs to the pipeline, not to you.'

/** 完整规则正文（被加载时进入模型上下文） */
const CONTENT = `# Grape issue 工作流

## 什么时候适用
用户提到一个 Grape issue —— 例如消息里出现 \`<grape-issue repo="owner/repo" number="3"/>\`
这样的引用，或说「在这个 issue 里实现/修改 X」「把这个需求发布到那个 issue」「让流水线处理」。
也适用于用户让你"验证/推进"某个 Grape issue 的时候。

## 铁律：实现代码的不是你
1. **Grape issue 的实现在该 issue 所属仓库的流水线里完成**
   （VOD → issue → coding → QA → SRE 等节点，由平台上的 agent 执行）。
   你的职责只有两件：**把需求交进去**，然后**观察与推进**。
2. **不要 clone 业务仓库、不要 edit/write 业务代码、不要自己建分支、不要自己开 PR。**
   你在本机改出来的东西**不会**进入这个 issue 的流水线；它只会污染工作区，
   并在用户的仓库里留下他没要的分支和 PR。
3. **你的工作区通常就是本插件自身的仓库，与用户的业务仓库无关。**
   在这里写任何业务代码都是错的判断。
4. 判断"流水线做到哪了"要看 \`grape_get_pipeline_info\` / \`grape_get_issue_events\`，
   不要靠读代码或猜。
5. 写操作会弹确认对话框 —— 那是**有意**的：它确认的是"要不要把这个动作交给 Grape"，
   不是在问"你要不要自己动手"。

## 标准做法
1. **先看清上下文**：\`grape_get_issue_detail\`、\`grape_get_pipeline_info\`；
   需要时再看 \`grape_get_issue_events\`、\`grape_get_pipeline_roadmap\`。
2. **需求已明确** → 把需求写成该 issue 的内容（描述/评论），再调 \`grape_start_issue\`
   （已启动过则 \`grape_resume_issue\`）让流水线接手。**这是唯一正确的"开始干活"动作。**
   也可以直接用 \`grape_create_issue\` 一步到位（建单 + 触发流水线）。
3. **需求不明确** → 问用户。不要自己替他决定实现细节、也不要"先做个原型"。
4. **之后观察**：\`grape_get_pipeline_info\` / \`grape_wait_task\`；
   卡住或失败时用 \`grape_trigger_pipeline\` / \`grape_resume_issue\` 推进。
5. **汇报时说清三件事**：需求是否已交给流水线、当前走到哪个节点、下一个节点是谁。

## 边界（本插件的既有原则，勿越）
**只触发、只观察、可推进**；不干预流水线节点之间的 A2A 交接。
需要看界面时用侧栏 Grape 面板（实时 = 我跟随的 issue 列表，浏览 = 仓库/issue/流水线），
而不是把平台状态复述成一大段文字。
`

/**
 * 注册插件的默认 skill。
 *
 * 用 \`ctx.inject(['skills'], cb)\` 取**可选依赖**：没有 skills 服务的部署
 * （headless / SDK-minimal）照常加载其余功能，只是少一条约束。
 * 用 \`ctx.effect(...)\` 包住注册，插件卸载时自动撤销（与其他注册一致）。
 */
export function registerGrapeSkill(ctx: {
  inject?: (names: string[], cb: (scoped: unknown) => void) => unknown
  effect?: (cb: () => unknown, label?: string) => unknown
}): void {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['skills'], (scoped) => {
    const skills = (scoped as { get?: (n: string) => unknown }).get?.('skills') as
      | { register?: (s: SkillRegistration) => () => void }
      | undefined
    if (!skills || typeof skills.register !== 'function') return
    const register = skills.register.bind(skills)

    const skill: SkillRegistration = {
      name: GRAPE_SKILL_NAME,
      description: DESCRIPTION,
      // source: 'bundled' —— dsh 的约定值：随包分发的 skill（rank 600，低于项目条目、
      // 高于用户条目）。同名的项目条目会覆盖它，这是对的：用户在自己的仓库里写规则应当赢。
      source: 'bundled',
      content: CONTENT,
      // 模型与用户两侧都可调用（用户也能在 / 菜单里主动加载它）
      invocation: { modelInvocable: true, userInvocable: true },
    }

    if (typeof ctx.effect === 'function') ctx.effect(() => register(skill), 'grape-dsh.skill')
    else register(skill)
  })
}