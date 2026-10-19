// 设置独立窗口（docs/ui/settings-window.md）在界面这一侧的状态和入口：
// 当前页面是不是设置窗口、主进程记着的「开没开 / 置顶 / 上次用哪种方式打开」、请求打开窗口、请主窗口做事。
import { useSyncExternalStore } from 'react'
import type { MainWindowAction, SettingsWindowState } from '../../../../shared/types/settings-window'
import { collectSettingsHints } from './windowHints'
import { takeSettingsRow } from './settingsJump'

/** 当前页面是设置独立窗口（地址带 ?view=settings，main/app/settings-window.ts 加载的） */
export const isSettingsWindowView =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('view') === 'settings'

const INITIAL: SettingsWindowState = { open: false, pinned: true, preferWindow: false, workspace: null }
let state: SettingsWindowState = INITIAL
let started = false
const listeners = new Set<() => void>()

function set(next: SettingsWindowState): void {
  state = next
  listeners.forEach(fn => fn())
}

/** 连接主进程：拉一次状态、订阅变化（只做一次；没有 preload 的环境什么都不做） */
export function startSettingsWindowSync(): void {
  const bridge = window.pixelsky?.settingsWindow
  if (started || !bridge) return
  started = true
  bridge.onChange(set)
  void bridge
    .state()
    .then(set)
    .catch(() => undefined)
}

export const getSettingsWindowState = (): SettingsWindowState => state

export function useSettingsWindowState(): SettingsWindowState {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getSettingsWindowState,
    () => INITIAL,
  )
}

/** 主窗口里打开设置时用独立窗口吗：记住的方式是窗口，而且主进程那边接得住 */
export const shouldOpenInWindow = (): boolean =>
  !isSettingsWindowView && state.preferWindow && !!window.pixelsky?.settingsWindow

/**
 * 请主进程打开（或提到前面）设置窗口并跳到 section。
 * 打开前「先记一笔」的请求（要高亮的那一行、滚到某处、日志 / 反馈的跳转……）都在这个窗口的内存里，一并取走带过去。
 * 失败（主进程没接住）时 reject，调用方退回浮层
 */
export function openInSettingsWindow(section?: string): Promise<void> {
  const bridge = window.pixelsky?.settingsWindow
  if (!bridge) return Promise.reject(new Error('settings window unavailable'))
  return bridge.open(section, takeSettingsRow() ?? undefined, collectSettingsHints())
}

/**
 * 主窗口里 openSettings 的去向：记住的方式是独立窗口就请主进程开（或提到前面），否则开浮层。
 * 主进程没接住（窗口建不起来）就退回浮层，别让用户点了没反应
 */
export function openSettingsRouted<S extends string>(section: S | undefined, openDialog: (section?: S) => void): void {
  if (!shouldOpenInWindow()) return openDialog(section)
  openInSettingsWindow(section).catch(() => openDialog(section))
}

/**
 * 做一件「要主窗口去做」的事：设置窗口里转给主进程（它把主窗口提到前面再转过去），
 * 浮层里（主窗口自己）直接发给执行的那一处（MainActionHost）
 */
export const MAIN_ACTION_EVENT = 'pixelsky:main-action'
export function runMainAction(action: MainWindowAction): void {
  if (isSettingsWindowView) void window.pixelsky?.settingsWindow.runInMain(action).catch(() => undefined)
  else window.dispatchEvent(new CustomEvent<MainWindowAction>(MAIN_ACTION_EVENT, { detail: action }))
}
