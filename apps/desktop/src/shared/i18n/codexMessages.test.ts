import { describe, expect, it } from 'vitest'
import { AUTO_REVIEW_TEXT } from '@pixelsky/protocol'
import { translateMessage } from './translate'

describe('自动审核的提示', () => {
  it('引擎发的原文能翻译：中文界面原样，英文界面是英文', () => {
    for (const text of Object.values(AUTO_REVIEW_TEXT)) {
      expect(translateMessage(text, 'zh-CN')).toBe(text)
      expect(translateMessage(text, 'en-US')).toMatch(/^[\x20-\x7e]+$/)
    }
  })
})
