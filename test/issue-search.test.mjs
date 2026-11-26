/**
 * Issue #41：issue 搜索词归一/校验与视图键后缀。
 *
 * 测试 seam：`src/issue-search.ts` 的纯函数（编入 `lib/`）——宿主 `/issues` 校验与
 * 前端 `browse-store` 视图键共用同一份口径，避免「前端键允许、宿主却 400」的漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ISSUE_SEARCH_PER_PAGE,
  ISSUE_SEARCH_Q_MAX,
  isValidIssueSearchQ,
  issueSearchKeySuffix,
  normalizeIssueSearchQ,
} from '../lib/issue-search.js'

test('搜索词归一：去首尾空白，保留内部空格与大小写', () => {
  assert.equal(normalizeIssueSearchQ('  4341  '), '4341')
  assert.equal(normalizeIssueSearchQ(' Gitee 43 '), 'Gitee 43')
  assert.equal(normalizeIssueSearchQ('IKXR3B'), 'IKXR3B')
  assert.equal(normalizeIssueSearchQ(''), '')
  assert.equal(normalizeIssueSearchQ('   '), '')
  assert.equal(normalizeIssueSearchQ(undefined), '', '非字符串按空处理')
  assert.equal(normalizeIssueSearchQ(4341), '', '数字不收（参数只接受字符串）')
})

test('搜索词归一：前导 # 仅在紧跟编号字符时剥离（平台 q 字面匹配）', () => {
  // 占位符引导「#编号」，但平台 q=#4341 返回 0 条、q=4341 命中 #4341（复审 Required #1）
  assert.equal(normalizeIssueSearchQ('#4341'), '4341')
  assert.equal(normalizeIssueSearchQ('  #4341  '), '4341', '去空白后仍剥离')
  assert.equal(normalizeIssueSearchQ('#IKXR3B'), 'IKXR3B', 'Gitee 字母数字编号同样适用')
  assert.equal(normalizeIssueSearchQ('#4341abc'), '4341abc')
  // 只剥离开头一个 #：后面不是编号字符时保持原样
  assert.equal(normalizeIssueSearchQ('#'), '#')
  assert.equal(normalizeIssueSearchQ('# 4341'), '# 4341')
  assert.equal(normalizeIssueSearchQ('##4341'), '##4341', '只剥离开头一个紧跟编号字符的 #')
  assert.equal(normalizeIssueSearchQ('C#'), 'C#', '非前导 # 不动')
  assert.equal(normalizeIssueSearchQ('修复 #4341'), '修复 #4341', '只有前导 # 是编号前缀')
})

test('搜索词校验：≤64 合法；超长 / 控制字符 / 以 - 开头非法；空串=不搜索', () => {
  assert.equal(ISSUE_SEARCH_Q_MAX, 64)
  assert.equal(ISSUE_SEARCH_PER_PAGE, 50)

  for (const ok of ['', '4341', 'Gitee', 'IKXR3B', '修复 搜索', 'a'.repeat(64)]) {
    assert.equal(isValidIssueSearchQ(ok), true, `应允许：${JSON.stringify(ok)}`)
  }
  for (const bad of ['a'.repeat(65), 'bad\u0001q', 'tab\there', 'del\u007f', 'c1\u0085', '-q', '--repo']) {
    assert.equal(isValidIssueSearchQ(bad), false, `应拒绝：${JSON.stringify(bad)}`)
  }
})

test('视图键后缀：空 q 不产生后缀（默认列表键不变），非空 q 与 page 参与隔离', () => {
  assert.equal(issueSearchKeySuffix(''), '', '默认列表必须保持旧键形态')
  assert.equal(issueSearchKeySuffix('', 2), '', '无 q 时 page 无意义（不改变默认列表键）')
  assert.equal(issueSearchKeySuffix('4341'), ':q=4341')
  assert.equal(issueSearchKeySuffix('#4341'), ':q=4341', '键按归一后的词：前端订阅键与取数键必须一致')
  assert.equal(issueSearchKeySuffix('#4341'), issueSearchKeySuffix('4341'))
  assert.equal(issueSearchKeySuffix('Gitee 43'), ':q=Gitee%2043', '特殊字符编码，避免键分隔符串味')
  assert.equal(issueSearchKeySuffix('4341', 1), ':q=4341', '第 1 页不额外加 p 段')
  assert.equal(issueSearchKeySuffix('4341', 2), ':q=4341:p=2')

  const keys = new Set([
    issueSearchKeySuffix(''),
    issueSearchKeySuffix('4341'),
    issueSearchKeySuffix('Gitee'),
    issueSearchKeySuffix('4341', 2),
  ])
  assert.equal(keys.size, 4, '搜 A / 搜 B / 翻页 / 默认列表四种键必须互不相同')
})