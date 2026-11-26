/**
 * `/grape-worker-api/*` 同源 / CSRF 守卫的契约测试（Issue #40 P0）。
 *
 * 背景：此前 16 条 POST 路由没有任何 Origin / Sec-Fetch-Site 校验，跨站页面可以用
 * `text/plain` 的「简单请求」直接打宿主的写路由（实测 evil Origin 也被业务层受理）。
 * 守卫是纯函数：`checkWorkerApiRequest({method, headers})`，本用例覆盖
 * 同源 / 跨站 / 无 Origin（CLI）/ 大小写 / 协议相对 / null / x-forwarded-host / fail-closed。
 *
 * 跑的是 tsc 产物（`lib/`），与其它单测一致：`npm test` 先 build 再跑。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkWorkerApiRequest } from '../lib/worker-api-guard.js'

/** 同源面板请求：Origin 与 Host 一致 */
const SAME_ORIGIN = {
  method: 'POST',
  headers: {
    origin: 'https://dsh.example.com',
    host: 'dsh.example.com',
    'content-type': 'application/json',
  },
}

test('同源 Origin + Host + application/json → 放行', () => {
  const r = checkWorkerApiRequest(SAME_ORIGIN)
  assert.equal(r.allow, true)
})

test('Sec-Fetch-Site=cross-site → 403 cross_site（即使 Origin 伪装成同源）', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: {
      ...SAME_ORIGIN.headers,
      'sec-fetch-site': 'cross-site',
    },
  })
  assert.equal(r.allow, false)
  assert.equal(r.status, 403)
  assert.equal(r.code, 'cross_site')
  assert.ok(r.message)
})

test('Sec-Fetch-Site 归一：大小写与首尾空白不影响判定', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: {
      ...SAME_ORIGIN.headers,
      'Sec-Fetch-Site': '  Cross-Site ',
    },
  })
  assert.equal(r.allow, false)
  assert.equal(r.code, 'cross_site')
})

test('Sec-Fetch-Site=same-origin 不影响放行', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { ...SAME_ORIGIN.headers, 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(r.allow, true)
})

test('Origin=null（沙箱 / opaque）→ 403 cross_origin', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: 'null', host: 'dsh.example.com', 'content-type': 'application/json' },
  })
  assert.equal(r.allow, false)
  assert.equal(r.code, 'cross_origin')
})

test('Origin 主机与 Host 不同 → 403 cross_origin', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: 'https://evil.example', host: 'dsh.example.com', 'content-type': 'application/json' },
  })
  assert.equal(r.allow, false)
  assert.equal(r.code, 'cross_origin')
})

test('Origin 端口不同 → 403 cross_origin（host:port 必须整体一致）', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: 'https://dsh.example.com:8443', host: 'dsh.example.com:8080' },
  })
  assert.equal(r.allow, false)
  assert.equal(r.code, 'cross_origin')
})

test('Origin 与 Host 的端口都一致（含 http + 端口）→ 放行', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: 'http://dsh.example.com:8080', host: 'dsh.example.com:8080', 'content-type': 'application/json' },
  })
  assert.equal(r.allow, true)
})

test('默认端口等价：Origin :443 与 Host 无端口视为同源（https）', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: 'https://dsh.example.com:443', host: 'dsh.example.com' },
  })
  assert.equal(r.allow, true)
})

test('Host 缺失时取 x-forwarded-host 首值（反向代理改写 Host）', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: {
      origin: 'https://dsh.example.com',
      'x-forwarded-host': 'dsh.example.com, proxy.internal',
      'content-type': 'application/json',
    },
  })
  assert.equal(r.allow, true)
})

test('Host 与 x-forwarded-host 都缺失 → fail-closed 403 cross_origin', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: 'https://dsh.example.com', 'content-type': 'application/json' },
  })
  assert.equal(r.allow, false)
  assert.equal(r.code, 'cross_origin')
})

test('HTTP/2 的 :authority 兜底：没有 host / x-forwarded-host 时按它比对 Origin', () => {
  const ok = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: 'https://dsh.example.com', ':authority': 'dsh.example.com', 'content-type': 'application/json' },
  })
  assert.equal(ok.allow, true)

  const bad = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: 'https://evil.example', ':authority': 'dsh.example.com', 'content-type': 'application/json' },
  })
  assert.equal(bad.allow, false)
  assert.equal(bad.code, 'cross_origin')
})

test('协议相对 Origin //host 按 https 解析 → 与 Host 同源放行', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: '//dsh.example.com', host: 'dsh.example.com', 'content-type': 'application/json' },
  })
  assert.equal(r.allow, true)
})

test('协议相对 Origin //evil.example → 403 cross_origin', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: '//evil.example', host: 'dsh.example.com' },
  })
  assert.equal(r.allow, false)
  assert.equal(r.code, 'cross_origin')
})

test('Origin 形态无法解析 → fail-closed 403 cross_origin', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: 'not a url', host: 'dsh.example.com' },
  })
  assert.equal(r.allow, false)
  assert.equal(r.code, 'cross_origin')
})

