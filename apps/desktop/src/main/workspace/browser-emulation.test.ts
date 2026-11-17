import { describe, expect, it } from 'vitest'
import { _specKey, idleSpec, mobileUserAgent } from './browser-emulation'

describe('设备模拟（docs/ui/browser-v2.md §10）', () => {
  it('手机、平板用 Android Chrome 标识（只写主版本号），桌面不改', () => {
    expect(mobileUserAgent('phone', '140.0.7339.5')).toContain('Chrome/140.0.0.0 Mobile Safari')
    expect(mobileUserAgent('tablet', '140.0.7339.5')).not.toContain('Mobile')
    expect(mobileUserAgent('desktop', '140.0.7339.5')).toBeNull()
  })
  it('自适应 + 跟随系统时不用连调试器', () => {
    expect(idleSpec({ size: null, scale: 1, theme: 'system', picking: false })).toBe(true)
    expect(idleSpec({ size: null, scale: 1, theme: 'dark', picking: false })).toBe(false)
  })
  it('比例的小数抖动不算变化（摆放时频繁调用，一样的不重复发）', () => {
    const size = { width: 390, height: 844, kind: 'phone' as const }
    const a = _specKey({ size, scale: 0.50001, theme: 'system', picking: false })
    expect(_specKey({ size, scale: 0.5, theme: 'system', picking: false })).toBe(a)
    expect(_specKey({ size, scale: 0.5, theme: 'system', picking: true })).not.toBe(a)
  })
})
