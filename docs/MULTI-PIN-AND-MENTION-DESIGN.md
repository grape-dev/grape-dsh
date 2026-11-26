# 多 issue 并行观察 + `@` 引用 issue —— 设计文档

> 状态：**待确认方向**（按惯例：设计先行，确认后再动手）
> 前置：右栏浏览面板 P1–P5 已完成（`RIGHT-PANEL-BROWSER-DESIGN.md`）
> 实测环境：dsh `0.2.0-rc.2` + grape-dsh v0.3.2

---

## 1. 需求（用户原话）

> 目前我想开发一个使用逻辑，在右边的浏览中选定的仓库 issue 的跟随此 issue，点击后，
> 把这个 issue 变成一个**可展开的卡片放到实时的界面**，这样**可以同时并行观察多个 issue 进度**，
> 同时跟随的 issue 能不能在对话框中加入一个**类似 `@` 目标文件的功能，可以快速指定 issue，
> 对 issue 发出指令、对话**。

拆成两件事：

- **A. 多卡并行观察**：`跟随此 issue` 从「替换唯一焦点」变成「**加入观察列表**」，
  实时界面同时挂多张可展开的 issue 卡。
- **B. `@` 引用 issue**：在对话输入框里像 `@文件` 那样指定一个已跟随的 issue，
  然后对它下指令（"这个 issue 现在卡在哪了""帮我推进到下一步"）。

---

## 2. 关键实测发现（决定了可行性）

### 2.1 `@` 触发器是官方能力，契约完整

官方包 **`@deepseek-ai/dsh-client-ui-input-trigger`**，客户端服务 `ctx.inputTriggers`：

```ts
ctx.inputTriggers.registerSource({
  trigger: '@' | '/',
  name: string,                    // 菜单分组名（同 trigger 下唯一，重复注册抛错）
  order?: number,                  // 分组显示顺序
  candidates(session, { query, position, drilled, signal })   // 菜单候选行
        → Promise<InputTriggerCandidate[]>,
  onPick(pick) → PickOutcome,      // 关键：返回什么决定插入什么
  codec?: ReferenceCodec,          // 产出 ReferenceInsert 时**必需**
  lexicon?(session), subscribeLexicon?, warm?, header?, matchSpace?, matchEnter?, openReference?
}): () => void                     // disposer
```

`PickOutcome` 的四种形态（`dsh-client-ui-conversation/client`）：

| 形态 | 含义 |
|---|---|
| `{ claim: CommandClaim }` | 进入命令模式（`/` 那套） |
| **`{ insert: ReferenceInsert }`** | **插入结构化引用** ← 我们要的 |
| `{ text, continue? }` | 插入纯文本 |
| `'handled'` / `undefined` | 已处理、或让给下一个源 |

`ReferenceInsert`：

```ts
{
  source: string         // 我们的源名（如 'grape-issue'）
  ref: string            // 我们自己的不透明 id（如 'gitcode:wdmike/snake-game-9#3'）
  label: string          // 输入框里显示的胶囊文字
  appearance?: 'session' | 'file' | 'folder'   // 胶囊图标风格
  clipboardText: string  // 复制/持久化时的样子
}
```

`ReferenceCodec`：

```ts
{
  clipboardText(ref): string,                    // 复制出去的样子
  serialize(ref, signal): Promise<string>,       // ⭐ **模型实际看到的文本**（异步；失败阻止发送，不静默降级）
}
```

→ **"对 issue 发出指令"成立**：`serialize()` 可以把 issue 身份写成模型能直接用的结构化文本。
这正是 `@文件` 的机制。

### 2.2 两条插入路径（都已验证存在）

