/**
 * 侧栏 Tab 的外壳：在同一个 Tab 内切换两种模式。
 *
 *   [ 实时 · 浏览 · 本机 ]
 *    实时 = GrapeFocusPanel（主动：我钉住的 issue 观察列表）
 *    浏览 = GrapeBrowsePanel（主动：仓库 → issue → 流水线）
 *    本机 = GrapeMachinePanel（把当前这台机器接入为 Grape Worker）
 *
 * 为什么合并成一个 Tab：右栏的 tab 位是稀缺资源，两种模式看的是同一件事
 * （Grape 平台状态）的不同切面，分两个 Tab 会把右栏塞满。
 *
 * ⚠️ 这里原本还有一段"AI 产生**新焦点**时自动切回「实时」模式"的副作用。
 * 随 AI 焦点卡一起删除了（2026-10-23）：
 *   · 实时面板现在只是**用户自己钉的观察列表**，AI 在别的 issue 上干活并不会改变它；
 *   · pin 卡本来就自己轮询，切不切模式都不会"错过更新"；
 *   · 而"AI 动起来了"这件事已由 `autoOpenOrSwitch()` 把整个 Tab 推到前面来体现，
 *     再顺手改掉用户当前正在看的模式（浏览 ↔ 实时）反而是抢他的注意力。
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { GrapeFocusPanel } from './GrapeFocusPanel.js'
import { GrapeBrowsePanel } from './GrapeBrowsePanel.js'
import { GrapeMachinePanel } from './GrapeMachinePanel.js'
import { getMode, setMode, subscribeMode } from './tab-mode.js'
import { prewarmRoot } from './browse-store.js'

/** SegmentedControl 的 base id（它会给每个 tab 生成 `<id>-<value>` 与面板 id） */
const SEG_ID = 'grape-tab-mode'

/** 侧栏 Tab 主体 */
export function GrapeTab(): ReactNode {
  // 模式放在模块级 store 里：浏览面板的「跟随此 issue」也要能切到实时模式
  const mode = useSyncExternalStore(subscribeMode, getMode)

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      // Issue #27 R4：预热改由「鼠标真的进入 Grape Tab」触发，而不是模块加载即发请求
      onMouseEnter={() => prewarmRoot()}
    >
      <div style={{ padding: '10px 14px 0' }}>
        <SegmentedControl
          id={SEG_ID}
          value={mode}
          options={[
            { value: 'live', label: '实时' },
            { value: 'browse', label: '浏览' },
            { value: 'machine', label: '本机' },
          ]}
          onChange={(next) => setMode(next)}
          label="Grape 面板模式"
        />
      </div>

      <div
        id={`${SEG_ID}-${mode}-panel`}
        role="tabpanel"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
      >
        {mode === 'live' ? <GrapeFocusPanel /> : mode === 'browse' ? <GrapeBrowsePanel /> : <GrapeMachinePanel />}
      </div>
    </div>
  )
}