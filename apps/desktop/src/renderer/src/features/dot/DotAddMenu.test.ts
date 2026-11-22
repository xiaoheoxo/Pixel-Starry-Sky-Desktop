import { describe, expect, it } from 'vitest'
import { chatGptReference } from './DotAddMenu'

describe('Dot composer references', () => {
  it('accepts real ChatGPT resource URLs without using an unrelated origin', () => {
    expect(chatGptReference(' https://chatgpt.com/c/example ')).toBe('https://chatgpt.com/c/example')
    expect(chatGptReference('https://chatgpt.com/library?file_id=example')).toBe(
      'https://chatgpt.com/library?file_id=example',
    )
    for (const url of [
      'https://chatgpt.com.evil.test/c/example',
      'https://user:secret@chatgpt.com/c/example',
      'javascript:alert(0)',
      'http://chatgpt.com/c/example',
    ])
      expect(chatGptReference(url)).toBeNull()
  })
})
