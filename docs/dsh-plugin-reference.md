# dsh 插件架构速查

> 来源：deepseek-ai/deepseek-harness 仓库文档（docs/architecture.zh.md、docs/cookbook/*）。

## 核心理念

**Everything is a Plugin.** 没有特权内核。模型适配器、工具注册表、会话日志、agent loop 本身全是插件。扩展方式是把插件挂载到其他插件旁边，注册是副作用，卸载时自动撤销。

## 插件三种形态

```typescript
// 1. 函数形式
export const name = 'my-plugin'
export const inject = ['tools']
export function apply(ctx: Context) { ctx.tools.register(...) }

// 2. 对象形式
export default { name, inject, apply(ctx) { ... } }

// 3. 类形式（Service，供其他插件消费）
export default class MyService extends Service {
  static inject = ['tools']
  constructor(ctx) { super(ctx, 'myService') }
}
```

## Profile 与组合包

- **Profile**：存放在 Harness home 的具名组装，列出叠放的组合包。模板：`web`/`headless`/`sdk`/`sdk-minimal`/`acp`
- **Bundle**：Cordis 配置项 + 挂载代码的分发格式，npm 包中 `dsh.bundle` 字段指向 patch 文件
- **Patch**：YAML 文件，按 id 定位条目替换或插入新条目

层优先级：profile bundles → cordis.patch.yml → home patch → --patch overlay

## 关键扩展点

| 目标 | 机制 |
|------|------|
| 添加模型提供方 | `ctx.llm` 注册适配器 |
| 添加面向模型的工具 | `ctx.tools.register(defineTool({...}))` |
| 添加 shell 执行 | `ctx.shell` 后端 |
| 添加持久化终端 | `ctx.terminals` + `dsh-tool-terminal` |
| 添加用户命令 | `ctx.commands` |
| 管理后台任务 | `ctx.jobs` |
| 外部 webhook 触发 | `ctx.webhookRuntime` |
| 文件系统访问/策略 | `ctx.fs` 提供方 |
| 限制启动进程 | `ctx.sandbox` 后端 |
| 拦截请求/工具/轮次 | `agent/*` 或 `tools/*` 事件 |
| 注入模型可见上下文 | `agent.inject()` |
| 子代理委派 | `ctx.subagent`（startActivation） |

## 工具定义（defineTool）

```typescript
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: {
    path: { type: 'string', required: true, description: 'Absolute path' },
    limit: { type: 'number' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    // args 已验证（类型/必填/约束）
    // exec.signal 是 AbortSignal，必须响应取消
    // 返回值匹配 output.schema，自动冻结+验证
    return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
  },
}))
```

### execute 契约要点

- **参数已验证**：defineTool 在 execute 前验证类型/必填/约束
- **返回一个 JSON 值**：不返回 content blocks，返回 output.schema 匹配的值
- **响应 signal**：cancel 时终止 in-flight 工作
- **抛出 = isError**：registry 捕获并标记为错误结果

## 工具执行流水线

```
tools/pre-execute (waterfall, 可拦截/拒绝)
  → tools/execute (around-dispatch, 可包装超时/重试/指标)
    → tools/post-execute (结果变换)
      → tools/result (最终观察)
```

- `tools/pre-execute`：权限网关，返回 deny 可拒绝
- `tools/execute`：包装执行生命周期（超时/重试/指标）
- `tools/post-execute`：结果变换
- `tools/result`：不可变最终结果观察

## 插件包结构

```
packages/<group>/<pkg>/
  package.json     # @deepseek-ai/dsh-<name>, private: true, dsh.bundle 声明
  tsconfig.json    # extends tsconfig.base.json
  src/index.ts     # 插件入口
  locale/en.json   # 显示元数据
  locale/zh.json
  README.md
```

## 插件挂载（树外）

独立 npm 包通过 `cordis.patch.yml` 挂载，不需要 fork dsh 仓库：

```yaml
- id: my-plugin
  name: '@my-org/dsh-my-plugin'
  config:
    foo: bar
```

或通过 `dsh plugin install @my-org/dsh-my-plugin` 安装。

## 查看当前插件树

```bash
dsh --profile web --dump-config
```

## 参考文档

- 架构：docs/architecture.zh.md
- 扩展 cookbook：docs/cookbook/extension-cookbook.md
- 添加工具：docs/cookbook/adding-a-tool.md
- 添加包：docs/cookbook/adding-a-package.md
- 能力 seam：docs/capability-seams.md
- 工具执行流水线：docs/tool-execution-pipeline.md
