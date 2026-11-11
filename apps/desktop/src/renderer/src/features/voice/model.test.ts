import { describe, expect, it } from 'vitest'
import type { ProviderView } from '../../../../shared/types/providers'
import { DEFAULT_VOICE, insertSpoken, parseVoiceSettings, voiceClock, voiceTarget } from './model'

const provider = (id: string, protocol: ProviderView['protocol']): ProviderView => ({
  id,
  name: id,
  template: 'custom',
  protocol,
  baseUrl: 'https://example.test/v1',
  auth: 'bearer',
  models: [],
  smallModel: null,
  modelFallback: true,
  keyHint: null,
  headerNames: [],
  insecure: false,
  createdAt: 0,
  updatedAt: 0,
})

describe('语音输入', () => {
  it('设置：坏的值回到默认，模型去空白', () => {
    expect(parseVoiceSettings(null)).toEqual(DEFAULT_VOICE)
    expect(parseVoiceSettings({ providerId: '../x', model: '  ', language: 'fr' })).toEqual(DEFAULT_VOICE)
    expect(parseVoiceSettings({ providerId: 'p_1', model: ' gpt-4o-transcribe ', language: 'zh' })).toEqual({
      providerId: 'p_1',
      model: 'gpt-4o-transcribe',
      language: 'zh',
    })
  })

  it('用哪个接口：选过且还在用它；没选、删了、选的是 Anthropic 协议就用第一个能转写的；没有为 null', () => {
    const list = [provider('a', 'anthropic'), provider('b', 'chat'), provider('c', 'responses')]
    expect(voiceTarget(list, { ...DEFAULT_VOICE, providerId: 'c' })?.id).toBe('c')
    expect(voiceTarget(list, DEFAULT_VOICE)?.id).toBe('b')
    expect(voiceTarget(list, { ...DEFAULT_VOICE, providerId: 'gone' })?.id).toBe('b')
    expect(voiceTarget(list, { ...DEFAULT_VOICE, providerId: 'a' })?.id).toBe('b')
    expect(voiceTarget([provider('a', 'anthropic')], DEFAULT_VOICE)).toBeNull()
  })

  it('插入：放到光标处或换掉选中的，英文接英文补空格，中文不补', () => {
    expect(insertSpoken('', 0, 0, '你好')).toEqual({ text: '你好', caret: 2 })
    expect(insertSpoken('修一下bug', 3, 3, '这个')).toEqual({ text: '修一下这个bug', caret: 5 })
    expect(insertSpoken('fix', 3, 3, 'the bug')).toEqual({ text: 'fix the bug', caret: 11 })
    expect(insertSpoken('fix ', 4, 4, 'it')).toEqual({ text: 'fix it', caret: 6 })
    expect(insertSpoken('abcdef', 1, 5, 'X')).toEqual({ text: 'a Xf', caret: 3 })
  })

  it('时长', () => {
    expect(voiceClock(7)).toBe('0:07')
    expect(voiceClock(125)).toBe('2:05')
  })
})
