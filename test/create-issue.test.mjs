/**
 * 创建需求（Issue #40 P1）纯逻辑契约测试。
 *
 * 三条独立职责，全部可单测（宿主路由与面板只做接线）：
 *   · validateCreateIssueInput —— owner/repo 形态、title 1–200、可选字段；
 *   · extractCreatedIssueNumber —— `issue_number → number → issue_id`，统一走 normalizeIssueNumber
 *     （Gitee 字母数字、拒 `"0"`），取不到编号**不重建**；
 *   · toCreateIssueError —— 4xx 原状态透传、5xx → 502 upstream_unavailable，code/message/request_id 可读。
 *
 * 跑的是 tsc 产物（`lib/`）：`npm test` 先 build 再跑。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildCreateIssuePayload,
  extractCreatedIssueNumber,
  toCreateIssueError,
  validateCreateIssueInput,
} from '../lib/create-issue.js'

// ───────────────────────── validateCreateIssueInput ─────────────────────────

test('validate：最小合法输入 → ok，标题 trim，未提供的可选字段不出现', () => {
  const r = validateCreateIssueInput({ owner: 'grape-dev', repo: 'grape-dsh', title: '  加个按钮  ' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, { owner: 'grape-dev', repo: 'grape-dsh', title: '加个按钮' })
})

test('validate：description / assignee 可选，提供时 trim 后保留', () => {
  const r = validateCreateIssueInput({
    owner: 'grape-dev', repo: 'grape-dsh', title: 't', description: '  body  ', assignee: ' developer_ch ',
  })
  assert.equal(r.ok, true)
  assert.equal(r.value.description, 'body')
  assert.equal(r.value.assignee, 'developer_ch')
})

test('validate：description 为空白视为未提供', () => {
  const r = validateCreateIssueInput({ owner: 'o', repo: 'r', title: 't', description: '   ' })
  assert.equal(r.ok, true)
  assert.equal('description' in r.value, false)
})

test('validate：owner 以 - 开头 / 含 .. / 含空格 → invalid_owner', () => {
  for (const owner of ['-evil', 'a..b', 'a b', '', '中文']) {
    const r = validateCreateIssueInput({ owner, repo: 'r', title: 't' })
    assert.equal(r.ok, false, owner)
    assert.equal(r.code, 'invalid_owner', owner)
    assert.ok(r.message)
  }
})

test('validate：repo 含 .. / 超长（101）/ 首字符非字母数字 → invalid_repo', () => {
  for (const repo of ['a..b', 'x'.repeat(101), '.hidden', 'a/b', '']) {
    const r = validateCreateIssueInput({ owner: 'o', repo, title: 't' })
    assert.equal(r.ok, false, repo)
    assert.equal(r.code, 'invalid_repo', repo)
  }
})

test('validate：owner/repo 长度 100 边界仍合法', () => {
  const r = validateCreateIssueInput({ owner: 'a'.repeat(100), repo: 'b'.repeat(100), title: 't' })
  assert.equal(r.ok, true)
})

test('validate：title 空白 → invalid_title', () => {
  const r = validateCreateIssueInput({ owner: 'o', repo: 'r', title: '   ' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'invalid_title')
})

test('validate：title 1 / 200 边界合法，201 非法（按 trim 后长度判定）', () => {
  assert.equal(validateCreateIssueInput({ owner: 'o', repo: 'r', title: 'a' }).ok, true)
  assert.equal(validateCreateIssueInput({ owner: 'o', repo: 'r', title: 'a'.repeat(200) }).ok, true)
  const tooLong = validateCreateIssueInput({ owner: 'o', repo: 'r', title: 'a'.repeat(201) })
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.code, 'invalid_title')
  // trim 后 200 仍合法（长度按内容算，不按原始空白算）
  assert.equal(validateCreateIssueInput({ owner: 'o', repo: 'r', title: `  ${'a'.repeat(200)}  ` }).ok, true)
})

test('validate：assignee 形态不合法 → invalid_assignee', () => {
  const r = validateCreateIssueInput({ owner: 'o', repo: 'r', title: 't', assignee: 'bad name!' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'invalid_assignee')
})

test('validate：非对象输入 → invalid_owner（不抛错）', () => {
  for (const raw of [null, undefined, 'x', 42, []]) {
    const r = validateCreateIssueInput(raw)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'invalid_owner')
  }
})

test('validate：数值型 title/owner 不强转（避免 `[object Object]` 打进平台）', () => {
  const r = validateCreateIssueInput({ owner: 123, repo: 'r', title: 456 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'invalid_owner')
})

test('validate：platform 归一后保留（建单要靠它拼 repo_key，不能在这里丢）', () => {
  const gitee = validateCreateIssueInput({ owner: 'o', repo: 'r', title: 't', platform: ' Gitee ' })
  assert.equal(gitee.ok, true)
  assert.equal(gitee.value.platform, 'gitee')

  // 非法 / 缺失平台不出现（由 repo_key 缺省 gitcode 兜底）
  const bad = validateCreateIssueInput({ owner: 'o', repo: 'r', title: 't', platform: 'bad platform' })
  assert.equal(bad.ok, true)
  assert.equal('platform' in bad.value, false)
  const none = validateCreateIssueInput({ owner: 'o', repo: 'r', title: 't' })
  assert.equal('platform' in none.value, false)
})

// ──────────────────────── buildCreateIssuePayload ──────────────────────────
// QA Required（PR #40）：建单载荷必须带 repo_key，否则 Gitee 的 owner/repo 会被
// 平台按 GitCode 解析（建单失败或建到同名仓库）。这里覆盖缺省与 Gitee 两种口径。

test('payload：缺省平台 → repo_key 为 gitcode:owner/repo，且带 title', () => {
  const payload = buildCreateIssuePayload({ owner: 'grape-dev', repo: 'grape-dsh', title: '加个按钮' })
  assert.deepEqual(payload, {
    repo_key: 'gitcode:grape-dev/grape-dsh',
    title: '加个按钮',
  })
})

test('payload：Gitee 仓库 → repo_key 为 gitee:owner/repo（不串 GitCode 同名仓库）', () => {
  const payload = buildCreateIssuePayload({
    owner: 'owner', repo: 'repo', title: 't', platform: 'gitee',
  })
  assert.equal(payload.repo_key, 'gitee:owner/repo')
})

test('payload：description / assignee 提供时才出现（可选字段不传空串）', () => {
  const full = buildCreateIssuePayload({
    owner: 'o', repo: 'r', title: 't', description: '正文', assignee: 'developer_ch',
  })
  assert.equal(full.description, '正文')
  assert.equal(full.assignee, 'developer_ch')

  const minimal = buildCreateIssuePayload({ owner: 'o', repo: 'r', title: 't' })
  assert.equal('description' in minimal, false)
  assert.equal('assignee' in minimal, false)
})

// ── Issue #42：可选 scene_id（复制需求 / 指定流水线建单）──

test('validate：scene_id 合法则保留；缺省 / 空白不出现（#40 行为不变）', () => {
  const withScene = validateCreateIssueInput({
    owner: 'o', repo: 'r', title: 't', scene_id: ' custom-5f5c87a1 ',
  })
  assert.equal(withScene.ok, true)
  assert.equal(withScene.value.scene_id, 'custom-5f5c87a1')

  for (const missing of [undefined, null, '', '   ']) {
    const r = validateCreateIssueInput({ owner: 'o', repo: 'r', title: 't', scene_id: missing })
    assert.equal(r.ok, true)
    assert.equal('scene_id' in r.value, false, `scene_id=${JSON.stringify(missing)} 不应出现在归一值里`)
  }
})

test('validate：scene_id 形态白名单（首字符字母数字，≤64，禁空格/斜杠/..）', () => {
  for (const bad of ['-scene', 'a b', 'a/b', '../x', 'a'.repeat(65)]) {
    const r = validateCreateIssueInput({ owner: 'o', repo: 'r', title: 't', scene_id: bad })
    assert.equal(r.ok, false, `非法 scene_id 应拒绝：${JSON.stringify(bad)}`)
    if (!r.ok) assert.equal(r.code, 'invalid_scene_id')
  }
  const boundary = validateCreateIssueInput({ owner: 'o', repo: 'r', title: 't', scene_id: 'a'.repeat(64) })
  assert.equal(boundary.ok, true, '64 字符边界合法')
})

test('payload：scene_id 有则进 payload，无则不出现（缺省与 #40 完全一致）', () => {
  const withScene = buildCreateIssuePayload({ owner: 'o', repo: 'r', title: 't', scene_id: 'custom-5f5c87a1' })
  assert.equal(withScene.scene_id, 'custom-5f5c87a1')
  assert.equal(withScene.repo_key, 'gitcode:o/r')

  const plain = buildCreateIssuePayload({ owner: 'o', repo: 'r', title: 't' })
  assert.deepEqual(Object.keys(plain).sort(), ['repo_key', 'title'], '不传 scene_id 时载荷字段与 #40 一致')
})

// ──────────────────────── extractCreatedIssueNumber ─────────────────────────

test('编号：issue_number 优先（GitCode 整数归一成字符串）', () => {
  assert.equal(extractCreatedIssueNumber({ issue_number: 32 }), '32')
  assert.equal(extractCreatedIssueNumber({ issue_number: 32, number: 33, issue_id: 'IKXR3B' }), '32')
})

test('编号：没有 issue_number 时取 number，再退 issue_id', () => {
  assert.equal(extractCreatedIssueNumber({ number: 33 }), '33')
  assert.equal(extractCreatedIssueNumber({ number: '33' }), '33')
  assert.equal(extractCreatedIssueNumber({ issue_id: 'IKXR3B' }), 'IKXR3B')
})

test('编号：Gitee 字母数字编号原样保留（大小写敏感）', () => {
  assert.equal(extractCreatedIssueNumber({ issue_number: 'IKXR3B' }), 'IKXR3B')
  assert.equal(extractCreatedIssueNumber({ issue_id: 'ikxr3b' }), 'ikxr3b')
})

test('编号：issue_number 非法（"0" / 空 / 元字符）时继续看下一个字段', () => {
  assert.equal(extractCreatedIssueNumber({ issue_number: '0', number: 34 }), '34')
  assert.equal(extractCreatedIssueNumber({ issue_number: '', issue_id: 'IKXR3B' }), 'IKXR3B')
  assert.equal(extractCreatedIssueNumber({ issue_number: '#3201', number: '9' }), '9')
})

test('编号：三个字段都取不到 → 空串（调用方回 warning，不重建）', () => {
  assert.equal(extractCreatedIssueNumber({}), '')
  assert.equal(extractCreatedIssueNumber(null), '')
  assert.equal(extractCreatedIssueNumber(undefined), '')
  assert.equal(extractCreatedIssueNumber({ issue_number: '0', number: 0, issue_id: null }), '')
  assert.equal(extractCreatedIssueNumber({ data: { issue_number: 1 } }), '')
})

// ─────────────────────────── toCreateIssueError ────────────────────────────

test('错误映射：403 原状态透传，code/message 取平台字段', () => {
  const mapped = toCreateIssueError({ status: 403, data: { code: 'forbidden', message: '无权限创建需求' } })
  assert.equal(mapped.status, 403)
  assert.equal(mapped.body.ok, false)
  assert.equal(mapped.body.code, 'forbidden')
  assert.equal(mapped.body.message, '无权限创建需求')
})

test('错误映射：4xx 取 error_code 与 error 字段（另一套平台字段名）', () => {
  const mapped = toCreateIssueError({ status: 422, data: { error_code: 40001, error: '标题不合法' } })
  assert.equal(mapped.status, 422)
  assert.equal(mapped.body.code, '40001')
  assert.equal(mapped.body.message, '标题不合法')
})

test('错误映射：5xx → 502 upstream_unavailable（不把裸 HTTP 500 抛给用户）', () => {
  const mapped = toCreateIssueError({ status: 500, data: { message: 'internal error' } })
  assert.equal(mapped.status, 502)
  assert.equal(mapped.body.code, 'upstream_unavailable')
  assert.equal(mapped.body.message, 'internal error')
})

test('错误映射：5xx 且无 message → 可读缺省文案（含 HTTP 状态）', () => {
  const mapped = toCreateIssueError({ status: 503, data: {} })
  assert.equal(mapped.status, 502)
  assert.match(String(mapped.body.message), /HTTP 503/)
})

test('错误映射：4xx 且无 code/message → 缺省 code + 可读文案', () => {
  const mapped = toCreateIssueError({ status: 400, data: {} })
  assert.equal(mapped.status, 400)
  assert.equal(mapped.body.code, 'create_issue_failed')
  assert.match(String(mapped.body.message), /HTTP 400/)
})

test('错误映射：不把平台原始响应体（raw）当 message 透出', () => {
  const mapped = toCreateIssueError({ status: 500, data: { raw: 'Traceback ... secret stack ...' } })
  assert.equal(mapped.status, 502)
  assert.doesNotMatch(String(mapped.body.message), /Traceback/)
})

test('错误映射：status 缺失 / 非数字 → 502 upstream_unavailable（网络层失败）', () => {
  for (const status of [0, undefined, null]) {
    const mapped = toCreateIssueError({ status, data: {} })
    assert.equal(mapped.status, 502)
    assert.equal(mapped.body.code, 'upstream_unavailable')
  }
})

test('错误映射：request_id 先取 body，再取响应头；都没有则不带该字段', () => {
  const fromBody = toCreateIssueError({
    status: 400, data: { message: 'x', request_id: 'req-body' }, requestId: 'req-header',
  })
  assert.equal(fromBody.body.request_id, 'req-body')

  const fromHeader = toCreateIssueError({ status: 400, data: { message: 'x' }, requestId: 'req-header' })
  assert.equal(fromHeader.body.request_id, 'req-header')

  const none = toCreateIssueError({ status: 400, data: { message: 'x' } })
  assert.equal('request_id' in none.body, false)
})