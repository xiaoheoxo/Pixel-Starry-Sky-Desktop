// Git 面板的差异直接改：不开标签拿着文件，放下时清掉（docs/ui/git-diff-copy-edit.md）
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/data', () => ({ isDemo: false, projects: [] }))
vi.mock('@/data/demo', () => ({ demo: () => ({}) }))
vi.mock('@/features/machines/store', () => ({
  machineOf: () => 'local',
  isWindowsMachine: (id: string) => id === 'local' && window.pixelsky?.platform === 'win32',
  getMachines: () => ({ currentId: 'local' }),
}))
vi.mock('@/features/engine/store', () => ({ getEngineState: () => ({ sessions: [] }) }))
vi.mock('@/features/panes/store', () => ({ paneActions: { replace: () => {}, detachFileTab: () => {} } }))

// 磁盘和 HEAD：路径 → 内容
const disk = new Map<string, string>()
const head = new Map<string, string>()
let inFlight = 0
let peak = 0
let gate: Promise<void> = Promise.resolve()
const storage = new Map<string, string>()
const events = new EventTarget()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
})
vi.stubGlobal('window', {
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  pixelsky: {
    platform: 'linux',
    files: {
      target: async () => ({ name: 'p', path: '/w' }),
      read: async (_ref: unknown, path: string) => {
        const content = disk.get(path)
        if (content === undefined) throw new Error('files.notFound')
        return { kind: 'text', path, content, version: path + content, readonly: false }
      },
      headContent: async (_ref: unknown, path: string) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        // 先取值再等：模拟「读的时候还是旧 HEAD，回来时已经提交了」
        const value = head.get(path) ?? null
        await gate
        inFlight--
        return value
      },
    },
  },
})
vi.stubGlobal(
  'CustomEvent',
  class extends Event {
    detail: unknown
    constructor(type: string, init?: { detail?: unknown }) {
      super(type)
      this.detail = init?.detail
    }
  },
)

const store = await import('./store')
const tab = (id: string) => store.getFiles().tabs.find(t => t.id === id)

beforeEach(() => {
  for (const t of store.getFiles().tabs) store.removeFile(t.id)
  disk.clear()
  head.clear()
  peak = 0
  gate = Promise.resolve()
})

describe('holdFile / releaseFile', () => {
  it('拿着时在 store 里、不开标签；放下就清掉', async () => {
    disk.set('a.ts', 'one\n')
    const id = await store.holdFile({ projectId: 'p1' }, 'a.ts')
    expect(tab(id)?.draft).toBe('one\n')
    expect(store.getFiles().active).toBeNull()
    store.releaseFile(id)
    expect(tab(id)).toBeUndefined()
  })

  it('两处都拿着：都放下才清', async () => {
    disk.set('a.ts', 'one\n')
    const id = await store.holdFile({ projectId: 'p1' }, 'a.ts')
    await store.holdFile({ projectId: 'p1' }, 'a.ts')
    store.releaseFile(id)
    expect(tab(id)).toBeDefined()
    store.releaseFile(id)
    expect(tab(id)).toBeUndefined()
  })

  it('有没存的改动：放下时留着（自动保存、退出时照常处理）', async () => {
    disk.set('a.ts', 'one\n')
    const id = await store.holdFile({ projectId: 'p1' }, 'a.ts')
    store.updateFile(id, { draft: 'two\n' })
    store.releaseFile(id)
    expect(tab(id)?.draft).toBe('two\n')
  })

  it('拿着和打开同时进行（还在载入就点了「在编辑器中打开」）：放下不清', async () => {
    disk.set('c.ts', 'one\n')
    const holding = store.holdFile({ projectId: 'p1' }, 'c.ts')
    const opening = store.openFile({ projectId: 'p1' }, 'c.ts')
    const [held, opened] = await Promise.all([holding, opening])
    expect(held).toBe(opened)
    store.releaseFile(held)
    expect(tab(held)).toBeDefined()
  })

  it('本来就开着的、或拿着期间开成了标签：放下不清', async () => {
    disk.set('a.ts', 'one\n')
    disk.set('b.ts', 'one\n')
    const opened = (await store.openFile({ projectId: 'p1' }, 'a.ts'))!
    expect(await store.holdFile({ projectId: 'p1' }, 'a.ts')).toBe(opened)
    store.releaseFile(opened)
    expect(tab(opened)).toBeDefined()
    const held = await store.holdFile({ projectId: 'p1' }, 'b.ts')
    await store.openFile({ projectId: 'p1' }, 'b.ts')
    store.releaseFile(held)
    expect(tab(held)).toBeDefined()
  })
})
