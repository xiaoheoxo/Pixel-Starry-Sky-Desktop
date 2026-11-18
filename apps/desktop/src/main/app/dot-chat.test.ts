import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  constructor: vi.fn(),
  fromWebContents: vi.fn(),
  showOpenDialog: vi.fn(),
  snapshot: vi.fn((key: string) => ({ record: { id: `session-${key}` } })),
  send: vi.fn(),
  release: vi.fn(),
  notify: vi.fn(),
  read: vi.fn(),
}))
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(mocks.constructor, { fromWebContents: mocks.fromWebContents }),
  dialog: { showOpenDialog: mocks.showOpenDialog },
}))
vi.mock('./data-dir', () => ({ dataRoot: () => 'isolated-data' }))
vi.mock('./rendererHealth', () => ({ sendWhenReady: mocks.notify }))
vi.mock('../ipc/guard', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, fn),
}))
vi.mock('./dot-chat-sessions', () => ({
  DotChatSessions: class {
    entry(key: string) {
      if (!['a'.repeat(32), 'b'.repeat(32)].includes(key)) throw new Error('Saved Dot unavailable')
      return { key }
    }
    snapshot = mocks.snapshot
    send = mocks.send
    read = mocks.read
    release = mocks.release
    catalog = async () => ({ entries: [{ key: 'a'.repeat(32) }], errors: [] })
  },
}))
const { initDotChat } = await import('./dot-chat')
const first = 'a'.repeat(32),
  second = 'b'.repeat(32)
const main = { webContents: {} }
beforeEach(() => {
  mocks.handlers.clear()
  vi.clearAllMocks()
})
describe('Dot in the main conversation view', () => {
  it('opens existing session tabs in the main window without constructing a Dot window', async () => {
    const showMain = vi.fn(() => main)
    initDotChat({ engine: {} } as never, showMain as never)
    await mocks.handlers.get('dotChat:open')!({}, first)
    await mocks.handlers.get('dotChat:open')!({}, second)
    expect(mocks.constructor).not.toHaveBeenCalled()
    expect(mocks.notify).toHaveBeenNthCalledWith(1, main.webContents, 'mainWindow:action', {
      kind: 'openSession',
      sessionId: `session-${first}`,
    })
    expect(mocks.notify).toHaveBeenNthCalledWith(2, main.webContents, 'mainWindow:action', {
      kind: 'openSession',
      sessionId: `session-${second}`,
    })
    await expect(mocks.handlers.get('dotChat:open')!({}, '../other')).rejects.toThrow('Invalid')
  })
  it('pins reads and sends to their explicit Dot while switching tabs in one window', () => {
    initDotChat({ engine: {} } as never, () => main as never)
    const sender = { once: vi.fn<(event: string, listener: () => void) => void>() }
    mocks.handlers.get('dotChat:snapshot')!({ sender }, first)
    const files = [{ name: 'image.png', path: '/staged/file-image.png' }]
    mocks.handlers.get('dotChat:send')!({ sender }, second, 'session', 'hello', files)
    mocks.handlers.get('dotChat:read')!({ sender }, first, { overview: true })
    expect(mocks.snapshot).toHaveBeenCalledWith(first)
    expect(mocks.send).toHaveBeenCalledWith(second, 'session', 'hello', files)
    expect(mocks.read).toHaveBeenCalledWith(first, { before: undefined, overview: true }, expect.any(AbortSignal))
    expect(() => mocks.handlers.get('dotChat:snapshot')!({ sender }, 'c'.repeat(32))).toThrow('unavailable')
    sender.once.mock.calls[0][1]()
    expect(mocks.release).toHaveBeenCalledWith(first)
    expect(mocks.release).toHaveBeenCalledWith(second)
  })
  it('returns paths from the native picker and leaves sending to the composer', async () => {
    initDotChat({ engine: {} } as never, () => main as never)
    const sender = { once: vi.fn() }
    const win = { isDestroyed: () => false }
    const filePaths = ['D:\\Project\\plan.txt', 'D:\\Project\\photo.png']
    mocks.fromWebContents.mockReturnValue(win)
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths })
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const pick = mocks.handlers.get('dotChat:pickFiles')!
    await expect(pick({ sender }, first)).resolves.toEqual(filePaths)
    await expect(pick({ sender }, first)).resolves.toEqual([])
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
