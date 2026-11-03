// 替换跳过编辑器里没保存的文件（审查报告 2026-11-03）：代码模式下 ref 是会话，标签记的是项目，
// 原来按会话找标签找不到，没保存的文件照样被写掉
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/data', () => ({ isDemo: false, projects: [] }))
vi.mock('@/data/demo', () => ({ demo: () => ({}) }))
vi.mock('@/features/machines/store', () => ({
  machineOf: () => 'local',
  isWindowsMachine: () => false,
  getMachines: () => ({ currentId: 'local' }),
}))
vi.mock('@/features/engine/store', () => ({ getEngineState: () => ({ sessions: [] }) }))
vi.mock('@/features/panes/store', () => ({ paneActions: { replace: () => {}, detachFileTab: () => {} } }))

const saved: string[] = []
const events = new EventTarget()
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', {
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  pixelsky: {
    platform: 'linux',
    files: {
      // 会话在项目主文件夹里跑：文件接口认的是项目
      target: async () => ({ ref: { projectId: 'p1' }, name: 'p', path: '/w' }),
      read: async (_ref: unknown, path: string) => ({
        kind: 'text',
        path,
        content: 'foo\n',
        version: 'v1',
        readonly: false,
      }),
      save: async (_ref: unknown, path: string) => void saved.push(path),
      headContent: async () => null,
    },
  },
})

const store = await import('@/features/files/store')
const { planReplace, applyReplace } = await import('./replace')
const { NO_OPTIONS } = await import('@/features/search/replaceModel')

describe('替换和编辑器里打开的文件', () => {
  it('按会话搜索时，没保存的文件跳过，不写', async () => {
    const session = { sessionId: 's1' }
    const id = await store.openFile(session, 'a.ts')
    store.updateFile(id!, { draft: 'foo edited\n' })
    const plan = await planReplace(
      session,
      [
        { path: 'a.ts', lines: null },
        { path: 'b.ts', lines: null },
      ],
      'foo',
      NO_OPTIONS,
      'bar',
    )
    expect(plan.dirty).toEqual(['a.ts'])
    expect(plan.edits.map(e => e.path)).toEqual(['b.ts'])
    // 确认期间改了 b.ts 的草稿：写之前再看一眼，也不写
    const other = await store.openFile(session, 'b.ts')
    store.updateFile(other!, { draft: 'changed\n' })
    const result = await applyReplace(session, plan)
    expect(result.dirty).toEqual(['a.ts', 'b.ts'])
    expect(saved).toEqual([])
  })
})
