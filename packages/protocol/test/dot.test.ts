import { describe, expect, it } from 'vitest'
import { supportsChatGptDot } from '../src/dot'
describe('Dot Pro eligibility', () => {
  it.each(['pro', 'prolite', 'promax', ' PRO '])('shows Dot for %s', plan =>
    expect(supportsChatGptDot(plan)).toBe(true),
  )
  it.each(['plus', 'free', 'team', 'enterprise', 'unknown', null, undefined])('hides Dot for %s', plan =>
    expect(supportsChatGptDot(plan)).toBe(false),
  )
})
