import { useSyncExternalStore } from 'react'
import type { CheckItem, MachineState, WorkspaceChoice } from '../../../../shared/types/machines'
import {
  getEngineState,
  setCurrentProject,
  refreshMachineEngine,
  invalidateRemoteSnapshots,
} from '@/features/engine/store'
import { paneActions } from '@/features/panes/store'
import { refreshTerminals } from '@/features/terminal/store'
import { isDemo } from '@/data'
import { isNewTab } from '@/features/panes/tree'
import { demo } from '@/data/demo'

export const machineOf = (id: unknown): string =>
  typeof id === 'string' && /^(ssh|wsl)-[a-f0-9-]+~/.test(id) ? id.slice(0, id.indexOf('~')) : 'local'
const listeners = new Set<() => void>()
let state: MachineState = (isDemo ? demo().machines : undefined) ?? {
  currentId: 'local',
  machines: [
    {
      id: 'local',
      kind: 'local',
      name: '',
      host: '',
      port: 0,
      username: '',
      auth: 'local',
      hasSecret: false,
      status: 'local',
      error: null,
      fingerprint: null,
      platform: window.pixelsky?.platform ?? null,
      home: null,
    },
  ],
}
let started = false
/** 切换机器一次只做一个：后来的排在前一个后面（审查报告 2026-10-14 第 5 条） */
let switchQueue: Promise<void> = Promise.resolve()
export function useMachines(): MachineState {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => state,
  )
}
export const getMachines = (): MachineState => state
/** 这台机器（本机或 SSH 连上的远端）是不是 Windows：路径不分大小写 */
export const isWindowsMachine = (id: string): boolean =>
  (id === 'local' ? window.pixelsky?.platform : state.machines.find(m => m.id === id)?.platform) === 'win32'
const set = (value: MachineState) => {
  const reconnected = value.machines.filter(
    m => m.status === 'connected' && state.machines.find(old => old.id === m.id)?.status !== 'connected',
  )
  state = value
  listeners.forEach(fn => fn())
  for (const machine of reconnected) {
    invalidateRemoteSnapshots(machine.id)
    if (machine.id === state.currentId) void refreshMachineEngine(machine.id).catch(() => {})
  }
}
export async function initMachines(): Promise<void> {
  if (started || isDemo || !window.pixelsky) return
  started = true
  window.pixelsky.machines.onChange(set)
  set(await window.pixelsky.machines.state())
}
/** add：直接打开管理窗口的新建表单（顶栏云端菜单的「添加 SSH 机器」） */
export function openMachineManager(opts: { add?: boolean } = {}): void {
  window.dispatchEvent(new CustomEvent('pixelsky:manage-machines', { detail: { add: opts.add === true } }))
}
/** fresh：选了一定开新对话（输入框上方文件夹菜单的「在别的文件夹开新对话…」），不跳到那个文件夹已有的对话 */
export function openWorkspacePicker(opts: { fresh?: boolean } = {}): void {
  window.dispatchEvent(new CustomEvent('pixelsky:choose-workspace', { detail: opts }))
}
/** 重新检测 WSL 发行版（演示里没有主进程，原样返回） */
export async function refreshWsl(): Promise<void> {
  if (isDemo || !window.pixelsky) return
  set(await window.pixelsky.machines.wslList())
}
/** 只探测不连接；演示里返回当前记录的检查项 */
export async function checkWsl(id: string): Promise<CheckItem[]> {
  if (isDemo || !window.pixelsky) return state.machines.find(m => m.id === id)?.wsl?.lastCheck?.items ?? []
  return window.pixelsky.machines.wslCheck(id)
}
export async function setWslNode(id: string, path: string | null): Promise<void> {
  if (isDemo || !window.pixelsky) return
  await window.pixelsky.machines.wslSetNode(id, path)
}
export async function openWslTerminal(id: string): Promise<void> {
  if (isDemo || !window.pixelsky) return
  await window.pixelsky.machines.wslTerminal(id)
}
/** 切到某台机器。完成时当前机器一定是 id（失败则抛错）：切换中再调用会排队，不会假装已经切好 */
export function selectMachine(id: string): Promise<void> {
  const next = switchQueue.catch(() => {}).then(() => switchTo(id))
  switchQueue = next
  return next
}
async function switchTo(id: string): Promise<void> {
  if (id === state.currentId) return
  const previous = state.currentId
  try {
    if (isDemo) {
      // 演示里只改当前机器，不调主进程、不刷新引擎
      set({ ...state, currentId: id })
      return
    }
    await window.pixelsky!.machines.select(id)
    set(await window.pixelsky!.machines.state())
    await refreshMachineEngine(id)
    paneActions.switchMachine(id)
    const sessions = new Set(getEngineState().sessions.map(s => s.record.id))
    paneActions.prune(tab => isNewTab(tab) || sessions.has(tab))
    await refreshTerminals()
  } catch (error) {
    await window.pixelsky!.machines.select(previous).catch(() => {})
    set(await window.pixelsky!.machines.state())
    await refreshMachineEngine(previous).catch(() => {})
    throw error
  }
}
export async function selectWorkspace(choice: WorkspaceChoice, fresh = false): Promise<void> {
  const id = machineOf(choice.projectId)
  if (id !== state.currentId) await selectMachine(id)
  setCurrentProject(choice.projectId)
  const existing = fresh
    ? undefined
    : getEngineState().sessions.find(
        s =>
          s.record.projectId === choice.projectId &&
          s.record.cwd.replaceAll('\\', '/') === choice.path.replaceAll('\\', '/') &&
          !s.record.archivedAt,
      )
  const record = existing?.record ?? (await window.pixelsky!.machines.openWorkspace(choice))
  paneActions.open(record.id)
  try {
    localStorage.setItem('pixelsky.last-workspace.' + id, JSON.stringify(choice))
  } catch {}
}