| | (a) 注册 `@` 源 | (b) 程序化插入 |
|---|---|---|
| 触发方式 | 用户打 `@` → 弹菜单 → 选一项 | 代码直接插入（按钮/快捷键） |
| 实现 | `ctx.inputTriggers.registerSource(...)` + `onPick` 返回 `{insert}` + `codec` | `ctx.get('conversation').input.for(sessionScope).addFiles([reference], [])` |
| 模型侧文本 | **我们自己的 codec 说了算** | 沿用内置 `reference` 源的 codec（= 文件提及语义） |
| 先例 | 官方内置 `@文件` | `dsh-at-sider`（右栏 Files 每行一个 `@` 按钮） |

`dsh-at-sider` 的实测代码（已 clone 到 `/root/dsh-plugin-refs/at-sider`）：

```js
const scope = ctx.get('sessions').scope(sessionId)
const input = ctx.get('conversation').input.for(scope)
return input.addFiles.call(input, [reference], []) === true
```

它的注释原文："the same `{ insert: ReferenceInsert }` outcome the built-in `@` source and
the built-in file drop produce" —— 两条路收敛到同一个 outcome。

⚠️ **但 (b) 的语义是"文件提及"**：它复用了内置 `reference` 源的 codec，
`ref` 会被当成**文件路径**序列化给模型。我们的 issue 不是文件，走 (b) 会让模型看到一个
并不存在的路径。→ **必须走 (a)，带我们自己的 codec。**

### 2.3 CLI 单次调用耗时（决定轮询策略）

| 命令 | 平均 |
|---|---|
| `repos managed` | **181 ms** |
| `issues list` | **193 ms** |
| `issues pipeline` | **280 ms** |

很快 —— 多卡轮询在成本上完全可行（5 个 pin × 每 20s 一次 ≈ 每分钟 4 秒 CPU）。

### 2.4 生态先例

- `dsh-at-sider`（右栏 → `@` 引用，已读源码）
- `dsh-subagent-monitor`（"live subagent run monitor：侧栏 footer 触发器 + 固定右上角面板" —— 多目标并行观察）
- `dsh-pinned-sessions`（pinned 分组模型）
- `dsh-math-snippets`（输入框内触发器：LaTeX 片段展开）

---

## 3. 方案 A：多卡并行观察

### 3.1 数据模型：从「单焦点」到「焦点 + 若干 pin」

现状（`src/client/store.ts`）：只有一个 `current: GrapeFocus` —— AI 调工具时由工具结果里的标记驱动。

新增 `src/client/pins-store.ts`：

```ts
interface Pin {
  id: string                 // 'owner/repo#number'（天然去重键）
  owner: string
  repo: string
  number: number
  title?: string             // 来自点击时那一行，省一次请求
  platform?: string
  expanded: boolean          // 卡片是否展开
  data: unknown | null       // /pipeline 的最新结果
  loading: boolean
  error: string | null
  updatedAt: number
  pinnedAt: number
}
```

### 3.2 实时界面的布局

```
┌─ 实时 ──────────────────────────┐
│ AI 当前焦点卡（被动，自动跟随）      │  ← 保持现状不变
│   Issue #11 … VOD→ISSUE→CODING…  │
│                                   │
│ ── 观察中 (3) ──        [全部刷新] │  ← 新增：pin 区
│ ▸ #3 probe-confirm-test   ● 处理中 │  收起态：一行
│ ▾ #11 Worker 版本信息      ● 已完成 │  展开态：节点链 + 摘要 + 操作
│      VOD✓→ISSUE✓→CODING●→QA○      │
│      最近：合并 PR · 49 天前        │
│      [在官网打开] [取消跟随] [刷新]  │
│ ▸ #2 扩展游戏功能          ● 活跃  │
└───────────────────────────────────┘
```

- **为什么 AI 焦点卡保留在顶部**：它是"AI 正在做什么"（被动），pin 是"我要盯什么"（主动）。
  两者语义不同，不该混成一张卡。
- **pin 卡收起态**只显示一行（编号/标题/状态点/状态），展开才给节点链 —— 延续本面板
  "默认收起、计数可见"的既有规矩（面板竖向空间有限，评审提过三次）。

### 3.3 轮询

