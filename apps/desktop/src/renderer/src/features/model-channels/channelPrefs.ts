// 模型通道的本机设置（docs/ui/model-channels.md §2.3、§2.5、§2.6）：按模型记住的执行者、新任务用什么、模型菜单怎么排；
// 前三项进设置同步（settings/sync/registry.ts），Google 账号备注只留在本机（不同电脑可能登录不同账号，docs/antigravity-engine.md §14）；
// 演示模式只改内存，不覆盖真实设置。
import { useSyncExternalStore } from 'react'
import type { EngineId } from '@pixelsky/protocol'
import {
  EXECUTOR_KEY,
  NEW_TASK_KEY,
  executorKey,
  parseExecutorMemory,
  parseNewTask,
  type ModelTarget,
  type NewTaskDefault,
} from './channelModel'
import { MENU_LAYOUT_KEY, parseMenuLayout, type MenuLayout } from './menuModel'

export const GOOGLE_NOTE_KEY = 'pixelsky.channels.googleNote.v1'

export function parseGoogleNote(raw: string | null): string {
  try {
    const v = JSON.parse(raw ?? 'null')
    return typeof v === 'string' ? v.trim().slice(0, 120) : ''
  } catch {
    return ''
  }
}

interface Prefs {
  executors: Record<string, EngineId>
  newTask: NewTaskDefault
  menuLayout: MenuLayout
  googleNote: string
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

let prefs: Prefs = {
  executors: parseExecutorMemory(read(EXECUTOR_KEY)),
  newTask: parseNewTask(read(NEW_TASK_KEY)),
  menuLayout: parseMenuLayout(read(MENU_LAYOUT_KEY)),
  googleNote: parseGoogleNote(read(GOOGLE_NOTE_KEY)),
}
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(fn => fn())

// 别的窗口或设置同步改了
if (typeof window !== 'undefined')
  window.addEventListener('storage', e => {
    if (e.storageArea !== localStorage) return
    if (e.key === EXECUTOR_KEY) prefs = { ...prefs, executors: parseExecutorMemory(e.newValue) }
    else if (e.key === NEW_TASK_KEY) prefs = { ...prefs, newTask: parseNewTask(e.newValue) }
    else if (e.key === MENU_LAYOUT_KEY) prefs = { ...prefs, menuLayout: parseMenuLayout(e.newValue) }
    else if (e.key === GOOGLE_NOTE_KEY) prefs = { ...prefs, googleNote: parseGoogleNote(e.newValue) }
    else return
    emit()
  })

function save(key: string, value: unknown): void {
  if (window.pixelsky?.demo) return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 存不下也能用内存里的 */
  }
}

export function getChannelPrefs(): Prefs {
  return prefs
}

export function useChannelPrefs(): Prefs {
  return useSyncExternalStore(
    fn => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => prefs,
  )
}

/** 换了执行者：按模型记住（授权通道只有一个执行者，不记） */
export function rememberExecutor(target: ModelTarget, engine: EngineId): void {
  const key = executorKey(target)
  if (!key || prefs.executors[key] === engine) return
  prefs = { ...prefs, executors: { ...prefs.executors, [key]: engine } }
  save(EXECUTOR_KEY, prefs.executors)
  emit()
}

export function setNewTaskDefault(next: NewTaskDefault): void {
  prefs = { ...prefs, newTask: next }
  save(NEW_TASK_KEY, next)
  emit()
}

/** 输入框模型菜单：标签页（默认）/ 两栏 */
export function setMenuLayout(layout: MenuLayout): void {
  if (prefs.menuLayout === layout) return
  prefs = { ...prefs, menuLayout: layout }
  save(MENU_LAYOUT_KEY, layout)
  emit()
}

/** Google 账号备注邮箱 / 名称（本机显示，空串即清空） */
export function setGoogleNote(note: string): void {
  const next = note.trim().slice(0, 120)
  if (prefs.googleNote === next) return
  prefs = { ...prefs, googleNote: next }
  save(GOOGLE_NOTE_KEY, next)
  emit()
}