test('非 GET/HEAD 且 Content-Type=text/plain → 403 bad_content_type（挡 simple-form CSRF）', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: 'https://dsh.example.com', host: 'dsh.example.com', 'content-type': 'text/plain' },
  })
  assert.equal(r.allow, false)
  assert.equal(r.code, 'bad_content_type')
})

test('Content-Type=application/json; charset=utf-8 → 放行（参数不影响媒体类型）', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: {
      origin: 'https://dsh.example.com',
      host: 'dsh.example.com',
      'content-type': 'Application/JSON; charset=utf-8',
    },
  })
  assert.equal(r.allow, true)
})

test('无 Origin 且无 Content-Type（CLI / 宿主内部调用）→ 放行', () => {
  const r = checkWorkerApiRequest({ method: 'POST', headers: { host: 'dsh.example.com' } })
  assert.equal(r.allow, true)
})

test('GET 带 text/plain 同源 → 放行（Content-Type 规则只约束写方法）', () => {
  const r = checkWorkerApiRequest({
    method: 'GET',
    headers: { origin: 'https://dsh.example.com', host: 'dsh.example.com', 'content-type': 'text/plain' },
  })
  assert.equal(r.allow, true)
})

test('HEAD 同样不受 Content-Type 规则约束', () => {
  const r = checkWorkerApiRequest({
    method: 'HEAD',
    headers: { origin: 'https://dsh.example.com', host: 'dsh.example.com', 'content-type': 'text/plain' },
  })
  assert.equal(r.allow, true)
})

test('header 名大写下发（Node 归一前）也一致判定', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { Origin: 'https://evil.example', Host: 'dsh.example.com', 'Content-Type': 'application/json' },
  })
  assert.equal(r.allow, false)
  assert.equal(r.code, 'cross_origin')
})

test('method 大小写不敏感（POST 判定仍生效）', () => {
  const r = checkWorkerApiRequest({
    method: 'post',
    headers: { origin: 'https://dsh.example.com', host: 'dsh.example.com', 'content-type': 'form-urlencoded' },
  })
  assert.equal(r.allow, false)
  assert.equal(r.code, 'bad_content_type')
})

test('x-forwarded-host 以数组下发时取首值', () => {
  const r = checkWorkerApiRequest({
    method: 'POST',
    headers: { origin: 'https://dsh.example.com', 'x-forwarded-host': ['dsh.example.com', 'proxy.internal'] },
  })
  assert.equal(r.allow, true)
})

test('未提供 headers → 视为 CLI 调用放行（无 Origin 无 Content-Type）', () => {
  const r = checkWorkerApiRequest({ method: 'POST' })
  assert.equal(r.allow, true)
})

// ── Issue #42：新增写路由（issue-start / issue-confirm-done / issue-handoff*）──
//
// 守卫挂在 `/grape-worker-api` prefix 入口，按「方法 + 头」判定，与具体路径无关 ——
// 这组用例把 4 条新路由的真实方法与头形态走一遍，证明新增路由**自动**被覆盖：
// 同源放行、跨站 403、text/plain 简单请求 403，一条都不会漏。

const NEW_WRITE_ROUTES = [
  { path: '/grape-worker-api/issue-start', method: 'POST' },
  { path: '/grape-worker-api/issue-confirm-done', method: 'POST' },
  { path: '/grape-worker-api/issue-handoff', method: 'POST' },
  { path: '/grape-worker-api/issue-handoff-targets?id=20864', method: 'GET' },
]

test('Issue #42 新增写路径：同源 Origin → 放行', () => {
  for (const route of NEW_WRITE_ROUTES) {
    const r = checkWorkerApiRequest({ ...SAME_ORIGIN, method: route.method })
    assert.equal(r.allow, true, `${route.method} ${route.path} 同源应放行`)
  }
})

test('Issue #42 新增写路径：跨站 Origin / Sec-Fetch-Site=cross-site → 403', () => {
  for (const route of NEW_WRITE_ROUTES) {
    const evil = checkWorkerApiRequest({
      method: route.method,
      headers: { origin: 'https://evil.example', host: 'dsh.example.com', 'content-type': 'application/json' },
    })
    assert.equal(evil.allow, false, `${route.method} ${route.path} 跨站必须拒绝`)
    assert.equal(evil.code, 'cross_origin')

    const fetchSite = checkWorkerApiRequest({
      method: route.method,
      headers: { ...SAME_ORIGIN.headers, 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(fetchSite.allow, false, `${route.method} ${route.path} cross-site 必须拒绝`)
    assert.equal(fetchSite.code, 'cross_site')
  }
})

test('Issue #42 新增写路径：text/plain 简单请求（CSRF）→ 403 bad_content_type', () => {
  for (const route of NEW_WRITE_ROUTES.filter((x) => x.method === 'POST')) {
    const r = checkWorkerApiRequest({
      method: route.method,
      headers: { origin: 'https://dsh.example.com', host: 'dsh.example.com', 'content-type': 'text/plain' },
    })
    assert.equal(r.allow, false, `${route.path} 的 text/plain 写请求必须拒绝`)
    assert.equal(r.code, 'bad_content_type')
  }
})