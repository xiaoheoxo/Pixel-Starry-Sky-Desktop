import { beforeEach, describe, expect, it, vi } from 'vitest'

// 事件广播：发给所有「软件自己的」窗口，不发给付款窗口（里面是第三方收银台网页）。

const mocks = vi.hoisted(() => ({
  windows: [] as Array<{ id: string; destroyed: boolean; webContents: { id: string } }>,
  sent: [] as Array<{ to: string; channel: string; args: unknown[] }>,
  pay: new Set<unknown>(),
}))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mocks.windows.map(w => ({ ...w, isDestroyed: () => w.destroyed, self: w })) },
}))
vi.mock('./rendererHealth', () => ({
  sendTo: (wc: { id: string }, channel: string, ...args: unknown[]) => {
    mocks.sent.push({ to: wc.id, channel, args })
    return true
  },
}))
vi.mock('./payWindowRegistry', () => ({
  isPayWindow: (win: { self: unknown }) => mocks.pay.has(win.self),
}))

const { EventBus } = await import('./events')

const win = (id: string, destroyed = false) => ({ id, destroyed, webContents: { id } })

beforeEach(() => {
  mocks.windows = []
  mocks.sent = []
  mocks.pay = new Set()
})

describe('EventBus.broadcast', () => {
  it('发给每个没销毁的窗口，跳过付款窗口；tap 照常收到', () => {
    const main = win('main')
    const second = win('second')
    const pay = win('pay')
    mocks.windows = [main, pay, second, win('gone', true)]
    mocks.pay.add(pay)
    const bus = new EventBus()
    const tapped: unknown[][] = []
    bus.taps.add((channel, args) => tapped.push([channel, args]))
    bus.broadcast('session:event' as never, { n: 1 })
    expect(mocks.sent.map(s => s.to)).toEqual(['main', 'second'])
    expect(mocks.sent[0]).toMatchObject({ channel: 'session:event', args: [{ n: 1 }] })
    expect(tapped).toEqual([['session:event', [{ n: 1 }]]])
  })
})
