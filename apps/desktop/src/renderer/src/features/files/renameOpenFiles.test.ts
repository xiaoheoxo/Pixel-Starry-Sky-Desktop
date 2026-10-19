// 改名 / 移动后已打开的标签换成新 id（审查报告 2026-10-14）：原来 id 不变，之后在旧路径新建或打开文件
// 会打开成改名后的那个，保存也写进它
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/data', () => ({ isDemo: false, projects: [] }))
vi.mock('@/data/demo', () => ({ demo: () => ({}) }))
vi.mock('@/features/machines/store', () => ({ machineOf: () => 'local', getMachines: () => ({ currentId: 'local' }) }))
vi.mock('@/features/engine/store', () => ({ getEngineState: () => ({ sessions: [] }) }))
const replaced: [string, string][] = []
vi.mock('@/features/panes/store', () => ({
  paneActions: { replace: (a: string, b: string) => replaced.push([a, b]), detachFileTab: () => {} },
}))

// 磁盘：路径 → 内容
const disk = new Map<string, string>()
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
      headContent: async () => null,
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
const { fileTab } = await import('@/features/panes/tree')
const recent = await import('@/features/panel/recentFiles')
const ref = { projectId: 'p1' }
const tab = (id: string) => store.getFiles().tabs.find(t => t.id === id)

beforeEach(() => {
  for (const t of store.getFiles().tabs) store.removeFile(t.id)
  disk.clear()
  replaced.length = 0
})

describe('改名 / 移动后的标签', () => {
  it('标签换成新路径的 id；在原名新建的文件打开成另一个标签，内容和保存都是它自己的', async () => {
    disk.set('a.ts', 'old a')
    const first = await store.openFile(ref, 'a.ts')
    expect(first).toBe(fileTab(ref, 'a.ts'))
    store.updateFile(first!, { draft: 'old a, edited' })
    // 改名：a.ts → b.ts
    disk.set('b.ts', disk.get('a.ts')!)
    disk.delete('a.ts')
    const moved: unknown[] = []
    window.addEventListener(store.FILE_RENAMED_EVENT, e => moved.push((e as CustomEvent).detail))
    store.renameOpenFiles(ref, 'a.ts', 'b.ts')
    const renamed = fileTab(ref, 'b.ts')
    expect(tab(renamed)).toMatchObject({ path: 'b.ts', draft: 'old a, edited' })
    expect(tab(first!)).toBeUndefined()
    expect(store.getFiles().active).toBe(renamed)
    expect(moved).toEqual([[{ from: first, to: renamed }]])
    expect(replaced).toEqual([[first, renamed]])
    // 在原名新建 a.ts 再打开
    disk.set('a.ts', 'brand new a')
    const again = await store.openFile(ref, 'a.ts')
    expect(again).toBe(fileTab(ref, 'a.ts'))
    expect(tab(again!)).toMatchObject({ path: 'a.ts', draft: 'brand new a' })
    expect(tab(renamed)).toMatchObject({ path: 'b.ts', draft: 'old a, edited' })
  })
  it('改名、关掉标签后再打开原路径：读的是原路径', async () => {
    disk.set('c.ts', 'c')
    const id = await store.openFile(ref, 'c.ts')
    disk.set('d.ts', 'c')
    disk.delete('c.ts')
    store.renameOpenFiles(ref, 'c.ts', 'd.ts')
    store.removeFile(fileTab(ref, 'd.ts'))
    disk.set('c.ts', 'new c')
    const reopened = await store.openFile(ref, 'c.ts')
    expect(reopened).toBe(id)
    expect(tab(reopened!)).toMatchObject({ path: 'c.ts', draft: 'new c' })
  })
  it('文件夹改名：里面打开的文件都换；最近文件跟着换', async () => {
    disk.set('src/x.ts', 'x')
    const x = await store.openFile(ref, 'src/x.ts')
    recent.recordRecentFile('scope', x!)
    disk.set('lib/x.ts', 'x')
    store.renameOpenFiles(ref, 'src', 'lib')
    expect(tab(fileTab(ref, 'lib/x.ts'))).toMatchObject({ path: 'lib/x.ts' })
    expect(JSON.parse(storage.get('pixelsky.right-workspace.recent.v1') ?? '{}').scope[0].id).toBe(
      fileTab(ref, 'lib/x.ts'),
    )
  })
})

