// 关窗格时文件条目等布局里没了标签再删：收拢动画期间先删的话，FileLifecycle 按布局调 ensureFile 把条目重建，
// 留下没有标签引用、永远不清理的条目
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const map = new Map<string, string>()
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  }
  Object.assign(globalThis, {
    localStorage: storage,
    // 定时器转给全局的，fake timers 才能接管
    window: {
      addEventListener() {},
      removeEventListener() {},
      setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id?: number) => globalThis.clearTimeout(id),
      localStorage: storage,
    },
    requestAnimationFrame: () => 0,
  })
})

// 删条目那一刻标签还在不在布局里（布局由测试在导入 store 后填进来，工厂里不能反过来导入 store）
const files = vi.hoisted(() => ({
  removed: [] as Array<{ tab: string; inLayout: boolean }>,
  inLayout: (_tab: string): boolean => false,
}))
vi.mock('./motion', () => ({ motionEnabled: () => true, cssDuration: () => 0 }))
vi.mock('@/features/files/FileConfirm', () => ({ confirmFiles: async () => true }))
vi.mock('@/features/files/store', () => ({
  getFiles: () => ({ tabs: [] }),
  dirtyFile: () => false,
  removeFile: (tab: string) => files.removed.push({ tab, inLayout: files.inLayout(tab) }),
}))
vi.mock('@/features/engine/store', () => ({
  getEngineState: () => ({ currentProjectId: null, projects: [], snapshots: {}, sessions: [] }),
  setCurrentProject: () => {},
}))
vi.mock('@/features/machines/store', () => ({ getMachines: () => ({ currentId: 'local' }) }))
vi.mock('@/features/layout/page', () => ({ showWorkbench: () => {} }))

const { paneActions, getPaneState } = await import('./store')
const T = await import('./tree')
files.inLayout = tab => T.leaves(getPaneState().layout.root).some(l => l.tabs.includes(tab))

describe('关窗格时的文件条目', () => {
  it('收拢动画结束、布局里没了这个标签以后才删文件条目', async () => {
    vi.useFakeTimers()
    paneActions.split('row', { width: 4000, height: 1000 })
    const file = T.fileTab({ projectId: 'p1' }, 'a.ts')
    paneActions.open(file)
    const leafId = getPaneState().layout.focused
    await paneActions.closePane(leafId)
    // 收拢中：窗格还在布局里，条目不能删
    expect(getPaneState().closing[leafId]).toBe(true)
    expect(files.removed).toEqual([])
    vi.runAllTimers()
    expect(T.findLeaf(getPaneState().layout.root, leafId)).toBeNull()
    expect(files.removed).toEqual([{ tab: file, inLayout: false }])
    vi.useRealTimers()
  })
})