- 每个 pin 每 **20s** 拉一次 `/grape-panel-api/pipeline`（不需要 `force`，
  宿主 30s TTL 缓存会吃掉一半请求 → **上游实际调用 ≤ 2 次/分/pin**）。
- **`document.hidden` 时暂停**（后台标签页不该持续 spawn 子进程）；恢复可见时立刻补一次。
- **上限 8 个 pin**（约束轮询成本，超出时提示先取消几个）。
- 手动「刷新」= 该卡 `force=1`；「全部刷新」= 遍历 force。

### 3.4 ⚠️ 这会**取代** P3 的行为

P3 的「跟随此 issue」是：**设为主焦点 → 切实时模式**（单焦点模型）。
本需求把它改成：**加入观察列表 → 切实时模式**（多 pin 模型）。

- 不再抢 AI 焦点卡（那本来是被动槽位，用主动动作去覆盖它是语义混用）。
- 若 AI 正好也在操作同一个 issue：**pin 卡与 AI 焦点卡同时存在**（一个是"我在盯"，
  一个是"AI 在做"）—— 是否要**合并成一张并标记**，见 §5 待定项 Q4。

---

## 4. 方案 B：`@` 引用 issue

### 4.1 注册一个 `@` 源

```ts
// src/client/grape-mention.ts
ctx.inputTriggers.registerSource({
  trigger: '@',
  name: 'Grape issue',        // 菜单里的分组名（与内置「文件」并列）
  order: 10,                  // 排在文件之后
  warm(session) { /* 预取：无（候选来自本地 pin 列表，不请求） */ },
  candidates(session, req) {  // ← 同步可用的本地数据，零请求
    return pins()
      .filter(p => !req.query || match(p, req.query))
      .map(p => ({
        name: p.id,                                  // 'owner/repo#3'
        label: `#${p.number} ${p.title ?? ''}`,       // 显示
        description: `${p.owner}/${p.repo} · ${statusOf(p)}`,
        icon: 'file',                                // 复用官方 file 字形
        value: p.id,
      }))
  },
  onPick(pick) {
    const p = pinById(pick.candidate.value)
    if (!p) return undefined
    return { insert: {
      source: 'grape-issue',
      ref: p.id,                                     // 'gitcode:owner/repo#3'
      label: `#${p.number} ${p.title ?? ''}`,
      appearance: 'file',
      clipboardText: `@#${p.number} ${p.title ?? ''}`, // 复制出去的样子
    } }
  },
  codec: {
    clipboardText: (ref) => ref,
    // ⭐ 模型实际看到的东西
    async serialize(ref) { return formatForModel(ref) },
  },
})
```

### 4.2 `serialize()` 写成什么（这一句决定模型能不能用对）

候选句式：

| 方案 | serialize 输出 | 评价 |
|---|---|---|
| a 裸引用 | `@gitcode:wdmike/snake-game-9#3` | 模型可能当成文件路径 |
| **b 结构化标签** ⭐ | `<grape-issue repo="wdmike/snake-game-9" number="3" platform="gitcode" title="…"/>` | 自解释、字段明确、与工具的 owner/repo/number 参数直接对应 |
| c 自然语言 | `[Grape issue wdmike/snake-game-9 #3 「probe-confirm-test」]` | 好读，但字段边界弱 |

**推荐 b**（配合工具 description 里一句"出现 `<grape-issue>` 标签时用其中的 repo/number 调用工具"），
理由是它与现有 33 个工具的参数天然对齐，模型不用猜。

### 4.3 候选集 = **已跟随的 pin 列表**

- **不做全量 issue 搜索**：Grape 没有跨仓 issue 搜索接口（`issues list` 必须带 owner/repo）。
- pin 是用户主动标记"我在乎"的集合 → 正是 `@` 该列出的一批。
- 零请求（本地数据）→ 菜单即时。这也是 `warm` 不需要预取的原因。
- 附加好处：**pin 与 `@` 共用同一份数据**，用户在 A 里跟随，在 B 里就能 `@` 到 —— 闭环。

