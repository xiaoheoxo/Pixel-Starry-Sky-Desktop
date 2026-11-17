// 字号挡位：80%–150% 每 10% 一档，存下的值重启后照样认（docs/ui/settings.md §7）
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadWith(saved: unknown) {
  const props = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'pixelsky.fonts' ? JSON.stringify(saved) : null),
    setItem: () => {},
  })
  vi.stubGlobal('document', {
    documentElement: {
      dataset: {},
      style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
    },
  })
  vi.resetModules()
  const fonts = await import('./fonts')
  return { fonts, props }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('字号挡位', () => {
  it('80%–150% 共 8 档', async () => {
    const { fonts } = await loadWith({})
    expect([...fonts.FONT_SCALES]).toEqual([0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5])
  })

  it('新加的挡位存下后重启照样读出并生效', async () => {
    for (const scale of [0.8, 1.4, 1.5]) {
      const { fonts, props } = await loadWith({ scale })
      expect(fonts.getFontPrefs().scale).toBe(scale)
      expect(props.get('--font-scale')).toBe(String(scale))
    }
  })

  it('不在挡位里的值退回 100%', async () => {
    for (const scale of [0.7, 1.6, 1.25, '1.2', null]) {
      const { fonts } = await loadWith({ scale })
      expect(fonts.getFontPrefs().scale).toBe(1)
    }
  })
})
