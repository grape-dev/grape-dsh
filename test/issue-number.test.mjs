/**
 * issue 编号口径单点（Issue #39 复审 Required #1/#2）。
 *
 * 编号是「平台相关的不透明标识」：GitCode/GitHub 是整数，Gitee 是字母数字（`IKXR3B`），
 * `"0"` 是 Gitee 的「非子任务」占位值而非编号。此前这份判定在宿主角（`panel-api.ts`）、
 * pins 存档（`pins-persist.ts`）、预览选择（`preview-select.ts`）各写一套，客户端还把同一份
 * 正则内联在 `@` 引用反解与自动 pin 里 —— 白名单一改就漏改。
 *
 * 本用例是该口径的唯一契约：
 *   · 校验/归一只认 `src/issue-number.ts` 一处（源码扫描守护）；
 *   · `@` 引用反解与自动 pin 编号解析是纯函数，可被 node:test 直接覆盖；
 *   · 回退成 `#(\d+)` 必须让本文件变红（客户端主症状的回归保护）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ISSUE_NUMBER_RE,
  extractIssueNumberFromText,
  formatIssueRefForModel,
  isValidIssueNumber,
  normalizeIssueNumber,
  parseIssueRef,
} from '../lib/issue-number.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

/** 递归收集 src 下的 ts/tsx 源文件 */
function srcFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...srcFiles(p))
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

test('isValidIssueNumber: 两平台编号形态都合法', () => {
  assert.equal(isValidIssueNumber('32'), true)          // GitCode 整数投影为字符串
  assert.equal(isValidIssueNumber('IKXR3B'), true)      // Gitee 字母数字
  assert.equal(isValidIssueNumber('issue_39-a'), true)  // 下划线/连字符都是 Gitee 合法形态
  assert.equal(isValidIssueNumber('a'.repeat(32)), true)
})

test('isValidIssueNumber: "0"/空/非法形态一律拒绝', () => {
  assert.equal(isValidIssueNumber('0'), false)          // Gitee parent_issue_number 占位
  assert.equal(isValidIssueNumber(''), false)
  assert.equal(isValidIssueNumber('a'.repeat(33)), false) // 超 32 字符
  assert.equal(isValidIssueNumber('-1'), false)         // 首字符必须是字母数字（挡 flag 走私）
  assert.equal(isValidIssueNumber('a b'), false)        // 空格
  assert.equal(isValidIssueNumber('../x'), false)       // 路径穿越
  assert.equal(isValidIssueNumber('a.b'), false)        // 点号
})

test('normalizeIssueNumber: 数字/字符串归一，缺失与 "0" 归空串', () => {
  assert.equal(normalizeIssueNumber(32), '32')
  assert.equal(normalizeIssueNumber('  IKXR3B '), 'IKXR3B')
  assert.equal(normalizeIssueNumber('0'), '')
  assert.equal(normalizeIssueNumber(0), '')
  assert.equal(normalizeIssueNumber(undefined), '')
  assert.equal(normalizeIssueNumber(null), '')
  assert.equal(normalizeIssueNumber({}), '')
  assert.equal(normalizeIssueNumber(NaN), '')
  assert.equal(normalizeIssueNumber('a b'), '')
  assert.equal(normalizeIssueNumber('../x'), '')
})

test('parseIssueRef: owner/repo#编号 反解，非法 ref 返回 null', () => {
  assert.deepEqual(parseIssueRef('grape-dev/grape-dsh#IKXR3B'), {
    owner: 'grape-dev', repo: 'grape-dsh', number: 'IKXR3B',
  })
  assert.deepEqual(parseIssueRef('grape-dev/grape-dsh#32'), {
    owner: 'grape-dev', repo: 'grape-dsh', number: '32',
  })
  // 仓库名本身含 `-`/`_` 不受影响（编号段单独按白名单取）
  assert.deepEqual(parseIssueRef('my-org/my_repo#a-b_9'), {
    owner: 'my-org', repo: 'my_repo', number: 'a-b_9',
  })
  assert.equal(parseIssueRef('grape-dev/grape-dsh#0'), null)     // 占位值不是编号
  assert.equal(parseIssueRef('grape-dev/grape-dsh#a b'), null)   // 空格
  assert.equal(parseIssueRef('grape-dev/grape-dsh#../x'), null)  // 路径穿越
  assert.equal(parseIssueRef('no-slash#32'), null)
  assert.equal(parseIssueRef(''), null)
})

