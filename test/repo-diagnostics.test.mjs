/**
 * 「已托管仓库」空态诊断单元测试。
 *
 * 测试 seam 选在纯函数模块 `src/repo-diagnostics.ts`：
 *  - 不引入 React / DOM 测试依赖；
 *  - 诊断计算与脱敏是本次需求的核心风险点，必须可独立验证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REPO_EMPTY_REASONS,
  buildReposDiagnostics,
  redactSensitiveText,
  renderReposDiagnostics,
  reposEmptyKind,
  summarizeViewer,
  withReposDiagnostics,
} from '../lib/repo-diagnostics.js'

test('三类空态原因可区分：未托管 / org_id=0 组织过滤 / 无读取权限', () => {
  assert.equal(REPO_EMPTY_REASONS.length, 3)
  const text = REPO_EMPTY_REASONS.join('\n')
  assert.match(text, /未托管/)
  assert.match(text, /org_id=0/)
  assert.match(text, /组织过滤/)
  assert.match(text, /读取权限/)
})

test('空态判定：非空列表不进入空态（行为不变）', () => {
  assert.equal(reposEmptyKind(0, false, 0), 'list')
  assert.equal(reposEmptyKind(0, true, 0), 'list')
  assert.equal(reposEmptyKind(3, true, 0), 'search')
  assert.equal(reposEmptyKind(3, false, 3), 'none')
  assert.equal(reposEmptyKind(3, true, 1), 'none')
})

test('诊断包含查询端点/参数、原始条数、total、org_id', () => {
  const d = buildReposDiagnostics(
    { repos: [{ full_name: 'alice/proj', role: 'Admin' }], total: 5, org_id: 0 },
    { params: { force: '1' }, now: new Date('2026-11-16T00:00:00Z') },
  )
  assert.equal(d.rawCount, 1)
  assert.equal(d.total, 5)
  assert.equal(d.orgId, '0')
  assert.equal(d.orgIdKnown, true)
  const text = renderReposDiagnostics(d)
  assert.match(text, /GET \/api\/repos\/managed/)
  assert.match(text, /force=1/)
  assert.match(text, /原始返回条数: 1/)
  assert.match(text, /total: 5/)
  assert.match(text, /org_id 推断: 0/)
})

test('元数据缺失时显示「未知」，不伪造 total / org_id', () => {
  const d = buildReposDiagnostics({ repos: [] })
  assert.equal(d.total, null)
  assert.equal(d.orgIdKnown, false)
  const text = renderReposDiagnostics(d)
  assert.match(text, /total: 未知（接口未返回 total）/)
  assert.match(text, /org_id 推断: 未知/)
  assert.match(text, /org_id=0 被组织过滤/)
})

test('脱敏：token/key/Authorization/Cookie 与 token 前缀均不泄露', () => {
  const raw = [
    'token=abc123',
    'Authorization: Bearer xyz',
    'Cookie: sid=1',
    'key: super-secret',
    'api_key=zzz',
    'value tk_deadbeef123456',
    'grape_abcdef123456',
  ].join('\n')
  const out = redactSensitiveText(raw)
  for (const secret of ['abc123', 'Bearer xyz', 'sid=1', 'super-secret', 'zzz', 'tk_deadbeef123456', 'grape_abcdef123456']) {
    assert.ok(!out.includes(secret), `脱敏后仍含：${secret}`)
  }
  assert.match(out, /已脱敏/)
})

test('复制文本即使查询参数夹带凭据也不泄露', () => {
  const d = buildReposDiagnostics({ repos: [] }, { params: { token: 'leak-me-123', owner: 'alice' } })
  const text = renderReposDiagnostics(d)
  assert.ok(!text.includes('leak-me-123'), '诊断文本泄露了 token')
  assert.match(text, /owner=alice/)
  assert.match(text, /已脱敏/)
})

test('withReposDiagnostics 保留 repos 并追加 diagnostics', () => {
  const out = withReposDiagnostics({ repos: [{ full_name: 'alice/proj', role: 'Admin' }] })
  assert.equal(out.repos.length, 1)
  assert.equal(out.diagnostics.rawCount, 1)
})

test('withReposDiagnostics 兼容 CLI 直接返回数组（不丢数据）', () => {
  const out = withReposDiagnostics([{ full_name: 'alice/proj', role: 'Admin' }])
  assert.equal(Array.isArray(out.repos), true)
  assert.equal(out.repos.length, 1)
  assert.equal(out.diagnostics.rawCount, 1)
})

test('total / total_count 为数字字符串时按数字展示（未来接口兼容）', () => {
  const d = buildReposDiagnostics({ repos: [], total: '5' })
  assert.equal(d.total, 5)
  assert.equal(d.totalText, '5')

  const d2 = buildReposDiagnostics({ repos: [], total_count: ' 7 ' })
  assert.equal(d2.total, 7)

  const d3 = buildReposDiagnostics({ repos: [], total: 'abc' })
  assert.equal(d3.total, null)
  assert.match(d3.totalText, /未知/)
})

test('已由宿主生成的合法 diagnostics 直接复用（不重复计算）', () => {
  const pre = buildReposDiagnostics({ repos: [] }, { now: new Date('2026-11-16T00:00:00Z') })
  const again = buildReposDiagnostics({ repos: [{ full_name: 'alice/proj', role: 'Admin' }], diagnostics: pre })
  assert.deepEqual(again, pre)
})

test('当前账号角色：auth profile + orgs list 白名单收敛，不含邮箱', () => {
  const profile = {
    username: 'developer_ch',
    email: 'leak@example.com',
    managed_repos: [
      { key: 'alice/a', is_admin: true },
      { key: 'alice/b', is_admin: false },
    ],
  }
  const orgs = [
    { id: 193, name: 'developer_ch的个人空间', slug: 'personal-46', role: 'owner', is_personal: true },
    { id: 206, name: 'AI洞察分析团队', slug: 'ai', role: 'member', is_personal: false },
  ]
  const viewer = summarizeViewer(profile, orgs)
  assert.equal(viewer.username, 'developer_ch')
  assert.equal(viewer.managedRepoCount, 2)
  assert.equal(viewer.adminRepoCount, 1)
  assert.equal(viewer.orgs.length, 2)
  assert.equal(viewer.orgs[0].role, 'owner')
  assert.equal(viewer.orgs[0].personal, true)

  const text = renderReposDiagnostics(buildReposDiagnostics({ repos: [] }, { viewer }))
  assert.match(text, /当前账号: developer_ch/)
  assert.match(text, /账号组织角色: .*owner（个人空间）/)
  assert.match(text, /账号组织角色: .*member/)
  assert.match(text, /账号托管权限: 2 个（Admin 1 \/ 其他 1）/)
  assert.ok(!text.includes('leak@example.com'), '账号信息泄露了邮箱')
})

test('当前账号缺失时显示「未知」；0 个托管仓库时给出明确结论', () => {
  const unknown = renderReposDiagnostics(buildReposDiagnostics({ repos: [] }))
  assert.match(unknown, /当前账号: 未知/)
  assert.match(unknown, /账号托管权限: 未知/)

  const none = summarizeViewer({ username: 'nobody', managed_repos: [] }, [])
  const text = renderReposDiagnostics(buildReposDiagnostics({ repos: [] }, { viewer: none }))
  assert.match(text, /当前账号: nobody/)
  assert.match(text, /账号托管权限: 0 个（当前账号没有任何托管仓库权限）/)
  assert.equal(summarizeViewer(null, null), null)
})