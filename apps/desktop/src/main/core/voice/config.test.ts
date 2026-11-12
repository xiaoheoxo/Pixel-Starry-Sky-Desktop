import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VoiceConfig } from './config'

const cipher = { available: () => true, encrypt: (s: string) => s, decrypt: (s: string) => s }
let dir = ''
const fresh = (): VoiceConfig => {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'voice-'))
  return new VoiceConfig(join(dir, 'voice.json'), cipher)
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('语音输入的地址和 Key', () => {
  it('没设置时是空的；存了以后重开还在，Key 只露末 4 位', () => {
    expect(fresh().view()).toEqual({ baseUrl: '', mode: 'file', keyHint: null, persistent: true })
    const view = fresh().save({ baseUrl: 'https://api.example.test/v1/', mode: 'chat', apiKey: ' sk-abcd1234 ' })
    expect(view).toEqual({ baseUrl: 'https://api.example.test/v1', mode: 'chat', keyHint: '1234', persistent: true })
    expect(fresh().endpoint()).toEqual({ baseUrl: 'https://api.example.test/v1', apiKey: 'sk-abcd1234', mode: 'chat' })
  })

  it('不填 Key 沿用旧的；换了站点就清掉；地址清空等于删掉', () => {
    const c = fresh()
    c.save({ baseUrl: 'https://a.example.test/v1', mode: 'file', apiKey: 'sk-abcd1234' })
    expect(c.save({ baseUrl: 'https://a.example.test/v2', mode: 'chat' }).keyHint).toBe('1234')
    expect(c.save({ baseUrl: 'https://b.example.test/v1', mode: 'chat' }).keyHint).toBeNull()
    expect(c.save({ baseUrl: ' ', mode: 'chat' }).baseUrl).toBe('')
    expect(c.endpoint()).toBeNull()
  })

  it('坏地址拒绝，原来的不动', () => {
    const c = fresh()
    c.save({ baseUrl: 'https://a.example.test/v1', mode: 'file', apiKey: 'k-12345' })
    expect(() => c.save({ baseUrl: 'http://evil.example.com/v1', mode: 'file' })).toThrow('https')
    expect(c.endpoint()?.baseUrl).toBe('https://a.example.test/v1')
  })
})
