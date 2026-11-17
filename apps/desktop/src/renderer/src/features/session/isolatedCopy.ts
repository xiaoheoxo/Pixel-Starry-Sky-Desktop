// 新建页的「独立副本」开关（docs/ui/desktop-parity.md §3.2）：开着时发第一条消息先建一个 Git 副本，会话开在副本里。
// 记住的是「这个项目上次开没开」，存在本机 localStorage；读写失败不影响使用。
import { useSyncExternalStore } from 'react'
import { isChatProject } from '@pixelsky/protocol'
import { isDemo } from '@/data'
import { tr, translateMessage } from '@/i18n/core'
import { cleanIpcError } from '@/features/account/useStore'
import { draftWorkspace, useDraftWorkspace } from '@/features/machines/drafts'
import { getEngineState, useEngineState } from '@/features/engine/store'
import { cachedGitStatus, useGitStatus } from '@/features/panel/git/summary'
import type { GitStatus, ProjectCopy } from '../../../../shared/types/project-tools'
import { copyName, defaultBranch } from './branch/naming'

const KEY = isDemo ? 'pixelsky.isolated-copy.demo' : 'pixelsky.isolated-copy'
const DEMO_PROJECT = 'demo'

let on: Record<string, true> = {}
try {
  const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
  if (raw && typeof raw === 'object' && !Array.isArray(raw))
    for (const [id, v] of Object.entries(raw)) if (v === true) on[id] = true
} catch {
  /* 坏数据当作都没开 */
}
/** 正在建副本的新会话标签 */
let creating = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
const emit = (): void => {
  version++
  listeners.forEach(l => l())
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export const isolatedOn = (projectId: string): boolean => on[projectId] === true

export function setIsolated(projectId: string, value: boolean): void {
  if (isolatedOn(projectId) === value) return
  const next = { ...on }
  if (value) next[projectId] = true
  else delete next[projectId]
  on = next
  try {
    localStorage.setItem(KEY, JSON.stringify(on))
  } catch {}
  emit()
}

function setCreating(tab: string, value: boolean): void {
  if (creating.has(tab) === value) return
  creating = new Set(creating)
  if (value) creating.add(tab)
  else creating.delete(tab)
  emit()
}

const normalize = (p: string): string => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s
}

/**
 * 能不能在这个项目开副本：有提交的 Git 仓库、项目目录就是仓库根（子文件夹项目建的副本是整个仓库，会话会落到仓库根）。
 * 能开时返回副本的起点：当前分支，分离 HEAD 时是当前提交
 */
export function copyBase(status: GitStatus | null, projectPath: string): string | null {
  if (!status || !status.repo || status.missing || status.initial || !status.head || !status.root) return null
  if (!projectPath || normalize(status.root) !== normalize(projectPath)) return null
  return !status.detached && status.branch ? status.branch : status.head
}

export interface IsolatedCopy {
  projectId: string
  /** 副本从哪儿开：分支名，或分离 HEAD 时的提交；记住是开着、Git 状态还没读到（或读不到）时为 null */
  base: string | null
  on: boolean
  set(on: boolean): void
  creating: boolean
}

/**
 * 这个新会话标签（不看 Git）能不能开副本：不是「对话」、草稿没选副本；从会话里新建（Ctrl+N、窗格「+」）时沿用的目录
 * 就是项目目录也算（会话在副本或别的文件夹里时不算）。返回项目和项目记录里的目录
 */
export function isolatedTarget(
  tab: string,
  projectId: string | null | undefined,
): { projectId: string; path: string } | null {
  if (!projectId || isChatProject(projectId)) return null
  const project = getEngineState().projects.find(p => p.id === projectId)
  if (!project) return null
  const draft = draftWorkspace(tab)
  if (draft?.copyId) return null
  if (draft?.sessionId && normalize(draft.path) !== normalize(project.path)) return null
  return { projectId, path: project.path }
}

/** 加上 Git：项目能开副本（copyBase）时返回项目和起点 */
export function isolatedPlan(
  tab: string,
  projectId: string | null | undefined,
  status: (projectId: string) => GitStatus | null,
): { projectId: string; base: string } | null {
  const target = isolatedTarget(tab, projectId)
  const base = target ? copyBase(status(target.projectId), target.path) : null
  return target && base ? { projectId: target.projectId, base } : null
}

/** 开关用：tab 是新会话标签的草稿键，已经有会话的标签不传 */
export function useIsolatedCopy(tab: string | undefined, projectId: string | null | undefined): IsolatedCopy | null {
  const snap = (): number => version
  useSyncExternalStore(subscribe, snap, snap)
  // 项目列表变了（改了目录、删了项目）跟着重算
  useEngineState(s => s.projects)
  useDraftWorkspace(tab)
  const watched = !isDemo && !!tab && !!projectId && !isChatProject(projectId) ? projectId : null
  const status = useGitStatus(watched ? { projectId: watched } : null)
  if (isDemo) {
    if (!tab) return null
    return {
      projectId: DEMO_PROJECT,
      base: cachedGitStatus({ projectId: DEMO_PROJECT })?.branch ?? 'main',
      on: isolatedOn(DEMO_PROJECT),
      set: v => setIsolated(DEMO_PROJECT, v),
      creating: false,
    }
  }
  if (!tab || !watched) return null
  const target = isolatedTarget(tab, watched)
  if (!target) return null
  const base = copyBase(status, target.path)
  const on = isolatedOn(target.projectId)
  // 记住是开着、状态还没读到或读不到：照样显示（开着），发送时会再读一次，读不到就报错，用户得能在这里关掉
  if (!base && !(on && !status)) return null
  return {
    projectId: target.projectId,
    base,
    on,
    set: v => setIsolated(target.projectId, v),
    creating: creating.has(tab),
  }
}

/** 建副本要用的接口（preload 的 projectTools；测试里换成假的） */
export interface CopyApi {
  branches(projectId: string): Promise<string[]>
  /** 已有副本的名字（machines.workspaces：只跑一条 git worktree list，不逐个读副本状态） */
  copyNames(projectId: string): Promise<string[]>
  createCopy(
    projectId: string,
    input: { name: string; branch: string; existingBranch: boolean; base: string },
  ): Promise<ProjectCopy>
}

/** 同一个项目的建副本排队：前一个建好（分支已经有了）再读分支列表起名，免得同一分钟发的两条起出同一个名字 */
const queues = new Map<string, Promise<unknown>>()

/**
 * 发第一条消息前建副本：分支名照开分支弹窗的规则（第一条消息里的英文词，没有就用日期时间），副本名取分支名最后一段；
 * 建的过程中这个标签显示「正在建副本…」。失败时的错误带上「建独立副本失败」
 */
export function createIsolatedCopy(
  api: CopyApi,
  tab: string,
  projectId: string,
  base: string,
  prompt: string,
): Promise<ProjectCopy> {
  setCreating(tab, true)
  const run = async (): Promise<ProjectCopy> => {
    try {
      const [branches, names] = await Promise.all([api.branches(projectId), api.copyNames(projectId)])
      const branch = defaultBranch(prompt, branches)
      const name = copyName(branch, names)
      return await api.createCopy(projectId, { name, branch, existingBranch: false, base })
    } catch (err) {
      throw new Error(tr('session.isolated.failed', { reason: translateMessage(cleanIpcError(err, String(err))) }))
    } finally {
      setCreating(tab, false)
    }
  }
  const job = (queues.get(projectId) ?? Promise.resolve()).then(run, run)
  const tail = job.catch(() => undefined)
  queues.set(projectId, tail)
  void tail.then(() => queues.get(projectId) === tail && queues.delete(projectId))
  return job
}
