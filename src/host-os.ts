/**
 * 宿主平台探测（跨平台适配）。
 *
 * 服务端按 host_os 渲染接管脚本与 prompt；插件负责上报 + 落地，
 * 不在插件里维护第二套脚本内容（单一事实源：服务端 build_script_assets）。
 */

import { arch as nodeArch, homedir, platform as nodePlatform, release } from 'node:os'

export type HostOs = 'windows' | 'darwin' | 'linux'
export type HostShell = 'powershell' | 'cmd' | 'bash' | 'zsh'

export interface HostInfo {
  /** 归一后的 OS 名（与服务端 normalize_host_os 对齐） */
  os: HostOs
  /** 原始 process.platform（win32 / darwin / linux） */
  raw: string
  arch: string
  shell: HostShell
  release: string
  home: string
  /** true = 需要按 Windows 语义处理（路径、换行、chmod） */
  isWindows: boolean
}

export function normalizeHostOs(value: string | undefined | null): HostOs {
  const v = String(value || '').trim().toLowerCase()
  if (v === 'windows' || v === 'win32' || v === 'win' || v === 'windows-nt') return 'windows'
  if (v === 'darwin' || v === 'macos' || v === 'mac' || v === 'osx') return 'darwin'
  return 'linux'
}

export function detectHostInfo(): HostInfo {
  const raw = String(nodePlatform() || 'linux')
  const os = normalizeHostOs(raw)
  let shell: HostShell = 'bash'
  if (os === 'windows') {
    // PowerShell 是 Windows 主路径（服务端渲染 .ps1）；COMSPEC 存在时仍可用 cmd 兜底
    shell = 'powershell'
  } else if (os === 'darwin') {
    shell = 'zsh'
  }
  return {
    os,
    raw,
    arch: String(nodeArch() || ''),
    shell,
    release: String(release() || ''),
    home: homedir(),
    isWindows: os === 'windows',
  }
}

/** 单引号包裹，内部单引号按平台转义（POSIX: '\'' ；PowerShell: ''） */
export function quoteArg(value: string, shell: HostShell): string {
  const v = String(value ?? '')
  if (shell === 'powershell') return "'" + v.replace(/'/g, "''") + "'"
  if (shell === 'cmd') return '"' + v.replace(/"/g, '""') + '"'
  return "'" + v.replace(/'/g, "'\\''") + "'"
}

/** 平台归一化路径（用于跨平台比较/正则匹配；Windows 反斜杠转正斜杠、盘符保留） */
export function normalizePath(p: string): string {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

/** shell 里执行某个脚本的调用形式（与执行器无关，仅用于提示文案） */
export function scriptInvocation(host: HostInfo, filename: string, args: string[] = []): string {
  if (host.isWindows) {
    const a = args.map((x) => quoteArg(x, 'powershell')).join(' ')
    return `pwsh -ExecutionPolicy Bypass -File .\\${filename}${a ? ' ' + a : ''}`
  }
  const a = args.map((x) => quoteArg(x, 'bash')).join(' ')
  return `sh ./${filename}${a ? ' ' + a : ''}`
}