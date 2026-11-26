/**
 * 「创建需求并接管」的计划逻辑契约测试（Issue #40 P2）。
 *
 * 关键词：**接管目标是实际运行中的节点**，不是写死的 coding —— 首节点可能是 vod / issue，
 * 面板必须按 `status === 1` 取；仓库键必须带平台前缀，否则 Gitee 的 `owner/repo`
 * 会被当成 GitCode 的同名仓库（串库）。失败文案要能区分「已被接管 / 没节点 / 无权限 / 网络」，
 * 否则用户只会看到一句 unknown 不知道下一步做什么。
 *
 * 跑的是 tsc 产物（`lib/`）：`npm test` 先 build 再跑。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  normalizePlatform,
  normalizeTakeoverList,
  pickRunningAgent,
  repoKeyFor,
  takeoverFailureText,
  takeoverStillActive,
} from '../lib/takeover-plan.js'

// ──────────────────────────── pickRunningAgent ─────────────────────────────

test('pickRunningAgent：取首个 status=1 节点的 tag（vod 首节点也能接管）', () => {
  const view = {
    nodes: [
      { tag: 'vod', status: 1 },
      { tag: 'issue', status: 0 },
      { tag: 'coding', status: 0 },
    ],
  }
  assert.equal(pickRunningAgent(view), 'vod')
})

test('pickRunningAgent：跳过已完成/待开始的节点，取真正在跑的那个', () => {
  assert.equal(pickRunningAgent({
    nodes: [
      { tag: 'vod', status: 2 },
      { tag: 'issue', status: 2 },
      { tag: 'coding', status: 1 },
      { tag: 'qa', status: 0 },
    ],
  }), 'coding')
})

test('pickRunningAgent：没有 status=1 节点 → 空串（调用方走「手动接管」降级）', () => {
  assert.equal(pickRunningAgent({ nodes: [{ tag: 'vod', status: 0 }, { tag: 'coding', status: 2 }] }), '')
  assert.equal(pickRunningAgent({ nodes: [] }), '')
})

test('pickRunningAgent：失败/取消/跳过/待审核都不算运行中', () => {
  assert.equal(pickRunningAgent({
    nodes: [
      { tag: 'vod', status: 3 },
      { tag: 'issue', status: 4 },
      { tag: 'coding', status: 5 },
      { tag: 'qa', status: 6 },
    ],
  }), '')
})

test('pickRunningAgent：输入缺失 / 非对象 → 空串，不抛错', () => {
  for (const raw of [null, undefined, {}, 'x', 42]) {
    assert.equal(pickRunningAgent(raw), '')
  }
})

test('pickRunningAgent：status=1 但 tag 为空的节点跳过（不能拿空 agent 去接管）', () => {
  assert.equal(pickRunningAgent({
    nodes: [{ tag: '', status: 1 }, { tag: 'issue', status: 1 }],
  }), 'issue')
})

test('pickRunningAgent：status 以字符串下发（原始事件数据）也认', () => {
  assert.equal(pickRunningAgent({ nodes: [{ tag: 'sre', status: '1' }] }), 'sre')
})

// ───────────────────────────── repoKeyFor ─────────────────────────────────

test('normalizePlatform：合法平台名归一为小写；非法 / 空 → 空串', () => {
  assert.equal(normalizePlatform('gitee'), 'gitee')
  assert.equal(normalizePlatform(' GitHub '), 'github')
  assert.equal(normalizePlatform('gitlab_self-h'), 'gitlab_self-h')
  assert.equal(normalizePlatform(''), '')
  assert.equal(normalizePlatform(undefined), '')
  assert.equal(normalizePlatform('1bad'), '')
  assert.equal(normalizePlatform('bad platform'), '')
  assert.equal(normalizePlatform('x'.repeat(33)), '')
})

test('repoKeyFor：缺省平台回到 gitcode（向后兼容旧客户端）', () => {
  assert.equal(repoKeyFor(undefined, 'grape-dev/grape-dsh'), 'gitcode:grape-dev/grape-dsh')
  assert.equal(repoKeyFor('', 'grape-dev/grape-dsh'), 'gitcode:grape-dev/grape-dsh')
})

test('repoKeyFor：Gitee 仓库得到 gitee:owner/repo（不串到 GitCode 同名仓库）', () => {
  assert.equal(repoKeyFor('gitee', 'owner/repo'), 'gitee:owner/repo')
})

test('repoKeyFor：repo 已含平台前缀 → 原样返回（幂等）', () => {
  assert.equal(repoKeyFor('gitee', 'gitcode:owner/repo'), 'gitcode:owner/repo')
  assert.equal(repoKeyFor('', 'github:owner/repo'), 'github:owner/repo')
})

test('repoKeyFor：非法平台名按缺省 gitcode 处理（不把脏值拼进请求）', () => {
  assert.equal(repoKeyFor('bad platform', 'owner/repo'), 'gitcode:owner/repo')
})

test('repoKeyFor：repo 为空 → 空串（调用方据此 400，不拼出 `gitcode:`)', () => {
  assert.equal(repoKeyFor('gitee', ''), '')
})

// ────────────────────────── takeoverStillActive ───────────────────────────
// QA Required（PR #40）：查询失败（null）≠「没有接管」。前者必须不拦（返回 true），
// 否则网络抖动会清掉本地待恢复底稿，用户失去「恢复接管会话」入口。

test('takeoverStillActive：查到目标接管 → true', () => {
  assert.equal(takeoverStillActive([{ id: 't1' }, { id: 't2' }], 't2'), true)
})

test('takeoverStillActive：确认为空 / 不含目标 → false（可安全清理本地底稿）', () => {
  assert.equal(takeoverStillActive([], 't1'), false)
  assert.equal(takeoverStillActive([{ id: 'other' }], 't1'), false)
})

test('takeoverStillActive：查询失败（null / 非数组）→ true（查不到不拦，保留底稿）', () => {
  assert.equal(takeoverStillActive(null, 't1'), true)
  assert.equal(takeoverStillActive(undefined, 't1'), true)
  assert.equal(takeoverStillActive({ error: 'boom' }, 't1'), true)
})

// ────────────────────────── normalizeTakeoverList ─────────────────────────
// QA 复审 Required（PR #40）：宿主 takeover-list 在 4xx/5xx 会透传上游状态与响应体，
// 失败响应（502 / 权限错误 / 非 JSON 错误页）不能被归一成 `[]`，否则「查不到」会被判成
// 「确认没有接管」，recoverNow 会清掉待恢复底稿。

test('normalizeTakeoverList：HTTP 成功且 sessions 是数组 → 返回列表', () => {
  const list = [{ id: 't1' }, { id: 't2' }]
  assert.deepEqual(normalizeTakeoverList({ ok: true, status: 200 }, { ok: true, sessions: list }), list)
  // 响应体不带 ok 字段时，按「未显式失败」处理
  assert.deepEqual(normalizeTakeoverList({ ok: true, status: 200 }, { sessions: list }), list)
})

test('normalizeTakeoverList：非 2xx / 网关错误页 / 权限错误 → null（不伪装成「没有接管」）', () => {
  assert.equal(normalizeTakeoverList({ ok: false, status: 502 }, { ok: false, error: 'Bad Gateway' }), null)
  assert.equal(normalizeTakeoverList({ ok: false, status: 403 }, { error: 'forbidden' }), null)
  assert.equal(normalizeTakeoverList({ ok: false, status: 500 }, null), null)
  assert.equal(normalizeTakeoverList(null, { sessions: [] }), null)
})

test('normalizeTakeoverList：HTTP 成功但响应体 ok:false → null', () => {
  assert.equal(normalizeTakeoverList({ ok: true, status: 200 }, { ok: false, sessions: [] }), null)
})

test('normalizeTakeoverList：sessions 非数组 / 畸形体 → null', () => {
  assert.equal(normalizeTakeoverList({ ok: true, status: 200 }, { sessions: 'oops' }), null)
  assert.equal(normalizeTakeoverList({ ok: true, status: 200 }, {}), null)
  assert.equal(normalizeTakeoverList({ ok: true, status: 200 }, null), null)
})

test('normalizeTakeoverList：失败响应经三态判定不拦（takeoverStillActive → true）', () => {
  const failed = normalizeTakeoverList({ ok: false, status: 502 }, {})
  assert.equal(takeoverStillActive(failed, 't1'), true)
})

// ────────────────────────── takeoverFailureText ───────────────────────────

test('失败文案：taken_by_other 指向「已有进行中的接管」且不让人反复点', () => {
  const text = takeoverFailureText({ code: 'taken_by_other' })
  assert.match(text, /接管/)
  assert.match(text, /进行中|已有/)
})

test('失败文案：没有运行节点 → 明确说「暂无可接管节点」', () => {
  const text = takeoverFailureText({ code: 'no_running_node' })
  assert.match(text, /节点/)
})

test('失败文案：401 / 403 指向凭据或权限（不是网络）', () => {
  assert.match(takeoverFailureText({ status: 401 }), /凭据|登录|失效/)
  assert.match(takeoverFailureText({ status: 403 }), /权限/)
})

test('失败文案：网络错误单独一类（提示检查网络 / 服务地址）', () => {
  assert.match(takeoverFailureText({ network: true }), /网络|连接/)
})

test('失败文案：四类互不相同（用户能据此决定下一步）', () => {
  const texts = [
    takeoverFailureText({ code: 'taken_by_other' }),
    takeoverFailureText({ code: 'no_running_node' }),
    takeoverFailureText({ status: 403 }),
    takeoverFailureText({ network: true }),
  ]
  assert.equal(new Set(texts).size, 4)
  for (const t of texts) assert.ok(t.length > 0)
})

test('失败文案：未知失败保留平台 message（可读、不吞信息）', () => {
  const text = takeoverFailureText({ status: 500, message: 'bundle missing takeover_id' })
  assert.match(text, /bundle missing takeover_id/)
})

test('失败文案：完全无信息时也给可读兜底', () => {
  const text = takeoverFailureText({})
  assert.ok(text.length > 0)
  assert.doesNotMatch(text, /undefined|null/)
})

test('失败文案：本身不带「接管失败：」前缀（调用方统一加，避免重复两遍）', () => {
  for (const input of [{}, { status: 500, message: 'boom' }, { code: 'taken_by_other' }]) {
    assert.doesNotMatch(takeoverFailureText(input), /^接管失败/)
  }
})