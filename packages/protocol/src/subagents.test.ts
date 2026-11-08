import { describe, expect, it } from 'vitest'
import { parseSubagentOverrides, subagentEffort } from './subagents'

describe('subagent overrides', () => {
  it('distinguishes inherited type settings from following the main session', () => {
    expect(
      parseSubagentOverrides([
        { type: 'explore', effort: 'high' },
        { type: 'general', model: null, effort: null },
      ]),
    ).toEqual([
      { type: 'explore', effort: 'high' },
      { type: 'general', model: null, effort: null },
    ])
    expect(parseSubagentOverrides([{ type: 'explore', model: undefined, effort: undefined }])).toEqual([])
  })
  it('ignores invalid ids, models, efforts and duplicate entries', () => {
    expect(
      parseSubagentOverrides([
        {},
        { type: 'bad/id', effort: 'high' },
        { type: 'ok', effort: 'ultra' },
        { type: 'ok', model: 'a b' },
        { type: 'ok', model: 'a\u0000b' },
        { type: 'ok', model: 'provider/model' },
        { type: 'ok', effort: 'low' },
      ]),
    ).toEqual([{ type: 'ok', model: 'provider/model' }])
    expect(subagentEffort('max')).toBe('max')
    expect(subagentEffort('ultra')).toBeNull()
  })
})
