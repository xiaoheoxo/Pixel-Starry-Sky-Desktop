import { describe, expect, it } from 'vitest'
import { sidebarOnResize } from './sidebarAuto'

const state = { open: true, autoClosed: false, panelOpen: true, fits: true }

describe('sidebarOnResize', () => {
  it('右侧面板开着又放不下时收起', () => {
    expect(sidebarOnResize({ ...state, fits: false })).toBe('close')
  })

  it('右侧面板关着时不收', () => {
    expect(sidebarOnResize({ ...state, panelOpen: false, fits: false })).toBeNull()
  })

  it('自动收起的，放得下了就展开', () => {
    expect(sidebarOnResize({ ...state, open: false, autoClosed: true })).toBe('open')
  })

  it('自动收起的，还放不下就继续收着', () => {
    expect(sidebarOnResize({ ...state, open: false, autoClosed: true, fits: false })).toBeNull()
  })

  it('用户自己收起的，放得下也不展开', () => {
    expect(sidebarOnResize({ ...state, open: false })).toBeNull()
  })
})
