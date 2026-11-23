import { describe, expect, it, vi } from 'vitest'
import { dotQuickSettingsActions } from './DotQuickSettings'

describe('Dot Quick Settings', () => {
  it('exposes only opening ChatGPT web and refreshing status, and disables concurrent refresh', () => {
    const openWeb = vi.fn()
    const refresh = vi.fn()
    const actions = dotQuickSettingsActions(openWeb, refresh, false)
    expect(actions).toHaveLength(2)
    actions[0]?.run?.()
    actions[1]?.run?.()
    expect(openWeb).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(dotQuickSettingsActions(openWeb, refresh, true)[1]?.disabled).toBe(true)
  })
})
