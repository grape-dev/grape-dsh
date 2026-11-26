/**
 * 实时面板「自动预览」选择规则单测（Issue #28）。
 *
 * 预览从侧栏当前仓库的 `/issues` 缓存里挑一条：优先 `processing`，其次最近更新。
 * 选择逻辑放在纯模块 `src/preview-select.ts`（无 React / DOM / 网络），
 * 与 `pins-persist.ts` 同一套「纯逻辑可单测」的 seam。
 *
 * 另外两条硬约束也用测试守护：
 *   · 预览**绝不落盘**（`preview-store.ts` 不得出现 localStorage / pins 存档 key）；
 *   · 预览**不新增网络请求**（不得出现 panelGet / fetch）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pickPreviewIssue, shouldShowPreview } from '../lib/preview-select.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const REPO = { owner: 'grape-dev', repo: 'grape-dsh', platform: 'gitcode' }

/** 构造一条 `/issues` 投影数据（字段与 panel-api 的 projectIssues 一致） */
function issue(number, status, createdAt, extra = {}) {
  return {
    issue_number: number,
    title: `issue ${number}`,
    status,
    stage: status,
    scene_name: '',
    assignee: '',
    events_count: 1,
    is_running: status === 'processing',
    latest_event: createdAt ? { seq: number * 10, status, created_at: createdAt } : null,
    ...extra,
  }
}

function dataOf(issues) {
  return { total: issues.length, issues }
}

test('无当前仓库 → no-repo（空态提示先去浏览选仓库）', () => {
  const pick = pickPreviewIssue({
    repo: null, data: null, error: null, pinCount: 0, maxPins: 8,
  })
  assert.deepEqual(pick, { kind: 'none', reason: 'no-repo' })
})

test('拉取失败 → error（空态提示重试，不把失败当「没有 issue」）', () => {
  const pick = pickPreviewIssue({
    repo: REPO, data: null, error: 'HTTP 502', pinCount: 0, maxPins: 8,
  })
  assert.equal(pick.kind, 'none')
  assert.equal(pick.reason, 'error')
  assert.equal(pick.message, 'HTTP 502')
})

test('仓库无 issue → no-issue（只在已拿到空列表时）', () => {
  for (const data of [{}, { issues: [] }, dataOf([{ title: 'no number' }])]) {
    const pick = pickPreviewIssue({
      repo: REPO, data, error: null, pinCount: 0, maxPins: 8,
    })
    assert.deepEqual(pick, { kind: 'none', reason: 'no-issue' })
  }
})

test('缓存加载中（data=null 且 loading）→ loading，不误判为「这个仓库还没有 issue」', () => {
  const pick = pickPreviewIssue({
    repo: REPO, data: null, loading: true, error: null, pinCount: 0, maxPins: 8,
  })
  assert.deepEqual(pick, { kind: 'none', reason: 'loading' })
})

test('缓存从未加载（data=null 且非 loading）→ not-loaded，引导去浏览加载该仓库 issue 列表', () => {
  const pick = pickPreviewIssue({
    repo: REPO, data: null, loading: false, error: null, pinCount: 0, maxPins: 8,
  })
  assert.deepEqual(pick, { kind: 'none', reason: 'not-loaded' })
})

test('缓存已有旧数据时刷新（loading=true）仍按旧数据选，不闪回加载态', () => {
  const pick = pickPreviewIssue({
    repo: REPO,
    data: dataOf([issue(3, 'processing', '2026-11-19T10:00:00Z')]),
    loading: true, error: null, pinCount: 0, maxPins: 8,
  })
  assert.equal(pick.kind, 'ready')
  assert.equal(pick.issue.number, '3')
})

test('processing 优先于更新时间更晚的非 processing', () => {
  const pick = pickPreviewIssue({
    repo: REPO,
    data: dataOf([
      issue(1, 'completed', '2026-11-19T10:00:00Z'),
      issue(2, 'processing', '2026-11-18T10:00:00Z'),
      issue(3, 'pending_review', '2026-11-19T11:00:00Z'),
    ]),
    error: null, pinCount: 0, maxPins: 8,
  })
  assert.equal(pick.kind, 'ready')
  assert.equal(pick.issue.number, '2')
})

test('同为非 processing 时按最近更新（latest_event.created_at）', () => {
  const pick = pickPreviewIssue({
    repo: REPO,
    data: dataOf([
      issue(4, 'completed', '2026-11-17T10:00:00Z'),
      issue(5, 'pending_review', '2026-11-19T09:00:00Z'),
      issue(6, 'completed', '2026-11-18T10:00:00Z'),
    ]),
    error: null, pinCount: 0, maxPins: 8,
  })
  assert.equal(pick.kind, 'ready')
  assert.equal(pick.issue.number, '5')
})

test('latest_event 缺失/时间非法时按 seq、再按 issue 号兜底（不抛错）', () => {
  const noEvents = pickPreviewIssue({
    repo: REPO,
    data: dataOf([
      issue(7, 'completed', null),
      issue(9, 'completed', null, { latest_event: { seq: 90, status: 'completed', created_at: 'not-a-date' } }),
      issue(8, 'completed', null, { latest_event: { seq: 80, status: 'completed', created_at: '' } }),
    ]),
    error: null, pinCount: 0, maxPins: 8,
  })
  assert.equal(noEvents.kind, 'ready')
  assert.equal(noEvents.issue.number, '9', 'seq 更大视为更近')
})

