import { describe, expect, it } from 'vitest'
import { EXTSTORE_ERROR_CODES } from '@pixelsky/protocol'
import { allMessages } from './translate'

describe('extstore error messages', () => {
  it('has zh and en text for every extstore error code and extpacks.blocked', () => {
    for (const code of [...EXTSTORE_ERROR_CODES, 'extpacks.blocked']) {
      const entry = (allMessages as Record<string, { zh: string; en: string }>)[`errors.${code}`]
      expect(entry, code).toBeDefined()
      expect(entry.zh.length, code).toBeGreaterThan(0)
      expect(entry.en.length, code).toBeGreaterThan(0)
    }
  })
})
