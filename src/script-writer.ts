/**
 * 接管脚本落地（跨平台）。
 *
 * 脚本内容由服务端按 host_os 渲染（bundle.assets.scripts），插件只做三件事：
 *   ① 把内容里的 {{CWD}} 换成**本机**工作目录（服务端不知道客户端路径）
 *   ② 按平台写文件：POSIX 加执行位；Windows 写 UTF-8 with BOM（PowerShell 5.1 识别中文必需）
 *   ③ 清理上一轮另一种平台残留的脚本（.sh ↔ .ps1），避免 agent 读错文件
 */

import fs from 'node:fs'
import path from 'node:path'
import type { HostInfo } from './host-os.js'

export interface BundleScript {
  name: string
  filename: string
  ext: string
  mode?: string
  exec?: string
  content: string
}

export interface WrittenScript {
  name: string
  file: string
  ok: boolean
  error?: string
}

const CWD_MARK = '{{CWD}}'

/** 已知的两种平台脚本文件名（用于清理残留） */
const KNOWN_FILES = [
  '.grape-takeover-env.sh',
  '.grape-takeover-report.sh',
  '.grape-takeover-request-finish.sh',
  '.grape-takeover-env.ps1',
  '.grape-takeover-report.ps1',
  '.grape-takeover-request-finish.ps1',
]

function renderContent(content: string, cwd: string, host: HostInfo): string {
  // Windows 里用反斜杠拼路径更贴近用户习惯；PowerShell 两种都能吃
  const local = host.isWindows ? cwd.replace(/\//g, '\\') : cwd
  return String(content || '').split(CWD_MARK).join(local)
}

/**
 * 把服务端下发的脚本文件名收敛成「工作目录下的一个文件」。
 * 文件名来自 bundle，不可信：`../x`、绝对路径、带分隔符的值都必须拒绝，
 * 否则一次接管就能把文件写到工作目录之外。
 */
export function safeScriptPath(cwd: string, filename: string): string {
  const name = String(filename || '')
  if (!name || name === '.' || name === '..') throw new Error('脚本文件名非法（空或占位符）')
  if (name.includes('/') || name.includes('\\')) throw new Error(`脚本文件名不得包含路径分隔符：${name}`)
  if (path.isAbsolute(name)) throw new Error(`脚本文件名不得是绝对路径：${name}`)
  if (name.includes('\0')) throw new Error('脚本文件名不得包含 NUL')
  const file = path.resolve(cwd, name)
  const root = path.resolve(cwd)
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new Error(`脚本目标越出工作目录：${name}`)
  }
  return file
}

export function writeTakeoverScripts(
  cwd: string,
  scripts: BundleScript[],
  host: HostInfo,
): WrittenScript[] {
  const out: WrittenScript[] = []
  if (!Array.isArray(scripts) || scripts.length === 0) return out

  const wanted = new Set(scripts.map((s) => s.filename))
  // 清理另一平台残留（同名不同扩展），避免 prompt 指的文件和磁盘上的不一致
  for (const f of KNOWN_FILES) {
    if (wanted.has(f)) continue
    const p = path.join(cwd, f)
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch { /* ignore */ }
  }

  for (const s of scripts) {
      let file: string
      try {
        file = safeScriptPath(cwd, s.filename)
      }
      catch (e) {
        out.push({ name: s.name, file: String(s.filename || ''), ok: false, error: String(e instanceof Error ? e.message : e) })
        continue
      }
      const body = renderContent(String(s.content || ''), cwd, host)
      try {
        if (host.isWindows) {
          // UTF-8 with BOM：PowerShell 5.1 对无 BOM 的 UTF-8 中文会乱码
          const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')])
          fs.writeFileSync(file, buf)
        }
        else {
          fs.writeFileSync(file, body, { mode: 0o600 })
          // 0600 写；需要执行位的再提权（env 脚本只 source，不需要 +x）
          const want = s.mode === '0700' ? 0o700 : 0o600
          try { fs.chmodSync(file, want) } catch { /* ignore */ }
        }
        out.push({ name: s.name, file, ok: true })
      }
      catch (e) {
        out.push({ name: s.name, file, ok: false, error: String(e instanceof Error ? e.message : e) })
      }
    }
    return out
  }