test('8 条上限时预览让位（返回 full，不挤占正式 pin）', () => {
  const pick = pickPreviewIssue({
    repo: REPO,
    data: dataOf([issue(1, 'processing', '2026-11-19T10:00:00Z')]),
    error: null, pinCount: 8, maxPins: 8,
  })
  assert.deepEqual(pick, { kind: 'none', reason: 'full' })
})

test('ready 返回身份与状态（供预览卡展示 owner/repo#number）', () => {
  const pick = pickPreviewIssue({
    repo: REPO,
    data: dataOf([issue(12, 'processing', '2026-11-19T10:00:00Z')]),
    error: null, pinCount: 0, maxPins: 8,
  })
  assert.equal(pick.kind, 'ready')
  assert.equal(pick.issue.owner, 'grape-dev')
  assert.equal(pick.issue.repo, 'grape-dsh')
  assert.equal(pick.issue.platform, 'gitcode')
  assert.equal(pick.issue.number, '12')
  assert.equal(pick.issue.title, 'issue 12')
  assert.equal(pick.issue.status, 'processing')
})

test('预览只在 pin 数达上限时让位（spec 规则 4，Issue #28 R1）', () => {
  assert.equal(shouldShowPreview(0, 8), true, '空 pins 时显示预览')
  assert.equal(shouldShowPreview(1, 8), true, '有 pin 时预览仍在（并列展示，不是点图钉即消失）')
  assert.equal(shouldShowPreview(7, 8), true, '未达上限仍显示')
  assert.equal(shouldShowPreview(8, 8), false, '满上限才让位')
  assert.equal(shouldShowPreview(9, 8), false)
})

test('预览不落盘：preview-store 不触碰 localStorage / pins 存档 key', () => {
  const source = readFileSync(join(repoRoot, 'src/client/preview-store.ts'), 'utf8')
  assert.doesNotMatch(source, /localStorage/, '预览状态不得写 localStorage')
  assert.doesNotMatch(source, /PINS_STORAGE_KEY/, '预览不得读写 pins 存档 key')
  assert.doesNotMatch(source, /setItem\s*\(/, '预览不得调用 setItem')
})

test('预览不新增网络请求：preview-store 不出现 panelGet / fetch', () => {
  const source = readFileSync(join(repoRoot, 'src/client/preview-store.ts'), 'utf8')
  assert.doesNotMatch(source, /panelGet/, '预览不得直接发面板请求')
  assert.doesNotMatch(source, /\bfetch\s*\(/, '预览不得调用 fetch')
})

test('预览接线把缓存 loading 传给选择器（未加载/加载中可区分）', () => {
  const source = readFileSync(join(repoRoot, 'src/client/preview-store.ts'), 'utf8')
  assert.match(source, /loading:\s*cache\.loading/, 'usePreview 必须把 cache.loading 传给 pickPreviewIssue')
})
test('预览不挂接管制件：FocusBody 提供 bare，预览卡必须用 bare（Issue #28 C1）', () => {
  const source = readFileSync(join(repoRoot, 'src/client/GrapeFocusPanel.tsx'), 'utf8')
  assert.match(source, /bare = false/, 'FocusBody 必须提供 bare 开关')
  assert.match(source, /bare \? null : <TakeoverBar/, 'bare 时不得渲染 TakeoverBar')
  assert.match(source, /<FocusBody focus=\{props\.focus\} bare \/>/, '预览卡必须用 bare 渲染')
})


test('Gitee 字母数字编号可作为预览项（Issue #39）', () => {
  const pick = pickPreviewIssue({
    repo: REPO,
    data: dataOf([issue('IKXR3B', 'processing', '2026-11-19T10:00:00Z')]),
    error: null, pinCount: 0, maxPins: 8,
  })
  assert.equal(pick.kind, 'ready')
  assert.equal(pick.issue.number, 'IKXR3B', '字母数字编号应原样返回，不被数字收敛成 0')
})

test('编号 "0" / 缺失的 issue 不进入预览候选', () => {
  const pick = pickPreviewIssue({
    repo: REPO,
    data: dataOf([
      { issue_number: '0', title: 'zero', status: 'processing' },
      { title: 'missing', status: 'processing' },
    ]),
    error: null, pinCount: 0, maxPins: 8,
  })
  assert.deepEqual(pick, { kind: 'none', reason: 'no-issue' })
})

test('编号非法的 issue 不进入预览候选（复审实测漏网的 "a b" / "../x"）', () => {
  const pick = pickPreviewIssue({
    repo: REPO,
    data: dataOf([
      { issue_number: 'a b', title: 'space', status: 'processing' },
      { issue_number: '../x', title: 'traversal', status: 'processing' },
      { issue_number: 'a.b', title: 'dot', status: 'processing' },
    ]),
    error: null, pinCount: 0, maxPins: 8,
  })
  assert.deepEqual(pick, { kind: 'none', reason: 'no-issue' })
})