### 4.4 还需要确认的机制细节（实现时实测）

1. `ctx.inputTriggers` 是否可直接 `ctx.get('inputTriggers')`（服务名 = 契约里的 `inputTriggers`）
   ——按契约 `Configuration Context` 声明了它，应该能。
2. 内置 `@文件` 源的 `name` 是什么（决定我们的分组是否与它冲突、`order` 怎么排）。
3. 引用胶囊被删除/复制时的回调（若要在"取消 pin"时同步清理引用，需要知道是否有钩子；
   没有的话就容忍"输入框里留着一个已取消 pin 的引用"）。

---

## 5. 待你拍板的决策点

| # | 问题 | 我的建议 |
|---|---|---|
| **Q1** | 「跟随此 issue」是否仍要**同时设为 AI 焦点卡**？ | **不要**。AI 焦点卡是被动槽位；跟随 = 加入 pin。两者同屏并列（若关注同一 issue 则出现两张，语义不同） |
| **Q2** | pin 卡默认展开还是收起？ | **收起**（一行摘要），手动展开。延续本面板既有规矩，避免挤掉主内容 |
| **Q3** | 轮询间隔 / 上限？ | 20s（有 30s 缓存兜底）+ 上限 8 + 后台暂停。要更实时可调 10s，代价是上游调用翻倍 |
| **Q4** | AI 焦点与某个 pin 是同一个 issue 时，合并还是并列？ | **并列**（先简单），后续可在 pin 卡上加"AI 正在操作"标记 |
| **Q5** | `@` 的候选是否也包含**当前浏览视图的 issue**（不止 pin）？ | **只含 pin**（零请求、语义清晰）；要扩展到"当前仓库 issue"就得接受一次 `issues list` 请求 |
| **Q6** | `serialize()` 句式选 b（结构化标签）还是 c（自然语言）？ | **b** |

---

## 6. 分期

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P1** | pin store + 实时界面多卡（收起/展开、单/全刷新、取消跟随、上限、后台暂停轮询） | ✅ 已实测 |
| **P2** | `@` 源注册 + codec + 结构化 serialize + 分组/顺序调优 | ✅ 已实现（发送链路被环境阻塞，见下） |

### P2 实现要点与实测（2026-10-23）

**机制落地**（`src/client/grape-mention.ts`）：

- 用 `ctx.inject(['inputTriggers'], cb)` 取**可选依赖**（无该服务的部署仍正常加载，只是少一个菜单），
  与宿主侧 webServer 同一写法。注册用 `ctx.effect(...)` 包住（内置源也是这么写的）。
- 源参数：`trigger: '@'`、`name: '已跟随的 issue'`、`order: -1`。
  ⚠️ **`name` 就是菜单里的分组标题**（实测：写 `grape-issue` 就原样显示 `grape-issue`），
  所以直接写用户看得懂的中文。`order: -1` 排在最前 —— 用户钉 issue 就是为了"快速指定"，
  排在 ~20 个文件 + ~10 个会话之后等于把"快速"抵消掉。
- **必须自带 codec**：内置 `@文件` 源的 codec 是 `serialize: ref => ref`（文件提及原样送模型），
  复用它会让模型看到假路径。我们自己的 `serialize` 产出：
  ```
  <grape-issue repo="wdmike/snake-game-9" number="1" platform="gitcode" title="引导·部署贪吃蛇游戏"/>
  ```
- `lexicon()` 用于把正文里的 `@<name>` 上色，`subscribeLexicon` 在 pin 增删时通知重取。

**实测（浏览器直连 DOM + 单元验证）**：