// WSL 检查卡片的开关（LocalMenu 和卡片自己共用）：items 是刚探测到的结果，没有时读机器记录里的 lastCheck
interface WslCheckView {
  id: string
  items: CheckItem[] | null
}
let wslCheck: WslCheckView | null = null
const wslCheckListeners = new Set<() => void>()
const setWslCheck = (value: WslCheckView | null) => {
  wslCheck = value
  wslCheckListeners.forEach(fn => fn())
}
export function useWslCheck(): WslCheckView | null {
  return useSyncExternalStore(
    cb => {
      wslCheckListeners.add(cb)
      return () => {
        wslCheckListeners.delete(cb)
      }
    },
    () => wslCheck,
  )
}
export const openWslCheck = (id: string, items: CheckItem[] | null = null): void => setWslCheck({ id, items })
export const updateWslCheck = (id: string, items: CheckItem[]): void => {
  if (wslCheck?.id === id) setWslCheck({ id, items })
}
export const closeWslCheck = (): void => setWslCheck(null)

/**
 * 点了某个 WSL 发行版：已连接就切过去并选工作区；否则先连接，没准备好打开检查卡片。
 * 返回 'card' 表示卡片开着（没切过去）；连接抛错时打开卡片并把错误交给 onError。
 */
export async function chooseWsl(id: string, onError?: (message: string) => void): Promise<'selected' | 'card'> {
  const machine = state.machines.find(m => m.id === id)
  const select = async (): Promise<'selected' | 'card'> => {
    try {
      await selectMachine(id)
    } catch (error) {
      onError?.((error as Error).message)
      openWslCheck(id)
      return 'card'
    }
    openWorkspacePicker()
    return 'selected'
  }
  if (machine?.status === 'connected') return select()
  if (isDemo || !window.pixelsky) {
    // 演示里没有主进程：上次检查必需项都过了就当连上了，否则直接显示检查卡片
    const items = machine?.wsl?.lastCheck?.items ?? []
    return items.length > 0 && items.every(i => !i.required || i.status === 'ok')
      ? select()
      : (openWslCheck(id), 'card')
  }
  try {
    const result = await window.pixelsky.machines.connect(id)
    if (!result.connected) {
      openWslCheck(id, result.items ?? null)
      return 'card'
    }
  } catch (error) {
    onError?.((error as Error).message)
    openWslCheck(id)
    return 'card'
  }
  return select()
}
