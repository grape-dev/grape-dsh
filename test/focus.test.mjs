/**
 * 官网深链单元测试。
 *
 * 契约来自线上前端（2026-11-18 实测 `static/js/deeplink.js` + `static/js/app.js`）：
 *   路径 `/app/<owner>/<repo>/` + 哈希 `#<view>[/<param>]`
 * 重点是「同号不同仓库必须落到各自仓库」，不允许静默跳错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  eventFocus,
  grapeAppUrl,
  grapeUrlRepo,
  opsFocus,
  overviewFocus,
  pipelineFocus,
} from '../lib/focus.js'

const BASE = 'https://www.grapedev.cn'

test('真实站点格式：域名 + /app/<owner>/<repo>/ + #pipe[/<issue>]', () => {
  // 用户给的实例（beta 站点 + 真实仓库），补上 issue 号就是流水线深链
  assert.equal(
    grapeAppUrl('https://beta.grapedev.cn:9443', { view: 'pipe', owner: 'developer_ch', repo: 'takeover-ch' }),
    'https://beta.grapedev.cn:9443/app/developer_ch/takeover-ch/#pipe',
  )
  assert.equal(
    grapeAppUrl('https://beta.grapedev.cn:9443', { view: 'pipe', owner: 'developer_ch', repo: 'takeover-ch', number: 8 }),
    'https://beta.grapedev.cn:9443/app/developer_ch/takeover-ch/#pipe/8',
  )
})

test('同号不同仓库：链接互不相同且各自把仓库写进路径（禁止静默跳错）', () => {
  const a = grapeAppUrl(BASE, { view: 'pipe', owner: 'alice', repo: 'proj', number: 8 })
  const b = grapeAppUrl(BASE, { view: 'pipe', owner: 'bob', repo: 'proj', number: 8 })
  assert.equal(a, 'https://www.grapedev.cn/app/alice/proj/#pipe/8')
  assert.equal(b, 'https://www.grapedev.cn/app/bob/proj/#pipe/8')
  assert.notEqual(a, b)
})

test('同一目标重复构造结果一致（「在官网打开」「在侧栏浏览器打开」共用同一 URL）', () => {
  const one = () => grapeAppUrl(BASE, { view: 'pipe', owner: 'alice', repo: 'proj', number: 8 })
  assert.equal(one(), one())
})

test('同仓库不同 issue 的链接互不相同', () => {
  const n8 = grapeAppUrl(BASE, { view: 'pipe', owner: 'alice', repo: 'proj', number: 8 })
  const n9 = grapeAppUrl(BASE, { view: 'pipe', owner: 'alice', repo: 'proj', number: 9 })
  assert.notEqual(n8, n9)
})

test('无仓库维度时退到 /app/#<view>（不再凭空造 ?repo=）', () => {
  assert.equal(grapeAppUrl(BASE, { view: 'pipe', number: 8 }), 'https://www.grapedev.cn/app/#pipe/8')
  assert.equal(grapeAppUrl(BASE, { view: 'observability' }), 'https://www.grapedev.cn/app/#observability')
  assert.equal(grapeAppUrl(BASE, { view: 'dash' }), 'https://www.grapedev.cn/app/#dash')
})

test('事件与概览链接同样带仓库路径', () => {
  assert.equal(grapeAppUrl(BASE, { view: 'event', seq: 123, owner: 'alice', repo: 'proj' }),
    'https://www.grapedev.cn/app/alice/proj/#event/123')
  assert.equal(grapeAppUrl(BASE, { view: 'dash', owner: 'alice', repo: 'proj' }),
    'https://www.grapedev.cn/app/alice/proj/#dash')
})

test('baseUrl 归一：尾斜杠被吃掉；用户连 /app 一起粘进来也不会重复', () => {
  assert.equal(grapeAppUrl('https://www.grapedev.cn///', { view: 'pipe', number: 8 }),
    'https://www.grapedev.cn/app/#pipe/8')
  assert.equal(grapeAppUrl('https://www.grapedev.cn/app', { view: 'pipe', owner: 'alice', repo: 'proj', number: 8 }),
    'https://www.grapedev.cn/app/alice/proj/#pipe/8')
  const url = grapeAppUrl(BASE, { view: 'pipe', owner: 'alice', repo: 'proj', number: 8 })
  assert.ok(!url.includes('\\'))
  assert.ok(!url.includes('?repo='))
})

test('owner / repo 做 URL 编码（名字里可能有非 ASCII）', () => {
  assert.equal(grapeAppUrl(BASE, { view: 'pipe', owner: '团队', repo: '仓库', number: 3 }),
    `https://www.grapedev.cn/app/${encodeURIComponent('团队')}/${encodeURIComponent('仓库')}/#pipe/3`)
})

test('grapeUrlRepo：缺 owner 或 repo 时为空（调用方据此隐藏带回仓库的动作）', () => {
  assert.equal(grapeUrlRepo({ view: 'pipe', owner: 'alice', repo: 'proj' }), 'alice/proj')
  assert.equal(grapeUrlRepo({ view: 'pipe', owner: 'alice' }), '')
  assert.equal(grapeUrlRepo({ view: 'pipe', repo: 'proj' }), '')
})

test('焦点构造器把仓库写进 URL 路径（pipeline / overview / event）', () => {
  assert.match(pipelineFocus(BASE, 'alice', 'proj', 8).url, /\/app\/alice\/proj\/#pipe\/8$/)
  assert.match(overviewFocus(BASE, 'alice', 'proj').url, /\/app\/alice\/proj\/#dash$/)
  const ev = eventFocus(BASE, 7, { owner: 'alice', repo: 'proj' })
  assert.match(ev.url, /\/app\/alice\/proj\/#event\/7$/)
  assert.equal(ev.owner, 'alice')
  assert.equal(ev.repo, 'proj')
})

test('运维概览（全平台）不带仓库维度', () => {
  assert.equal(opsFocus(BASE).url, 'https://www.grapedev.cn/app/#observability')
})