| 项 | 结果 |
|---|---|
| 源注册 | `@` 菜单出现三组，我们的组**排在最前**，标题 `已跟随的 issue` ✓ |
| 候选来自 pin | 行内容：`#1 引导·部署贪吃蛇游戏`（label）+ `wdmike/snake-game-9#1`（name 别名）+ `wdmike/snake-game-9 · 已完成`（description）✓ |
| 选取插入 | 输入框出现 `data-composer-chip="grape-issue"` 的引用胶囊，官方 chip 样式 + 文件字形；Enter 选取路径（菜单高亮项）✓ |
| 草稿持久化 | 刷新后草稿恢复，胶囊降级成 `clipboardText`（`@owner/repo#N`）—— 契约里 clipboardText 就是这个用途 ✓ |
| **serialize 输出** | 用真实编译产物跑单元验证 **10/10**：完整标签、属性齐全、特殊字符转义（`&quot;` `&amp;` `&lt;`）、**异常输入一律不抛错**（解析不了就退化为 `[Grape issue <ref>]`）✓ |

**✅ 端到端全链路已验证（2026-10-23，会话落盘为证）**

| 环节 | 证据 |
|---|---|
| `@` 菜单 | 我们的组排最前、标题 `已跟随的 issue`、候选来自 pin 列表 |
| 选取 | 输入框出现 `data-composer-chip="已跟随的 issue"` 的引用胶囊（官方 chip 样式） |
| 发送 | 消息**成功落盘**（不再被 reject） |
| 模型侧文本 | `user/message seq 9` = `<grape-issue repo="wdmike/snake-game-9" number="1" platform="gitcode" title="引导·部署贪吃蛇游戏"/>` |
| 模型是否认对 | 用户从未打过仓库名，模型仍调了 `grape_get_issue_detail` / `grape_get_issue_events` / `grape_get_pipeline_info`，参数 `owner=wdmike repo=snake-game-9 number=1` **全对** ✓ |

**🔴 根因（曾误诊两次，记录以免重演）**：带引用的消息发不出去，**不是连接问题、也不是审批弹窗**，
而是**源名不一致**。dsh 安装源码 `InputTriggerController.serializeReference`：

```js
const owner = this.deps.roster.all().find((s) => s.name === source)
if (owner?.codec === void 0) reject(`slash: no serializer for reference source "${source}"`)
```

**发送时按 `source` 名字反查源、再取它的 codec**；官方注释明写 "Owner missing or codec-less
rejects — the submit attempt blocks instead of silently downgrading to the clipboard text"。
我注册时 `name: '已跟随的 issue'`（菜单分组标题就是这个字段），但 `onPick` 里发的
`insert.source: 'grape-issue'` → 反查失败 → **整条消息被阻止**。
修复：**一个常量同时用于注册名与 insert.source**（路由契约要求两者必然相同，两个不同的字面量
根本无法满足）。

**教训**：①菜单分组标题就是源的 `name`，它同时是**路由键**，不能当成纯展示文案随便起；
②"消息发不出去"先查有没有带引用 —— 带引用时走 `serializeReference` 反查，不带引用时不走。

**遗留小问题**：刷新后草稿里的 `@wdmike/snake-game-9#1` 只被 lexicon 部分上色（`@wdmike/` 成了
textRef，`#1` 没进）→ 装饰器可能把 `#` 当分隔符。不影响主路径（胶囊），后续可考虑把 lexicon
的 name 改成不含 `#` 的形式。
| **P3** | pin ↔ 浏览联动、拖拽排序、持久化 | ✅ 已实测 |

### P3 实现要点与实测（2026-10-23）

**持久化**：`localStorage['grape-dsh.pins.v1']`（沿用 dsh 客户端自己的「模块常量作 key」风格 + 版本号）。
- **只存身份**（owner/repo/number/title/platform/pinnedAt），**不存拉到的数据**：流水线状态是会过期的，
  存进去刷新后会先画一帧过期状态再被覆盖，比暂时没数据更糟。恢复后立刻重拉一次。