test('formatIssueRefForModel: 字母数字编号写进模型文本，非法 ref 退化', () => {
  assert.equal(
    formatIssueRefForModel('grape-dev/grape-dsh#IKXR3B'),
    '<grape-issue repo="grape-dev/grape-dsh" number="IKXR3B"/>',
  )
  assert.equal(
    formatIssueRefForModel('grape-dev/grape-dsh#32', {
      owner: 'grape-dev', repo: 'grape-dsh', number: '32', platform: 'gitcode', title: 't',
    }),
    '<grape-issue repo="grape-dev/grape-dsh" number="32" platform="gitcode" title="t"/>',
  )
  // pin 已取消（引用仍在输入框）→ 退化为可读文本，绝不让发送失败
  assert.equal(formatIssueRefForModel('garbage'), '[Grape issue garbage]')
  assert.equal(formatIssueRefForModel('grape-dev/grape-dsh#0'), '[Grape issue grape-dev/grape-dsh#0]')
})

test('formatIssueRefForModel: 标题里的引号/尖括号被转义（不破坏标签）', () => {
  assert.equal(
    formatIssueRefForModel('o/r#1', { owner: 'o', repo: 'r', number: '1', title: 'a"b<c&d' }),
    '<grape-issue repo="o/r" number="1" title="a&quot;b&lt;c&amp;d"/>',
  )
})

test('extractIssueNumberFromText: 从工具结果文本里取编号（自动 pin）', () => {
  assert.equal(extractIssueNumberFromText('✅ 创建 Issue 完成 #32'), '32')
  assert.equal(extractIssueNumberFromText('✅ 创建 Issue 完成 #IKXR3B'), 'IKXR3B')
  // 后面还跟着别的字段时不截断
  assert.equal(extractIssueNumberFromText('✅ 创建 Issue 完成 #IKXR3B seq=12'), 'IKXR3B')
  assert.equal(extractIssueNumberFromText('✅ 创建 Issue 完成'), '')
  assert.equal(extractIssueNumberFromText(''), '')
  assert.equal(extractIssueNumberFromText('#0'), '')
})

test('源码口径单点：编号白名单只出现在 src/issue-number.ts', () => {
  const literal = '[A-Za-z0-9][A-Za-z0-9_-]{0,31}'
  // 唯一的同形豁免：`panel-api.ts` 的 SEGMENT_RE/FILTER_RE 校验的是 owner/repo 段与
  // 筛选参数值，与 issue 编号同形但语义不同（不放宽编号口径，也不复用编号常量）。
  const EXEMPT = /const (SEGMENT_RE|FILTER_RE) =/
  const hits = []
  for (const file of srcFiles(join(repoRoot, 'src'))) {
    const rel = relative(repoRoot, file).split('\\').join('/')
    if (rel === 'src/issue-number.ts') continue
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!line.includes(literal)) return
      if (rel === 'src/panel-api.ts' && EXEMPT.test(line)) return
      hits.push(`${rel}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(hits, [], '编号白名单正则必须在唯一模块里定义')
})

test('源码口径单点：客户端不得再内联 #(\\d+) 式编号正则', () => {
  for (const rel of ['src/client/grape-mention.ts', 'src/client/GrapeToolView.tsx']) {
    const src = readFileSync(join(repoRoot, rel), 'utf8')
    assert.ok(!src.includes('\\d+'), `${rel} 不应内联只认数字的编号正则，应复用 issue-number 模块`)
    assert.ok(src.includes('issue-number.js'), `${rel} 应复用共享编号口径`)
  }
})

test('ISSUE_NUMBER_RE 与校验函数同源（防止绕过 isValidIssueNumber）', () => {
  assert.equal(ISSUE_NUMBER_RE.test('IKXR3B'), true)
  assert.equal(ISSUE_NUMBER_RE.test('a b'), false)
  // `"0"` 形态本身匹配白名单，拒绝它的是校验函数而非正则 —— 两条一起才是完整口径
  assert.equal(ISSUE_NUMBER_RE.test('0'), true)
  assert.equal(isValidIssueNumber('0'), false)
})