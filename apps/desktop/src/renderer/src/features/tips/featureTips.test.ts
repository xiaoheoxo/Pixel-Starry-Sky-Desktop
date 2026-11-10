import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Store = typeof import('./featureTips')
let data: Map<string, string>

async function load(): Promise<Store> {
  vi.resetModules()
  return import('./featureTips')
}

beforeEach(() => {
  data = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  })
  vi.stubGlobal('window', Object.assign(new EventTarget(), { pixelsky: { demo: false } }))
})

afterEach(() => vi.unstubAllGlobals())

describe('功能提示', () => {
  it('一次只弹一个；看过的重开软件也不再弹', async () => {
    const t = await load()
    expect(t.claimTip('fast')).toBe(true)
    expect(t.claimTip('queue')).toBe(false)
    // 同一个提示的第二个入口（两张流程草稿、分屏的两个队列）也不弹
    expect(t.claimTip('fast')).toBe(false)
    t.markTipSeen('fast')
    expect(t.claimTip('queue')).toBe(true)
    const again = await load()
    expect(again.claimTip('fast')).toBe(false)
  })

  it('没看完就卸载：让出位置，下次再弹', async () => {
    const t = await load()
    expect(t.claimTip('flow')).toBe(true)
    t.releaseTip('flow')
    expect(t.claimTip('subagent')).toBe(true)
    t.releaseTip('subagent')
    expect(t.claimTip('flow')).toBe(true)
  })

  it('总开关关掉不弹；全部重新显示清掉看过记录', async () => {
    const t = await load()
    t.markTipSeen('flow')
    t.setTipsOff(true)
    expect(t.claimTip('queue')).toBe(false)
    t.resetTips()
    expect(t.readTips()).toEqual({ seen: [], off: false })
    expect(t.claimTip('flow')).toBe(true)
  })

  it('演示模式不弹也不写；存的内容坏了按空的算', async () => {
    data.set('pixelsky.featureTips.v1', '{bad')
    const t = await load()
    expect(t.readTips()).toEqual({ seen: [], off: false })
    ;(window as unknown as { pixelsky: { demo: boolean } }).pixelsky.demo = true
    expect(t.claimTip('fast')).toBe(false)
    t.markTipSeen('fast')
    expect(data.get('pixelsky.featureTips.v1')).toBe('{bad')
  })
})