- **展开态刻意不持久化**：恢复一屏展开的卡会把列表压没。
- 读存档任何异常都退化成空列表；写失败（配额/隐私模式）静默降级 —— 两者都不该把面板拖垮。
- 顺序也持久化（拖拽结果刷新后保持）。
- 实测：钉 2 张 → 刷新 → `观察中 (2)` 两张都回来，且状态/进度是**新拉**的。

**拖拽排序**：卡片整体可拖；落点用**一条 2px 线**表示，不让被拖卡片位移/缩放
（竖向列表里位移变形很难看，且用户对 hover 位移明确反感）。
落点按指针在卡片的**上/下半**判定 → 覆盖全部插入位置，**无需额外的空白投放区**
（最后一张的下半即"列表末尾"）。
- 实测：`["#2","#3"]` 拖 #3 到 #2 上半 → `["#3","#2"]`，过程中落点线 1 条，存档顺序同步。

**pin ↔ 浏览 双向联动**：
- 浏览列表每行末尾加 pin 切换（**不钻进去就能钉**）。放在钻取箭头**之前**，箭头保持行末语义。
  `stopPropagation()` 必须加 —— 外层 `Row` 是 role=button，不吃事件就变成"每次想钉都被带进下一页"。
- **反馈就是图标本身**（实心品牌紫 ↔ 空心灰），到上限置灰 + tooltip ——
  这里刻意不弹提示：提示只由实时面板渲染，在浏览面板弹等于让用户看不到（前面踩过这个坑）。
- 卡片的「在浏览中打开」把导航栈构造成 `仓库列表 → issue 列表 → 流水线详情`，
  这样按一次「返回」落在**该仓库的 issue 列表**，而不是被打回根目录。
- 实测：行内钉 #2/#3 图标翻转且**未钻取**；点「在浏览中打开」→ 模式切到浏览、落在 #3 的流水线详情 + 事件明细。

### P1 实现要点（2026-10-23 实测）

- **新增 `src/client/pins-store.ts`**：pin 列表 + 轮询 + 上限 + 可见性感知。
- **⭐ 渲染复用**：`pinToFocus(pin)` 把 `/pipeline` 数据组装成 `GrapeFocus`，交给实时面板
  现有的 `FocusBody` 渲染 —— pin 卡与 AI 焦点卡**共用同一套渲染**（节点链/进度条/逃生舱），
  不会出现"同一个 issue 两处长相不同"。与 P3「焦点在宿主侧构造」是同一个原则。
- **"跟随"语义变更**：不再 `setFocus`（单焦点），改为 `addPin`（多卡）。AI 焦点卡是被动槽位，
  不应用主动动作覆盖 → 两者同屏并列、互不干扰。若 AI 恰好在同一 issue 上，会出现两张卡（**并列**，Q4 决策）。
- **实测数据**：CLI 单次 181–280ms → 2 张 pin 23 秒内正好 +2 请求（每卡 1 次/20s）；
  收起态给 `3/3` 进度与状态 Tag，展开后是完整 `FocusBody`；取消跟随 `(2)→(1)` 且不影响他卡；
  重复跟随返回 `已在观察中` 且**不产生重复卡**。
- **踩坑（重要）**：提示文案原本写在浏览面板里 → 但「跟随」会立刻切到实时、浏览面板随即卸载，
  **提示永远看不到**（死代码）。改为放进 pins-store、由实时面板渲染。
- **空态占位移除（用户要求）**：原焦点的空态是居中一块「等待 AI 操作 Grape… + 副文案」。
  用户明确说不要 —— 该面板的实际用法是"我盯着的 issue 列表"，空态只是噪声；新增 issue 时
  下方自动多一张卡就够了。现在无焦点时**整块不渲染、不占高度**，面板纯粹是 pin 列表
  （无 pin 时完全空白）。实测：空面板 innerText 为空串、无残留空隙。
- 评审后修正：提示**内联进标题行**（单独一行会把卡片顶下去再弹回，抖动）；收起态去掉与状态
  Tag 重复的状态点；取消跟随改用官方 `IconCloseOutlineRegular`；焦点区加「AI 焦点」区名
  （与「观察中」对称，否则两区边界只由一条细线承担）。
