import { describe, expect, it } from 'vitest'
import { ECHO_MS, GAP_MS, SUSTAIN_MS, isActive, onOutput, type Activity } from './tuiActivity'

/** 从 0 开始每 step 毫秒来一段输出，直到 until */
function stream(until: number, step = 100, inputAt = -Infinity): Activity | undefined {
  let a: Activity | undefined
  for (let t = 0; t <= until; t += step) a = onOutput(a, t, inputAt)
  return a
}

describe('终端模式的会话在不在干活（docs/ui/tui-toggle.md §5.5）', () => {
  it('持续输出够久才算，停下超过间隔就不算', () => {
    expect(isActive(stream(SUSTAIN_MS - 100), SUSTAIN_MS - 100)).toBe(false)
    const a = stream(SUSTAIN_MS)
    expect(isActive(a, SUSTAIN_MS)).toBe(true)
    expect(isActive(a, SUSTAIN_MS + GAP_MS + 1)).toBe(false)
  })

  it('间隔太长的两段输出不连起来', () => {
    const a = onOutput(onOutput(undefined, 0), GAP_MS + 1)
    expect(a).toEqual({ start: GAP_MS + 1, last: GAP_MS + 1 })
  })

  it('按键后的回显不算', () => {
    const a = onOutput(undefined, 1000)
    expect(onOutput(a, 1000 + ECHO_MS - 1, 1000)).toBe(a)
    expect(onOutput(undefined, 100, 0)).toBeUndefined()
  })
})
