// 文件标签「变更 / 并排」的 HEAD 基准：打开时读一次，之后提交、切分支、终端里提交了要跟上（反馈 2026-10-18）
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
let headReads = 0
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
        headReads++
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
  headReads = 0
  peak = 0
  gate = Promise.resolve()
})

describe('HEAD 基准', () => {
  it('提交后重读：基准变成新的 HEAD（「变更」不再把刚提交的内容当改动）', async () => {
    disk.set('head.js', 'COMMITTED_HEAD_REVIEW_CONTENT\n')
    head.set('head.js', 'OLD_HEAD_REVIEW_CONTENT\n')
    const id = (await store.openFile({ projectId: 'p1' }, 'head.js'))!
    expect(tab(id)?.head).toBe('OLD_HEAD_REVIEW_CONTENT\n')
    // 在软件里提交了
    head.set('head.js', 'COMMITTED_HEAD_REVIEW_CONTENT\n')
    await store.refreshHead(id)
    expect(tab(id)?.head).toBe('COMMITTED_HEAD_REVIEW_CONTENT\n')
    expect(tab(id)?.head).toBe(tab(id)?.draft)
  })

  it('内容一样不更新（不触发重绘）', async () => {
    disk.set('a.js', 'x\n')
    head.set('a.js', 'x\n')
    const id = (await store.openFile({ projectId: 'p1' }, 'a.js'))!
    let emits = 0
    const off = store.subscribeFiles(() => emits++)
    await store.refreshHead(id)
    off()
    expect(emits).toBe(0)
  })

  it('refreshHeads 只重读匹配的标签；refreshActiveHead 只读正在看的那个', async () => {
    disk.set('a.js', 'a')
    disk.set('b.js', 'b')
    const a = (await store.openFile({ projectId: 'p1' }, 'a.js'))!
    const b = (await store.openFile({ projectId: 'p2' }, 'b.js'))!
    head.set('a.js', 'A')
    head.set('b.js', 'B')
    headReads = 0
    store.refreshHeads(t => t.ref.projectId === 'p1')
    await vi.waitFor(() => expect(tab(a)?.head).toBe('A'))
    expect(tab(b)?.head).toBeNull()
    expect(headReads).toBe(1)
    store.activateFile(b)
    store.refreshActiveHead()
    await vi.waitFor(() => expect(tab(b)?.head).toBe('B'))
    expect(headReads).toBe(2)
  })

  it('读不到（git 出错 / 超时也是 null）时不把已有的基准清掉', async () => {
    disk.set('a.js', 'new')
    head.set('a.js', 'old')
    const id = (await store.openFile({ projectId: 'p1' }, 'a.js'))!
    head.delete('a.js')
    await store.refreshHead(id)
    expect(tab(id)?.head).toBe('old')
  })

  it('读的途中又被要求重读：读完再补一次，拿到的是最新的 HEAD', async () => {
    disk.set('a.js', 'x')
    head.set('a.js', 'before commit')
    const id = (await store.openFile({ projectId: 'p1' }, 'a.js'))!
    head.set('a.js', 'still before')
    let open!: () => void
    gate = new Promise(r => (open = r))
    const first = store.refreshHead(id)
    // 提交了，又来一次重读请求
    head.set('a.js', 'after commit')
    void store.refreshHead(id)
    gate = Promise.resolve()
    open()
    await first
    expect(tab(id)?.head).toBe('after commit')
  })

  it('一批标签一起重读时限制并发', async () => {
    for (let i = 0; i < 10; i++) disk.set(`f${i}.js`, String(i))
    for (let i = 0; i < 10; i++) await store.openFile({ projectId: 'p1' }, `f${i}.js`)
    peak = 0
    await store.refreshHeads()
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })
})