// 目标文件被外部程序移走、标签还开着且没保存，再把别的文件改名 / 移动到那个路径：
// 以前直接把目标标签和编辑器去掉，草稿没了也撤销不回来；现在文件树先问（displacedDirtyFiles），没确认就不丢
describe('改名 / 移动到开着未保存标签的路径', () => {
  async function openBoth() {
    disk.set('source.js', 'S')
    disk.set('target.js', 'T')
    const source = (await store.openFile(ref, 'source.js'))!
    const target = (await store.openFile(ref, 'target.js'))!
    store.updateFile(target, { draft: 'T edited, unsaved' })
    store.activateFile(target)
    // 外部程序把磁盘上的 target.js 移走，文件树把 source.js 改名成 target.js
    disk.set('target-on-disk-backup.js', disk.get('target.js')!)
    disk.set('target.js', disk.get('source.js')!)
    disk.delete('source.js')
    return { source, target }
  }

  it('displacedDirtyFiles 找出会被顶掉的未保存标签；没改过的、源文件没打开的不算', async () => {
    const { source, target } = await openBoth()
    expect(store.displacedDirtyFiles(ref, 'source.js', 'target.js').map(t => t.id)).toEqual([target])
    // 源文件没打开：挪不过去，也就顶不掉
    store.removeFile(source)
    expect(store.displacedDirtyFiles(ref, 'source.js', 'target.js')).toEqual([])
    // 没改过的不用问
    disk.set('source.js', 'S')
    await store.openFile(ref, 'source.js')
    store.updateFile(target, { draft: 'T' })
    expect(store.displacedDirtyFiles(ref, 'source.js', 'target.js')).toEqual([])
    // 别的工作区的同名标签不算
    expect(store.displacedDirtyFiles({ projectId: 'p2' }, 'source.js', 'target.js')).toEqual([])
  })

  it('没确认丢弃：目标标签和草稿都留着，源标签不挪、不发改名事件（编辑器和撤销记录不动）', async () => {
    const { source, target } = await openBoth()
    const moved: unknown[] = []
    const listen = (e: Event) => moved.push((e as CustomEvent).detail)
    window.addEventListener(store.FILE_RENAMED_EVENT, listen)
    store.renameOpenFiles(ref, 'source.js', 'target.js')
    window.removeEventListener(store.FILE_RENAMED_EVENT, listen)
    expect(tab(target)).toMatchObject({ path: 'target.js', draft: 'T edited, unsaved' })
    expect(store.dirtyFile(tab(target)!)).toBe(true)
    expect(tab(source)).toMatchObject({ path: 'source.js' })
    expect(store.getFiles().active).toBe(target)
    expect(moved).toEqual([])
  })

  it('确认丢弃后：目标标签换成改名过来的文件', async () => {
    const { source, target } = await openBoth()
    store.renameOpenFiles(ref, 'source.js', 'target.js', [target])
    expect(store.getFiles().tabs.filter(t => t.id === target)).toHaveLength(1)
    expect(tab(target)).toMatchObject({ path: 'target.js', draft: 'S' })
    expect(tab(source)).toBeUndefined()
  })

  it('文件夹移动：里面撞上的未保存标签同样留着，没撞上的照常挪', async () => {
    disk.set('a/x.js', 'x')
    disk.set('a/y.js', 'y')
    disk.set('b/a/x.js', 'old x')
    const x = (await store.openFile(ref, 'a/x.js'))!
    const y = (await store.openFile(ref, 'a/y.js'))!
    const stale = (await store.openFile(ref, 'b/a/x.js'))!
    store.updateFile(stale, { draft: 'old x, unsaved' })
    expect(store.displacedDirtyFiles(ref, 'a', 'b/a').map(t => t.id)).toEqual([stale])
    store.renameOpenFiles(ref, 'a', 'b/a')
    expect(tab(stale)).toMatchObject({ path: 'b/a/x.js', draft: 'old x, unsaved' })
    expect(tab(x)).toMatchObject({ path: 'a/x.js' })
    expect(tab(y)).toBeUndefined()
    expect(tab(fileTab(ref, 'b/a/y.js'))).toMatchObject({ path: 'b/a/y.js', draft: 'y' })
  })
})
