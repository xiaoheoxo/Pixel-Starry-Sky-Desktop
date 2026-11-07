import { expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  seen: null as Record<string, unknown> | null,
  throwOnView: true,
  hosts: [] as { destroyed: boolean }[],
  app: null as unknown as import('node:events').EventEmitter,
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  fake.app = new EventEmitter()
  return {
    app: fake.app,
    BaseWindow: class {
      destroyed = false
      contentView = { addChildView() {} }
      constructor() {
        fake.hosts.push(this)
      }
      isDestroyed = () => this.destroyed
      destroy() {
        if (this.destroyed) throw new Error('Object has been destroyed')
        this.destroyed = true
      }
    },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        on() {},
        webRequest: { onCompleted() {}, onErrorOccurred() {} },
        clearStorageData: async () => {},
      }),
    },
    WebContentsView: class {
      webContents: Record<string, unknown>
      constructor(options: { webPreferences: Record<string, unknown> }) {
        fake.seen = options.webPreferences
        if (fake.throwOnView) throw new Error('stop here')
        let destroyed = false
        let fail: (error: unknown) => void = () => {}
        this.webContents = {
          id: 1,
          setAudioMuted() {},
          setWindowOpenHandler() {},
          on() {},
          // 一直加载不完，直到页面被关掉
          loadURL: () => new Promise((_resolve, reject) => (fail = reject)),
          isDestroyed: () => destroyed,
          close() {
            destroyed = true
            fail({ errno: -3, code: 'ERR_ABORTED' })
          },
          capturePage() {
            throw new Error('Object has been destroyed')
          },
        }
      }
      setBounds() {}
    },
  }
})

it('后台页面不弹对话框（alert 没人点会卡到超时），也拿不到系统能力', async () => {
  const { probePage } = await import('./page-check')
  const result = await probePage('http://localhost:5173/')
  expect(fake.seen).toMatchObject({ disableDialogs: true, sandbox: true, nodeIntegration: false })
  // 打开失败也只是一条结果，不影响前面命令检查的结果
  expect(result).toMatchObject({ status: 'fail', reason: 'error', detail: 'stop here' })
})

it('退出时马上关掉正在检查的隐藏窗口，不等检查跑完', async () => {
  fake.throwOnView = false
  const { probePage } = await import('./page-check')
  const job = probePage('http://localhost:5173/')
  await vi.waitFor(() => expect(fake.hosts).toHaveLength(1))
  fake.app.emit('before-quit')
  expect(fake.hosts[0]!.destroyed).toBe(true)
  // 关掉之后 finally 不再重复销毁，检查照常结束成一条结果
  expect(await job).toMatchObject({ kind: 'page', status: 'fail' })
  expect(fake.app.listenerCount('before-quit')).toBe(0)
})
