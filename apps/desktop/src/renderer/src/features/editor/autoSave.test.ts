import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 自动保存什么时候存：文件和引擎的 store 换成假的，只看 saveFile 被调了没有

interface FakeTab {
  id: string
  ref: { projectId: string }
  root: string
  draft: string
  document: { kind: string; content: string; readonly?: boolean } | null
  external: unknown
  loading: boolean
  saving: boolean
}

const files = vi.hoisted(() => ({
  state: { tabs: [] as FakeTab[], active: null as string | null },
  listeners: new Set<() => void>(),
  saveResult: true,
  saved: [] as string[],
}))
const engine = vi.hoisted(() => ({
  sessions: [] as Array<{ record: { id: string; projectId: string; cwd: string }; state: string }>,
  listeners: new Set<() => void>(),
}))

vi.mock('@/data', () => ({ isDemo: false }))
vi.mock('@/features/files/store', () => ({
  getFiles: () => files.state,
  subscribeFiles: (cb: () => void) => (files.listeners.add(cb), () => files.listeners.delete(cb)),
  dirtyFile: (t: FakeTab) => t.document?.kind === 'text' && t.draft !== t.document.content,
  saveFile: async (id: string) => {
    files.saved.push(id)
    const tab = files.state.tabs.find(t => t.id === id)
    if (files.saveResult && tab?.document) tab.document = { ...tab.document, content: tab.draft }
    return files.saveResult
  },
}))
vi.mock('@/features/engine/store', () => ({
  getEngineState: () => ({ sessions: engine.sessions }),
  subscribeEngine: (cb: () => void) => (engine.listeners.add(cb), () => engine.listeners.delete(cb)),
}))

const tab = (id: string, over: Partial<FakeTab> = {}): FakeTab => ({
  id,
  ref: { projectId: 'p1' },
  root: 'D:\\code\\app',
  draft: 'edited',
  document: { kind: 'text', content: 'original' },
  external: null,
  loading: false,
  saving: false,
  ...over,
})

function setFiles(tabs: FakeTab[], active: string | null = tabs[0]?.id ?? null): void {
  files.state = { tabs, active }
  files.listeners.forEach(l => l())
}
const flush = () => new Promise(r => setImmediate(r))

let win: EventTarget & { pixelsky: { platform: string } }

async function setup(prefs: object | null) {
  vi.resetModules()
  const store = new Map<string, string>()
  if (prefs) store.set('pixelsky.editor.autoSave', JSON.stringify(prefs))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  })
  win = Object.assign(new EventTarget(), { pixelsky: { platform: 'win32' } })
  vi.stubGlobal('window', win)
  const autoSave = await import('./autoSave')
  const model = await import('./autoSaveModel')
  autoSave.startAutoSave()
  return model
}

beforeEach(() => {
  files.state = { tabs: [], active: null }
  files.listeners.clear()
  files.saveResult = true
  files.saved = []
  engine.sessions = []
  engine.listeners.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('自动保存', () => {
  it('默认关闭：窗口、编辑器失去焦点都不存', async () => {
    const model = await setup(null)
    setFiles([tab('a')])
    win.dispatchEvent(new Event('blur'))
    model.notifyEditorBlur('a')
    await flush()
    expect(files.saved).toEqual([])
  })

  it('窗口失去焦点时：只存有改动、能存的文件', async () => {
    await setup({ mode: 'onWindowChange' })
    setFiles([
      tab('dirty'),
      tab('clean', { draft: 'original' }),
      tab('readonly', { document: { kind: 'text', content: 'x', readonly: true } }),
      tab('conflict', { external: { kind: 'text' } }),
    ])
    win.dispatchEvent(new Event('blur'))
    await flush()
    expect(files.saved).toEqual(['dirty'])
  })

  it('编辑器失去焦点时：存那个文件；换标签页时存原来那个', async () => {
    const model = await setup({ mode: 'onFocusChange' })
    setFiles([tab('a'), tab('b')], 'a')
    model.notifyEditorBlur('a')
    await flush()
    expect(files.saved).toEqual(['a'])
    files.state.tabs[1].draft = 'edited again'
    setFiles(files.state.tabs, 'a')
    setFiles(files.state.tabs, 'b')
    await flush()
    expect(files.saved).toEqual(['a'])
    setFiles(files.state.tabs, 'a')
    await flush()
    expect(files.saved).toEqual(['a', 'b'])
  })

  it('停止输入后：一直在打字就一直往后推，停下 delay 毫秒后存一次', async () => {
    vi.useFakeTimers()
    await setup({ mode: 'afterDelay', delay: 1000 })
    const t = tab('a')
    setFiles([t])
    await vi.advanceTimersByTimeAsync(600)
    t.draft = 'edited more'
    setFiles([t])
    await vi.advanceTimersByTimeAsync(600)
    expect(files.saved).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(files.saved).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(files.saved).toEqual(['a'])
  })

  it('AI 正在这个项目里跑：先不存，它停了再存', async () => {
    await setup({ mode: 'onWindowChange' })
    engine.sessions = [{ record: { id: 's1', projectId: 'p1', cwd: 'D:\\code\\app' }, state: 'running' }]
    setFiles([tab('a')])
    win.dispatchEvent(new Event('blur'))
    await flush()
    expect(files.saved).toEqual([])
    engine.listeners.forEach(l => l())
    await flush()
    expect(files.saved).toEqual([])
    engine.sessions = [{ ...engine.sessions[0], state: 'idle' }]
    engine.listeners.forEach(l => l())
    await flush()
    expect(files.saved).toEqual(['a'])
  })

  it('存失败了：内容没再改就不重试，改过再试', async () => {
    await setup({ mode: 'onWindowChange' })
    files.saveResult = false
    const t = tab('a')
    setFiles([t])
    win.dispatchEvent(new Event('blur'))
    await flush()
    win.dispatchEvent(new Event('blur'))
    await flush()
    expect(files.saved).toEqual(['a'])
    t.draft = 'fixed'
    files.saveResult = true
    setFiles([t])
    win.dispatchEvent(new Event('blur'))
    await flush()
    expect(files.saved).toEqual(['a', 'a'])
  })

  it('设置改成关闭：之前等着的不再存', async () => {
    const model = await setup({ mode: 'onWindowChange' })
    engine.sessions = [{ record: { id: 's1', projectId: 'p1', cwd: 'x' }, state: 'running' }]
    setFiles([tab('a')])
    win.dispatchEvent(new Event('blur'))
    await flush()
    model.setAutoSave({ mode: 'off' })
    engine.sessions = []
    engine.listeners.forEach(l => l())
    await flush()
    expect(files.saved).toEqual([])
  })
})
