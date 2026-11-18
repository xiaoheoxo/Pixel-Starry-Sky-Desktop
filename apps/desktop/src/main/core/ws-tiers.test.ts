import { describe, expect, it } from 'vitest'
import { RECOVER_MS, TierCursor, type WsTarget } from './ws-tiers'

const tiers: WsTarget[] = [
  { tier: 'cdn', url: 'wss://cdn.example/ws' },
  { tier: 'direct', url: 'wss://direct.example/ws' },
  { tier: 'ip', url: 'wss://direct.example/ws', ip: '192.0.2.1' },
]

describe('TierCursor', () => {
  it('一轮从连上的那档开始，试到头从第一档补上；一轮全失败后回到第一档', () => {
    const c = new TierCursor(() => tiers)
    expect(c.current()?.tier).toBe('cdn')
    expect(c.fail()?.tier).toBe('direct')
    c.connected()
    expect(c.current()?.tier).toBe('direct')
    expect(c.better().map(b => b.target.tier)).toEqual(['cdn'])
    expect(c.fail()?.tier).toBe('ip')
    expect(c.fail()?.tier).toBe('cdn')
    expect(c.fail()).toBeNull()
    expect(c.current()?.tier).toBe('cdn')
  })

  it('切回去又没连上：恢复检查的间隔翻倍（最多 16 倍）；切回去连上了就恢复成 5 分钟', () => {
    const c = new TierCursor(() => tiers)
    c.current()
    c.fail()
    c.connected() // 连在直连
    expect(c.recoverEvery()).toBe(RECOVER_MS)
    for (let i = 1; i <= 6; i++) {
      c.promote(0)
      c.current()
      expect(c.fail()?.tier).toBe('direct') // CDN 检查时 101，真连时又 426
      c.connected()
      expect(c.recoverEvery()).toBe(RECOVER_MS * 2 ** Math.min(i, 4))
    }
    c.promote(0)
    c.current()
    c.connected() // 这次真连上了 CDN
    expect(c.recoverEvery()).toBe(RECOVER_MS)
  })
})
