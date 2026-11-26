/**
 * 接管状态（client 侧，模块级单例）。
 *
 * 为什么单独成模块：接管会话同时被三处消费 ——
 *   ① NodeChain 的节点按钮（已接管的节点要显示「接管中」且不可再点）；
 *   ② 接管条（完成/放弃/打开会话）；
 *   ③ 点击接管时的「正在接管」乐观态。
 * 三处若各自发请求/各自存状态，就会出现「按钮还写着接管、下面已经显示接管中」的分裂。
 *
 * 数据来源：`POST grape-worker-api/takeover-list`（宿主代理 → 服务端 active 会话）。
 */

import { useEffect, useState } from 'react'

export interface TakeoverInfo {
  /** 服务端会话 id（tkos_…） */
  id: string
  /** 被接管的 agent 节点（vod / issue / coding / qa / sre） */
  agent: string
  /** 本地 dsh 会话 id（session-…），用于「打开接管会话」 */
  local: string
  /** 会话状态是否已进入 requested-finish */
  ready: boolean
}

type Entry = { info: TakeoverInfo | null; busyAgent: string; updatedAt: number }

const state = new Map<string, Entry>()
const listeners = new Set<() => void>()

const keyOf = (repo: string, issue: string): string => `${repo}#${issue}`

function emit(): void {
  for (const l of listeners) {
    try { l() } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

function blank(): Entry {
  return { info: null, busyAgent: '', updatedAt: 0 }
}

export function takeoverEntry(repo: string, issue: string): Entry {
  return state.get(keyOf(repo, issue)) ?? blank()
}

/** 服务端返回的 active 会话（空 → 清掉，避免会话结束后按钮还写「接管中」） */
export function setTakeoverSession(repo: string, issue: string, info: TakeoverInfo | null): void {
  const k = keyOf(repo, issue)
  const prev = state.get(k) ?? blank()
  state.set(k, { ...prev, info, updatedAt: Date.now() })
  emit()
}

/** 点击接管后的乐观态：按钮立刻变「接管中…」，不等网络往返 */
export function setTakeoverBusy(repo: string, issue: string, agent: string): void {
  const k = keyOf(repo, issue)
  const prev = state.get(k) ?? blank()
  state.set(k, { ...prev, busyAgent: agent })
  emit()
}

/** 订阅（NodeChain / 接管条共用） */
export function useTakeoverState(repo: string, issue: string): Entry {
  const [, bump] = useState(0)
  useEffect(() => subscribe(() => bump((n) => n + 1)), [repo, issue])
  return takeoverEntry(repo, issue)
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}