- ⚠️ **未做浏览器实测**：上限 8 的分支（需手工钉 8 个 issue，约 2 分钟点击）—— 逻辑是
  `pins.length >= MAX_PINS → 'full'`，与已验证的 `exists` 分支共用同一条提示通道。
| **P3**（可选） | pin ↔ 浏览联动（pin 卡点进去直接跳浏览对应流水线）、pin 顺序拖拽、持久化到 profile | 打磨 |

**建议 P1、P2 分两次做**，各自独立可测；P1 先跑通再进 P2（P2 依赖 pin 列表）。

---

## 7. 风险

1. **`inputTriggers` 的实际可用性**：契约齐全，但 `ctx.get('inputTriggers')` 能否拿到、
   埋点是否要求 client `inject` —— 实现时先写 5 行探针验证（不要一上来写完整功能）。
2. **引用胶囊与 pin 生命周期不同步**：取消 pin 后输入框里可能残留引用 → 见 §4.4-3。
3. **轮询 + CLI spawn**：单次 280ms 很快，但仍是子进程；上限 8 + 后台暂停是硬约束，不能省。
4. **`@` 菜单与内置「文件」分组冲突**：`name` 需唯一，`order` 需实测（内置可能是 0）。
5. **`serialize` 失败会阻止发送**（契约明确）→ 我们的 `serialize` **不能抛错**；
   `ref` 解析失败时也要返回一个降级文本（宁可文本不完美，也不能让用户发不出消息）。
6. **边界不变**：pin 与 `@` 都**不写**任何东西 —— 指令仍由 AI 走既有 9 个写工具 + 写确认。
   `@` 只是"把目标说清楚"，不绕过确认。

---

## 8. 验收标准（实现后照此实测）

**A 多卡**
- [ ] 浏览里对 3 个 issue 点「跟随此 issue」→ 实时界面出现 3 张卡，且**互不覆盖**
- [ ] 每张卡可独立展开/收起、单独刷新；「全部刷新」生效
- [ ] 「取消跟随」后卡片消失；全部取消后 pin 区不占位
- [ ] 上限 8 生效；切到后台标签页后轮询停止（实测网络面板无新请求），切回立刻恢复
- [ ] AI 调工具产生的焦点卡**不受 pin 影响**（仍是独立一张）

**B `@` 引用**
- [ ] 输入框打 `@` → 菜单出现「Grape issue」分组，列出 pin 的 issue
- [ ] 选中后输入框出现引用胶囊，文字为 `#N 标题`
- [ ] **发出的消息里，模型收到的是结构化引用**（在 session 事件里核对 `serialize` 输出）
- [ ] 模型能据它调对工具（如 `grape_get_pipeline_info` 用对 owner/repo/number）
- [ ] 复制该引用 → 粘贴得到 `@#N 标题`
- [ ] pin 列表为空时，`@` 菜单不出现该分组（不显示空分组）
- [ ] 取消 pin 后 `@` 菜单不再列出它（已插入的引用不报错、不阻塞发送）

---

## 9. 与既有原则的一致性检查

| 原则 | 本设计 |
|---|---|
| 只触发、只观察、可推进、不干预 A2A 交接 | ✅ pin 只读；`@` 只是指代目标，指令仍走 AI 工具 + 写确认 |
| 凭据不出宿主 | ✅ `@` 与 pin 都走宿主代理 `/grape-panel-api` |
| 浏览面板纯只读 | ✅ 不变 |
| 浮层实底、画布可半透明 | ✅ pin 卡是画布上的卡（可半透明底），不新增浮层 |
| 默认收起、计数可见 | ✅ pin 卡收起，观察中 (N) 显示数量 |
| 不改造官方插件核心流程 | ✅ 新增自己的 `@` 源，不动内置「文件」源 |