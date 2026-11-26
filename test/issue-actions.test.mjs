/**
 * 需求卡动作的纯判定（Issue #42 P2/P3/P4/P5）。
 *
 * 测试 seam：`src/issue-actions.ts` —— 深链 / 预检 / 终态 / 复制预填 / skipped 文案。
 * 这些判定**不碰 DOM**，所以能放进 `lib/` 用 `node:test` 覆盖；
 * `src/client/issue-actions.ts` 只负责 fetch / window.open 接线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canConfirmDone,
  canHandoff,
  chatDeepLink,
  copyPrefill,
  handoffSkipText,
  isRunningStatus,
  issueWebUrl,
  needsPreflightStart,
} from '../lib/issue-actions.js'

const PROCESSING = { id: 20864, issue_number: '42', status: 'processing', is_running: true, scene_id: 'custom-5f5c87a1' }

test('深链形态：#chat/issue%3A<number>%3A<repo_key>，base 尾斜杠归一', () => {
  assert.equal(
    chatDeepLink('https://www.grapedev.cn/', {
      owner: 'grape-dev', repo: 'grape-dsh', number: 42, platform: 'gitcode',
    }),
    'https://www.grapedev.cn/app/grape-dev/grape-dsh/#chat/issue%3A42%3Agitcode%3Agrape-dev%2Fgrape-dsh',
  )
  // 官网真实地址（用户 2026-11-25 给的样例）：hash 段整体 encodeURIComponent
  assert.equal(
    chatDeepLink('https://www.grapedev.cn', {
      owner: 'developer_ch', repo: 'tf-infra', number: 4, platform: 'gitcode',
    }),
    'https://www.grapedev.cn/app/developer_ch/tf-infra/#chat/issue%3A4%3Agitcode%3Adeveloper_ch%2Ftf-infra',
  )
})

test('深链：Gitee 字母数字编号原样保留，repo_key 不串平台', () => {
  const url = chatDeepLink('https://gitee.example.com', {
    owner: 'acme', repo: 'svc', number: 'IKXR3B', platform: 'gitee',
  })
  assert.equal(url, 'https://gitee.example.com/app/acme/svc/#chat/issue%3AIKXR3B%3Agitee%3Aacme%2Fsvc')
  assert.ok(!url.includes('gitcode'), 'Gitee 需求不得落 GitCode 的 repo_key')
})

test('深链：显式 repo_key 优先；缺 base / 仓库 / 编号 → 空串（调用方只提示，不打开坏链接）', () => {
  assert.equal(
    chatDeepLink('https://x.test', { owner: 'o', repo: 'r', number: '1', repoKey: 'github:o/r' }),
    'https://x.test/app/o/r/#chat/issue%3A1%3Agithub%3Ao%2Fr',
  )
  assert.equal(chatDeepLink('', { owner: 'o', repo: 'r', number: '1', platform: 'gitcode' }), '')
  assert.equal(chatDeepLink('https://x.test', { owner: '', repo: 'r', number: '1', platform: 'gitcode' }), '')
  assert.equal(chatDeepLink('https://x.test', { owner: 'o', repo: 'r', number: '0', platform: 'gitcode' }), '')
})

test('运行中谓词：active / processing / running 或 is_running；终态不是运行中', () => {
  assert.equal(isRunningStatus({ status: 'active' }), true)
  assert.equal(isRunningStatus({ status: 'processing' }), true)
  assert.equal(isRunningStatus({ status: ' RUNNING ' }), true)
  assert.equal(isRunningStatus({ status: '', is_running: true }), true)
  assert.equal(isRunningStatus({ status: 'completed' }), false)
  assert.equal(isRunningStatus({ status: 'cancelled' }), false)
  assert.equal(isRunningStatus(null), false)
})

test('预检 /start：只有运行中且拿得到内部 id 才调（否则直接开深链）', () => {
  assert.equal(needsPreflightStart(PROCESSING), true)
  assert.equal(needsPreflightStart({ ...PROCESSING, id: 0 }), false, '没有内部 id 时只开深链')
  assert.equal(needsPreflightStart({ ...PROCESSING, status: 'completed', is_running: false }), false)
  assert.equal(needsPreflightStart(null), false)
})

test('终态与缺 id 时确认完成/移交不可用（终态 = completed / cancelled / closed / stage=done）', () => {
  assert.equal(canConfirmDone(PROCESSING), true)
  assert.equal(canHandoff(PROCESSING), true)

  for (const status of ['completed', 'cancelled', 'canceled', 'closed']) {
    assert.equal(canConfirmDone({ ...PROCESSING, status, is_running: false }), false, `终态 ${status} 应禁点`)
    assert.equal(canHandoff({ ...PROCESSING, status, is_running: false }), false, `终态 ${status} 应禁点`)
  }
  assert.equal(canConfirmDone({ ...PROCESSING, stage: 'done' }), false, 'stage=done 也是终态')

  assert.equal(canConfirmDone({ ...PROCESSING, id: 0 }), false, 'id 缺失时必须禁用（移交不能用编号兜底）')
  assert.equal(canHandoff({ ...PROCESSING, id: 0 }), false)
  assert.equal(canConfirmDone(null), false)
})

test('copy 预填：标题 +「（副本）」、描述 + 空行 + Issue 链接', () => {
  const p = copyPrefill({
    title: '需求卡片 4 个按钮',
    task_description: '## 背景\n\n原始描述',
    url: 'https://www.grapedev.cn/app/grape-dev/grape-dsh/issues/42',
  })
  assert.equal(p.title, '需求卡片 4 个按钮（副本）')
  assert.equal(p.description, '## 背景\n\n原始描述\n\nIssue 链接: https://www.grapedev.cn/app/grape-dev/grape-dsh/issues/42')
})

test('issueWebUrl：GitCode / Gitee 各走自己的需求页，不拿流水线深链顶替', () => {
  assert.equal(
    issueWebUrl('gitcode', 'grape-dev', 'grape-dsh', 42),
    'https://gitcode.com/grape-dev/grape-dsh/issues/42',
  )
  assert.equal(
    issueWebUrl('gitee', 'acme', 'svc', 'IKXR3B'),
    'https://gitee.com/acme/svc/issues/IKXR3B',
  )
  assert.equal(issueWebUrl(undefined, 'o', 'r', '7'), 'https://gitcode.com/o/r/issues/7', '平台未知默认 GitCode')
  assert.equal(issueWebUrl('gitcode', '', 'r', 7), '')
  assert.equal(issueWebUrl('gitcode', 'o', 'r', 0), '')
})

test('copy 预填：描述为空时只留 Issue 链接；标题超 200 截断后再加后缀', () => {
  const noDesc = copyPrefill({ title: 't', task_description: '   ', url: 'https://x.test/i/1' })
  assert.equal(noDesc.description, 'Issue 链接: https://x.test/i/1')
  assert.equal(noDesc.title, 't（副本）')

  const long = copyPrefill({ title: 'a'.repeat(300), task_description: '', url: 'https://x.test/i/1' })
  assert.equal([...long.title].length, 200, '标题总长必须 ≤ 200（平台上限）')
  assert.ok(long.title.endsWith('（副本）'))

  const empty = copyPrefill({ title: '', task_description: '', url: '' })
  assert.equal(empty.title, '需求副本（副本）', '没有标题时给可编辑的占位标题')
  assert.equal(empty.description, '')
})

test('skipped 文案：两类 skip 各自可读，未知错误不吞', () => {
  const dup = handoffSkipText('duplicate_handoff')
  const missing = handoffSkipText('target_scene_missing_node')
  assert.ok(dup.includes('已移交'))
  assert.ok(missing.includes('目标流水线'))
  assert.notEqual(dup, missing)
  assert.equal(handoffSkipText(''), '移交失败', '未知/空 code 用兜底文案，不显示空串')
  assert.equal(handoffSkipText('boom'), '移交失败')
})