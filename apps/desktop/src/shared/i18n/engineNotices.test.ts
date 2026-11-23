import { describe, expect, it } from 'vitest'
import { AUTOCOMPACT_THRASHING, THINKING_SIGNATURE } from '@pixelsky/engine'
import { translateMessage } from './translate'

describe('Claude Code 报错说人话的几句', () => {
  it('引擎发的原文能翻译：中文界面原样，英文界面是英文', () => {
    for (const text of [THINKING_SIGNATURE, AUTOCOMPACT_THRASHING]) {
      expect(translateMessage(text, 'zh-CN')).toBe(text)
      expect(translateMessage(text, 'en-US')).toMatch(/^[\x20-\x7e’]+$/)
    }
  })
})
