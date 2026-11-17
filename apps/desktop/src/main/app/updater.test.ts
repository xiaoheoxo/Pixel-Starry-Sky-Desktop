// 「重启以更新」：先走正常退出，退出流程最后才打开安装程序（审查报告 2026-10-14 第 3 条）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const quit = vi.fn()
const quitAndInstall = vi.fn()
const listeners = new Map<string, (...args: unknown[]) => void>()
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { isPackaged: true, quit, getPath: () => '' },
  shell: { openExternal: vi.fn() },
}))
vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: (name: string, fn: (...args: unknown[]) => void) => listeners.set(name, fn),
    setFeedURL: vi.fn(),
    checkForUpdates: () => Promise.resolve(),
    quitAndInstall,
  },
}))
vi.mock('../ipc/guard', () => ({
  handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
}))
vi.mock('./info', () => ({ channel: () => 'setup', REPO_URL: 'https://github.com/o/r' }))

const { initUpdater, runPendingInstall } = await import('./updater')

beforeEach(() => {
  vi.useFakeTimers()
  quit.mockClear()
  quitAndInstall.mockClear()
  initUpdater({ events: { broadcast: () => {} } } as never)
  listeners.get('update-downloaded')!({ version: '9.9.9', releaseNotes: '' })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('重启以更新', () => {
  it('点按钮只发起退出，不马上打开安装程序；退出流程最后才打开一次', () => {
    handlers.get('update:install')!()
    vi.advanceTimersByTime(200)
    expect(quit).toHaveBeenCalledTimes(1)
    expect(quitAndInstall).not.toHaveBeenCalled()
    runPendingInstall()
    expect(quitAndInstall).toHaveBeenCalledWith(false, true)
    runPendingInstall()
    expect(quitAndInstall).toHaveBeenCalledTimes(1)
  })
  it('没点过按钮的普通退出：不打开安装程序（交给 autoInstallOnAppQuit 静默安装）', () => {
    runPendingInstall()
    expect(quitAndInstall).not.toHaveBeenCalled()
  })
  it('退出被拦下（选了返回保存）超过等待时间：之后的退出不再打开安装程序', () => {
    handlers.get('update:install')!()
    vi.advanceTimersByTime(16_000)
    runPendingInstall()
    expect(quitAndInstall).not.toHaveBeenCalled()
  })
})
