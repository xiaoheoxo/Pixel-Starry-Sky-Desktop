import { describe, expect, it } from 'vitest'
import { AVATAR_COLORS, AVATAR_ICONS, cleanAvatar, defaultAvatar, pixelCells } from './avatar'

describe('cleanAvatar', () => {
  it('合法的原样留下', () => {
    const a = { style: 'pixel', color: 'blue', text: '前端', icon: 'code', emoji: '🦊', seed: 3 }
    expect(cleanAvatar(a)).toEqual(a)
  })

  it('style、color 不对或不是对象返回 null', () => {
    expect(cleanAvatar({ style: 'photo', color: 'blue' })).toBeNull()
    expect(cleanAvatar({ style: 'icon', color: '#fff' })).toBeNull()
    expect(cleanAvatar({ color: 'blue' })).toBeNull()
    expect(cleanAvatar(null)).toBeNull()
    expect(cleanAvatar('icon')).toBeNull()
  })

  it('文字去空白、按码点截到 2 个；空的丢掉', () => {
    expect(cleanAvatar({ style: 'letter', color: 'gray', text: '  🦊前端  ' })?.text).toBe('🦊前')
    expect(cleanAvatar({ style: 'letter', color: 'gray', text: '   ' })).toEqual({ style: 'letter', color: 'gray' })
    expect(cleanAvatar({ style: 'letter', color: 'gray', text: 5 })).toEqual({ style: 'letter', color: 'gray' })
  })

  it('清单外的图标、表情和越界的 seed 丢掉', () => {
    const base = { style: 'icon', color: 'teal' }
    expect(cleanAvatar({ ...base, icon: 'skull', emoji: '💀', seed: 7 })).toEqual(base)
    expect(cleanAvatar({ ...base, seed: 0 })).toEqual(base)
    expect(cleanAvatar({ ...base, seed: 2.5 })).toEqual(base)
    expect(cleanAvatar({ ...base, seed: 6 })?.seed).toBe(6)
  })
})

describe('defaultAvatar', () => {
  it('同名同结果，取自清单', () => {
    const a = defaultAvatar('前端助手')
    expect(defaultAvatar('前端助手')).toEqual(a)
    expect(a.style).toBe('icon')
    expect(AVATAR_COLORS).toContain(a.color)
    expect(AVATAR_ICONS).toContain(a.icon)
    expect(cleanAvatar(a)).toEqual(a)
  })
})

describe('pixelCells', () => {
  it('稳定、对称、不全空', () => {
    for (const name of ['', '审查员', 'reviewer'])
      for (let seed = 1; seed <= 6; seed++) {
        const cells = pixelCells(name, seed)
        expect(pixelCells(name, seed)).toEqual(cells)
        expect(cells).toHaveLength(25)
        expect(cells).toContain(true)
        for (let y = 0; y < 5; y++) for (let x = 0; x < 2; x++) expect(cells[y * 5 + x]).toBe(cells[y * 5 + 4 - x])
      }
    expect(pixelCells('审查员', 1)).not.toEqual(pixelCells('审查员', 2))
  })
})
