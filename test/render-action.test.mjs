/**
 * 动作确认行的编号展示（Issue #39 复审 Optional）。
 *
 * `renderActionConfirm` 原先用 `extractNum`（`parseInt`）取编号，Gitee 字母数字编号
 * `IKXR3B` 会被 parseInt 成 `NaN` → 0 → 整段编号消失，确认行只剩「✅ 创建 Issue 完成」。
 * 编号本身是字符串后，展示层也必须按字符串取值，且仍拒绝 `"0"` 占位与非法形态。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { renderActionConfirm } from '../lib/render/action.js'

test('renderActionConfirm: 字母数字编号显示为 #编号', () => {
  assert.equal(
    renderActionConfirm({ status: 'ok', issue_number: 'IKXR3B' }, '创建 Issue 完成'),
    '✅ 创建 Issue 完成 #IKXR3B',
  )
})

test('renderActionConfirm: 数字编号（number / issue_number）照旧显示', () => {
  assert.equal(
    renderActionConfirm({ status: 'ok', number: 32 }, '创建 Issue 完成'),
    '✅ 创建 Issue 完成 #32',
  )
  assert.equal(
    renderActionConfirm({ status: 'ok', issue_number: '32' }, '创建 Issue 完成'),
    '✅ 创建 Issue 完成 #32',
  )
})

test('renderActionConfirm: "0"/空/非法编号不显示（不伪造 #0）', () => {
  for (const bad of ['0', 0, '', null, undefined, 'a b']) {
    assert.equal(
      renderActionConfirm({ status: 'ok', issue_number: bad }, '创建 Issue 完成'),
      '✅ 创建 Issue 完成',
      `编号 ${String(bad)} 不应出现在确认行`,
    )
  }
})

test('renderActionConfirm: 其余字段的展示顺序不变', () => {
  assert.equal(
    renderActionConfirm({ status: 'ok', issue_number: 'IKXR3B', seq: 7, agent: 'qa', message: 'done' }, '推进'),
    '✅ 推进 #IKXR3B seq=7 agent=qa | done',
  )
})