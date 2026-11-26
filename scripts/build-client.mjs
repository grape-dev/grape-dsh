/**
 * 构建 grape-dsh 的 client half（浏览器侧 bundle）。
 *
 * dsh 的 client bundle 格式是 "CJS-in-envelope"：
 *   window.__ModuleLoader__.load({
 *     id: '<包名>',
 *     factory: (require) => {
 *       var module = { exports: {} }; var exports = module.exports;
 *       <CJS 代码>
 *       return module.exports;
 *     }
 *   })
 *
 * 本脚本：esbuild 打包 src/client/index.tsx → CJS（外部依赖保留 require）
 *        → 包裹进上面的 envelope → 写 lib/client.js
 *
 * 用法：npm run bundle
 */

import { build } from 'esbuild'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const root = resolve(__dirname, '..')

/**
 * 包名——单一真源：package.json 的 name（dsh 用它做 module id）。
 * 不在脚本里硬编码，避免下次改名漏改；防漂移单测会校验三者一致。
 */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export const PKG_NAME = pkg.name

/** 外部依赖：由 dsh 模块系统提供，不打进 bundle */
const EXTERNAL = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/*',
]

async function main() {
  const result = await build({
    entryPoints: [resolve(root, 'src/client/index.tsx')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: EXTERNAL,
    write: false,
    minify: false,        // 保留可读性，方便调试；后续可开
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  })

  const code = result.outputFiles[0].text

  // 包裹进 dsh 的 module envelope
  // 注意：CJS 代码里对 react 等的 require() 会用到 envelope 传进来的 require
  const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PKG_NAME)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${indent(code, 2)}
\t\treturn module.exports;
\t}
});
`

  const outPath = resolve(root, 'lib/client.js')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, wrapped, 'utf8')

  const kb = (Buffer.byteLength(wrapped, 'utf8') / 1024).toFixed(1)
  console.log(`[build-client] wrote lib/client.js (${kb} KB)`)
}

/** 给多行文本加缩进（用于嵌进 factory 体内） */
function indent(text, level) {
  const pad = '\t'.repeat(level + 1)
  return text
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n')
}

// 仅在直接执行（npm run bundle）时构建；被测试 import 时只导出 PKG_NAME
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(__filename)
if (isDirectRun) {
  main().catch((err) => {
    console.error('[build-client] failed:', err)
    process.exit(1)
  })
}