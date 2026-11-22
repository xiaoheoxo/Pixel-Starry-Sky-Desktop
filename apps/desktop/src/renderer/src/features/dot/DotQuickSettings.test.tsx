import { describe, expect, it, vi } from 'vitest'
import { dotQuickSettingsActions } from './DotQuickSettings'

describe('Dot Quick Settings', () => {
  it('routes the four account-level actions to ChatGPT instead of simulating local mutations', () => {
    const openWeb = vi.fn()
    const refresh = vi.fn()
    const actions = dotQuickSettingsActions(openWeb, refresh, false)
    for (const action of actions.slice(0, 4)) {
      expect(action.hint).toBeTruthy()
      action.run?.()
    }
    expect(openWeb).toHaveBeenCalledTimes(4)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('opens the official page separately from refreshing local status, and disables concurrent refresh', () => {
    const openWeb = vi.fn()
    const refresh = vi.fn()
    const actions = dotQuickSettingsActions(openWeb, refresh, false)
    actions.at(-2)?.run?.()
    actions.at(-1)?.run?.()
    expect(openWeb).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(dotQuickSettingsActions(openWeb, refresh, true).at(-1)?.disabled).toBe(true)
  })
})
