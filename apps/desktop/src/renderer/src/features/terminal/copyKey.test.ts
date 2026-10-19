import { describe, expect, it } from 'vitest'
import { isCopyKey } from './copyKey'

const key = (mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}, code = 'KeyC') => ({
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
})

describe('isCopyKey', () => {
  it('Ctrl+Shift+C 不管有没有选中都是复制', () => {
    expect(isCopyKey(key({ ctrl: true, shift: true }), false, false)).toBe(true)
    expect(isCopyKey(key({ ctrl: true, shift: true }), true, false)).toBe(true)
    expect(isCopyKey(key({ meta: true, shift: true }), false, true)).toBe(true)
  })

  it('Windows / Linux：有选中时 Ctrl+C 复制，没选中时交给 Shell', () => {
    expect(isCopyKey(key({ ctrl: true }), true, false)).toBe(true)
    expect(isCopyKey(key({ ctrl: true }), false, false)).toBe(false)
  })

  it('macOS 的 Ctrl+C 永远是中断', () => {
    expect(isCopyKey(key({ ctrl: true }), true, true)).toBe(false)
  })

  it('别的组合不算', () => {
    expect(isCopyKey(key({ ctrl: true, alt: true }), true, false)).toBe(false)
    expect(isCopyKey(key({ ctrl: true, alt: true, shift: true }), true, false)).toBe(false)
    expect(isCopyKey(key({}), true, false)).toBe(false)
    expect(isCopyKey(key({ ctrl: true }, 'KeyV'), true, false)).toBe(false)
  })
})
