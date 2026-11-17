import { describe, expect, it } from 'vitest'
import { browserShortcut } from './project-browser'

const k = (key: string, mods: Partial<{ mod: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key,
  mod: false,
  shift: false,
  alt: false,
  ...mods,
})

describe('浏览器快捷键', () => {
  it('Windows / Linux', () => {
    expect(browserShortcut(k('l', { mod: true }), false)).toBe('address')
    expect(browserShortcut(k('L', { mod: true }), false)).toBe('address')
    expect(browserShortcut(k('F6'), false)).toBe('address')
    expect(browserShortcut(k('r', { mod: true }), false)).toBe('reload')
    expect(browserShortcut(k('F5'), false)).toBe('reload')
    expect(browserShortcut(k('R', { mod: true, shift: true }), false)).toBe('hardReload')
    expect(browserShortcut(k('t', { mod: true }), false)).toBe('newPage')
    expect(browserShortcut(k('w', { mod: true }), false)).toBe('closePage')
    expect(browserShortcut(k('ArrowLeft', { alt: true }), false)).toBe('back')
    expect(browserShortcut(k('ArrowRight', { alt: true }), false)).toBe('forward')
  })
  it('macOS：⌘[ ⌘] 前进后退，⌥← 留给网页（按词移动）', () => {
    expect(browserShortcut(k('[', { mod: true }), true)).toBe('back')
    expect(browserShortcut(k(']', { mod: true }), true)).toBe('forward')
    expect(browserShortcut(k('ArrowLeft', { alt: true }), true)).toBeNull()
  })
  it('其余按键交给网页', () => {
    expect(browserShortcut(k('l'), false)).toBeNull()
    expect(browserShortcut(k('c', { mod: true }), false)).toBeNull()
    expect(browserShortcut(k('w', { mod: true, shift: true }), false)).toBeNull()
    expect(browserShortcut(k('ArrowLeft', { alt: true, mod: true }), false)).toBeNull()
    expect(browserShortcut(k('F5', { shift: true }), false)).toBeNull()
  })
})
