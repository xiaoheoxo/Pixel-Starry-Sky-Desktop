import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE, encodeWav, insertSpoken, parseVoiceSettings, voiceClock } from './model'

describe('语音输入', () => {
  it('设置：坏的值回到默认，模型去空白；旧版存的 providerId 丢掉', () => {
    expect(parseVoiceSettings(null)).toEqual(DEFAULT_VOICE)
    expect(parseVoiceSettings({ model: '  ', language: 'fr' })).toEqual(DEFAULT_VOICE)
    expect(parseVoiceSettings({ providerId: 'p_1', model: ' gpt-4o-transcribe ', language: 'zh' })).toEqual({
      model: 'gpt-4o-transcribe',
      language: 'zh',
    })
  })

  it('wav：44 字节文件头加 16 位采样，超出范围的削平', () => {
    const view = new DataView(encodeWav(new Float32Array([0, 1, -2]), 16000))
    expect(view.byteLength).toBe(50)
    expect(String.fromCharCode(...new Uint8Array(view.buffer, 0, 4))).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(42)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(40, true)).toBe(6)
    expect([44, 46, 48].map(at => view.getInt16(at, true))).toEqual([0, 32767, -32767])
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
