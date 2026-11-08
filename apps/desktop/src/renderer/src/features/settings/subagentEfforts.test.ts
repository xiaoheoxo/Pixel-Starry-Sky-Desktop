import { describe, expect, it } from 'vitest'
import type { EngineCatalog } from '@pixelsky/protocol'
import { subagentModelEfforts } from './subagentEfforts'

describe('subagentModelEfforts', () => {
  it('distinguishes an unknown model from one without reasoning, using model capabilities', () => {
    const catalog = {
      models: [
        { id: 'provider/plain', efforts: [] },
        { id: 'provider/reasoner', efforts: ['low', 'high', 'xhigh'] },
      ],
    } as EngineCatalog
    expect(subagentModelEfforts(null, 'plain')).toBeNull()
    expect(subagentModelEfforts(catalog, 'missing')).toBeNull()
    expect(subagentModelEfforts(catalog, 'plain')).toEqual([])
    expect(subagentModelEfforts(catalog, 'reasoner')).toEqual(['low', 'high', 'xhigh'])
  })

  it('does not borrow Pixel capabilities for an external model with the same ID', () => {
    const catalog = { models: [{ id: 'provider/reasoner', efforts: ['low'] }] } as EngineCatalog
    expect(subagentModelEfforts(catalog, 'reasoner', false)).toBeNull()
  })
})
