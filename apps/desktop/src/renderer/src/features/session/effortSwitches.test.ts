import { describe, expect, it, vi } from 'vitest'
import { effortSwitches, type EffortSwitchSource } from './effortSwitches'

const source = (patch: Partial<EffortSwitchSource>): EffortSwitchSource => ({
  effortEngine: 'codex',
  ultracode: false,
  ultracodeSupported: false,
  ultracodeAvailable: null,
  setUltracode: vi.fn(),
  fast: false,
  fastSupported: true,
  fastAvailable: null,
  fastBlocked: null,
  fastHint: null,
  fastPending: false,
  setFast: vi.fn(),
  ultrafast: false,
  ultrafastAvailable: false,
  ultrafastCost: null,
  setUltrafast: vi.fn(),
  thinkingSupported: true,
  thinkingSummaries: false,
  setThinkingSummaries: vi.fn(),
  ...patch,
})
const ids = (patch: Partial<EffortSwitchSource>, check = true): string[] =>
  effortSwitches(source(patch), check ? { on: false, set: vi.fn() } : null).map(i => i.id)
const fast = (patch: Partial<EffortSwitchSource>) => effortSwitches(source(patch), null)[0]!

describe('推理强度菜单的图标条', () => {
  it('引擎有哪些就出哪些格', () => {
    expect(ids({ ultracodeSupported: true })).toEqual(['ultracode', 'fast', 'thinking', 'check'])
    expect(ids({})).toEqual(['fast', 'thinking', 'check'])
    expect(ids({ fastSupported: false, thinkingSupported: false })).toEqual(['check'])
    expect(ids({ fastSupported: false, thinkingSupported: false }, false)).toEqual([])
  })

  it('开不了的写原因、不说更耗额度；已经开着的还能关', () => {
    const off = fast({ fastAvailable: false, fastBlocked: '免费账号不能使用' })
    expect(off).toMatchObject({ blocked: true, help: { text: '暂时不可用：免费账号不能使用' } })
    expect(off.help.tag).toBeUndefined()
    expect(fast({ fastAvailable: false, fast: true }).blocked).toBe(false)
    const [ultra] = effortSwitches(source({ ultracodeSupported: true, ultracodeAvailable: false }), null)
    expect(ultra).toMatchObject({ blocked: true, help: { text: '当前模型不支持' } })
  })

  it('按住时写这个引擎自己的费用，不是都写订阅 8 倍', () => {
    const holding = (patch: Partial<EffortSwitchSource>): string =>
      fast({ ultrafastAvailable: true, ...patch }).hold!.holding.text
    expect(holding({})).toBe('继续按住开启：最快的速度。订阅额度按 8 倍扣，credits 按 6 倍')
    expect(holding({ ultrafastCost: 6 })).toBe('继续按住开启：最快的速度。按 6 倍扣平台额度')
    expect(holding({ effortEngine: 'pixel', fastHint: '上游回报：fast' })).toMatch(/^继续按住开启：请求更快的服务档位/)
    expect(fast({ ultrafastAvailable: true }).hold!.tooShort.text).toBe('要按满 0.6 秒才开启，这样不会误点')
  })

  it('占位的说明随状态换位，加起来总是那几条（菜单高度不变）', () => {
    const texts = (patch: Partial<EffortSwitchSource>): string[] => {
      const i = fast({ ultrafastAvailable: true, ...patch })
      return [i.help, ...i.spare].map(h => `${h.title}|${h.tag}`).filter(t => !t.endsWith('pending'))
    }
    const all = ['Fast 模式|cost', 'Ultrafast|cost']
    for (const patch of [{}, { fast: true }, { fast: true, ultrafast: true }, { fast: true, fastPending: true }])
      expect(texts(patch).sort()).toEqual(all)
  })

  it('Ultrafast 开着：橙色、换名字；按住的档位转成对应的设置', () => {
    const live = source({ ultrafastAvailable: true, fast: true, ultrafast: true })
    const [item] = effortSwitches(live, null)
    expect(item).toMatchObject({ short: 'Ultrafast', tone: 'warn', on: true, hold: { speed: 'ultrafast' } })
    item!.hold!.set('ultrafast')
    item!.hold!.set('off')
    expect(live.setUltrafast).toHaveBeenCalledOnce()
    expect(live.setFast).toHaveBeenCalledWith(false)
  })

  it('下一轮生效：标出来，说明换成什么时候生效', () => {
    expect(fast({ fast: true, fastPending: true })).toMatchObject({
      pending: true,
      help: { tag: 'pending', text: '这一轮按普通速度跑完，下一轮起打开' },
    })
    expect(fast({ ultrafastAvailable: true, fastPending: true }).help.text).toBe(
      '这一轮按原来的速度跑完，下一轮起改成 普通',
    )
  })
})
