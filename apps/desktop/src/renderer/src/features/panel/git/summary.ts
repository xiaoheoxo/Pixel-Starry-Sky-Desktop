// 工作区的 Git 摘要（分支、未提交的改动数），给顶栏和新任务起点用（docs/ui/workbench-ux-3.md §2.1）；
// 完整状态给输入框上方的 Git 那几项用（docs/ui/composer-git.md）。
// 只读有人在用的工作区；窗口回到前台、项目工具变化、一轮结束或改了文件时重读（去抖），不定时轮询。
// Git 页自己不再挂监听、不再轮询事件：状态读取都走这里（useGitStatus / refreshGitStatus），
// 它做写操作拿到的新状态也写进来（publishGitStatus），所以 Git 页切换分支后顶栏马上跟着变。
import { useEffect, useSyncExternalStore } from 'react'
import { isDemo } from '@/data'
import { demo as demoData } from '@/data/demo'
import { keyRef, refKey } from '@/features/editor/target'
import type { GitStatus } from '../../../../../shared/types/project-tools'
import { summarize, type GitSummary } from './summarize'
import { demoApply } from './demoGit'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'

const cache = new Map<string, GitSummary | null>()
const statuses = new Map<string, GitStatus>()
const users = new Map<string, { ref: WorkspaceRef; count: number }>()
const loading = new Map<string, Promise<void>>()
/** 读的过程中又有人要求重读：这一轮读完后再读一次 */
const again = new Set<string>()
const errors = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0
/** 每读到一次状态加一（内容没变也加）：Git 页的对比、中栏对比标签靠它知道该重读文件内容 */
const revisions = new Map<string, number>()
const revisionListeners = new Set<() => void>()

function changed(): void {
  version++
  listeners.forEach(l => l())
}

/** 读到状态（Git 页、输入框上方的写操作、切换分支）时调用 */
export function publishGitStatus(ref: WorkspaceRef, status: GitStatus): void {
  const key = refKey(ref)
  revisions.set(key, (revisions.get(key) ?? 0) + 1)
  revisionListeners.forEach(l => l())
  if (errors.delete(key)) changed()
  if (JSON.stringify(statuses.get(key)) === JSON.stringify(status)) return
  statuses.set(key, status)
  cache.set(key, summarize(status))
  changed()
}

// 演示模式：输入框上方的提交、拉取、推送在内存里改这一份（GitPanel 的演示状态各管各的）
let demoStatus: GitStatus | null = null
const demoGit = (): GitStatus => (demoStatus ??= structuredClone(demoData().git.status))
export function applyDemoGit(action: string, arg?: unknown): void {
  demoStatus = demoApply(demoGit(), action, arg)
  changed()
}

/**
 * 读一次状态。正在读时：rerun 为 true（事件、手动刷新）会在这一轮后再读一次，保证看到的不早于调用时；
 * 为 false（刚挂上监听、页面切回来）直接共用正在读的这一轮。
 */
function load(ref: WorkspaceRef, rerun: boolean): Promise<void> {
  const api = window.pixelsky?.projectTools
  const key = refKey(ref)
  if (!api) return Promise.resolve()
  const running = loading.get(key)
  if (running) {
    if (rerun) again.add(key)
    return running
  }
  const job = (async () => {
    do {
      again.delete(key)
      try {
        publishGitStatus(ref, await api.gitStatus(ref))
      } catch (e) {
        // 读不到（不是 Git 仓库、远端断开）：保留上次的状态；Git 页还没有状态时显示原因
        const message = (e as Error).message
        if (errors.get(key) !== message) {
          errors.set(key, message)
          changed()
        }
      }
    } while (again.has(key))
  })().finally(() => loading.delete(key))
  loading.set(key, job)
  return job
}

/** 立刻重读这个工作区的状态（Git 页的刷新按钮、15 秒兜底轮询）；soft 为 true 时正在读就不再多读一次 */
export function refreshGitStatus(ref: WorkspaceRef, soft = false): Promise<void> {
  return load(ref, !soft)
}

let timer = 0
let stop: (() => void) | null = null

function reloadSoon(): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => users.forEach(u => void load(u.ref, true)), 400)
}

/** 有人在用时才挂监听 */
function watch(): void {
  const bridge = window.pixelsky
  if (stop || !bridge?.projectTools) return
  const offTools = bridge.projectTools.onChange(reloadSoon)
  const offWindow = bridge.window.onState(state => {
    if (state.focused) reloadSoon()
  })
  const offEngine = bridge.engine.onEvent(e => {
    if (
      e.kind === 'session' &&
      (e.event.type === 'turn_completed' || (e.event.type === 'item_completed' && e.event.item.kind === 'file_change'))
    )
      reloadSoon()
  })
  stop = () => {
    offTools()
    offWindow()
    offEngine()
    window.clearTimeout(timer)
    stop = null
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useGitSummary(ref: WorkspaceRef | null): GitSummary | null {
  const key = useWatched(ref)
  if (isDemo) return ref ? summarize(demoGit()) : null
  return key ? (cache.get(key) ?? null) : null
}

/** 最近读到的完整状态；还没读到、不是 Git 仓库时是 null（不是仓库时 status.repo 为 false）。watching 为 false 时只读缓存，不登记监听 */
export function useGitStatus(ref: WorkspaceRef | null, watching = true): GitStatus | null {
  const key = useWatched(ref, watching)
  if (isDemo) return ref ? demoGit() : null
  return key ? (statuses.get(key) ?? null) : null
}

/** 最近一次读取失败的原因（读到过状态后清掉）；Git 页还没有状态时用来显示。要和 useGitStatus 一起用（由它登记监听） */
export function useGitLoadError(ref: WorkspaceRef | null): string {
  useSyncExternalStore(subscribe, () => version)
  return ref ? (errors.get(refKey(ref)) ?? '') : ''
}

const subscribeRevision = (listener: () => void): (() => void) => {
  revisionListeners.add(listener)
  return () => void revisionListeners.delete(listener)
}

/** 这个工作区读到状态的次数：状态没变时数值也会加，用来触发「重读文件内容」这类依赖 */
export function useGitRevision(ref: WorkspaceRef | null): number {
  const key = ref ? refKey(ref) : null
  return useSyncExternalStore(subscribeRevision, () => (key ? (revisions.get(key) ?? 0) : 0))
}

/** 有人在看这个工作区：登记、挂监听、先读一次；watching 为 false（例如 Git 页不在前台）时不登记 */
function useWatched(ref: WorkspaceRef | null, watching = true): string | null {
  const key = ref ? refKey(ref) : null
  useSyncExternalStore(subscribe, () => version)
  useEffect(() => {
    if (!key || isDemo || !watching) return
    const target = keyRef(key)
    const user = users.get(key)
    if (user) user.count++
    else users.set(key, { ref: target, count: 1 })
    watch()
    void load(target, false)
    return () => {
      const u = users.get(key)
      if (u && --u.count === 0) users.delete(key)
      if (users.size === 0) stop?.()
    }
  }, [key, watching])
  return key
}
