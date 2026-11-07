import { expect, it, vi } from 'vitest'

const prefs = vi.hoisted(() => ({ seen: null as Record<string, unknown> | null }))
vi.mock('electron', () => ({
  BaseWindow: class {},
  session: {
    fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} }),
  },
  WebContentsView: class {
    constructor(options: { webPreferences: Record<string, unknown> }) {
      prefs.seen = options.webPreferences
      throw new Error('stop here')
    }
  },
}))

it('后台页面不弹对话框（alert 没人点会卡到超时），也拿不到系统能力', async () => {
  const { probePage } = await import('./page-check')
  const result = await probePage('http://localhost:5173/')
  expect(prefs.seen).toMatchObject({ disableDialogs: true, sandbox: true, nodeIntegration: false })
  // 打开失败也只是一条结果，不影响前面命令检查的结果
  expect(result).toMatchObject({ status: 'fail', reason: 'error', detail: 'stop here' })
})
