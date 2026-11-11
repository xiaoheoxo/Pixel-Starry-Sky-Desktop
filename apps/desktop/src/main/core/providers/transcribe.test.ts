import { describe, expect, it } from 'vitest'
import type { ResolvedProvider } from './store'
import { parseTranscribeRequest, transcribeAudio } from './transcribe'

const provider = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({
  id: 'p1',
  name: '我的接口',
  template: 'openai',
  protocol: 'responses',
  baseUrl: 'https://api.example.test/v1',
  auth: 'bearer',
  models: [],
  smallModel: null,
  modelFallback: true,
  headerNames: [],
  createdAt: 0,
  updatedAt: 0,
  apiKey: 'sk-secret-1234',
  headers: {},
  ...over,
})
const req = { model: 'whisper-1', mime: 'audio/webm', audio: new Uint8Array([1, 2, 3]), language: 'zh' }
const reply = (status: number, body: string) => async () => new Response(body, { status })

describe('语音转写', () => {
  it('参数：去掉 mime 的参数、认 ArrayBuffer、语言只认两个字母；坏的拒绝', () => {
    const ok = parseTranscribeRequest({
      model: ' whisper-1 ',
      mime: 'audio/webm;codecs=opus',
      audio: new Uint8Array([1]).buffer,
      language: 'auto',
    })
    expect(ok).toEqual({ model: 'whisper-1', mime: 'audio/webm', audio: new Uint8Array([1]), language: null })
    expect(() => parseTranscribeRequest({ model: '', mime: 'audio/webm', audio: new Uint8Array([1]) })).toThrow('模型')
    expect(() => parseTranscribeRequest({ model: 'm', mime: 'text/html', audio: new Uint8Array([1]) })).toThrow('格式')
    expect(() => parseTranscribeRequest({ model: 'm', mime: 'audio/webm', audio: new Uint8Array(0) })).toThrow('声音')
    expect(() => parseTranscribeRequest({ model: 'm', mime: 'audio/webm', audio: 'abc' })).toThrow('声音')
  })

  it('发到 <接口地址>/audio/transcriptions，带 Key、文件、模型、语言；返回 text', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const text = await transcribeAudio(provider(), req, async (url, init) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ text: ' 你好 ' }), { status: 200 })
    })
    expect(text).toBe('你好')
    const { url, init } = seen[0]
    expect(url).toBe('https://api.example.test/v1/audio/transcriptions')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret-1234')
    expect(Object.keys(init.headers as object).map(k => k.toLowerCase())).not.toContain('content-type')
    expect(init.redirect).toBe('error')
    const form = init.body as FormData
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('language')).toBe('zh')
    expect((form.get('file') as File).name).toBe('speech.webm')
  })

  it('纯文本回复也认；JSON 里没有 text 报格式不对', async () => {
    expect(await transcribeAudio(provider(), req, reply(200, '你好\n'))).toBe('你好')
    await expect(transcribeAudio(provider(), req, reply(200, '{"ok":true}'))).rejects.toThrow('格式不对')
  })

  it('Anthropic 协议不发请求；404 说没有转写接口；报错里不带 Key', async () => {
    let called = false
    await expect(
      transcribeAudio(provider({ protocol: 'anthropic' }), req, async () => {
        called = true
        return new Response('')
      }),
    ).rejects.toThrow('Anthropic')
    expect(called).toBe(false)
    await expect(transcribeAudio(provider(), req, reply(404, 'Not Found'))).rejects.toThrow('没有语音转写')
    const err = await transcribeAudio(
      provider(),
      req,
      reply(401, '{"error":{"message":"bad key sk-secret-1234"}}'),
    ).catch((e: Error) => e.message)
    expect(err).toContain('拒绝了这个 Key')
    expect(err).not.toContain('sk-secret-1234')
  })
})
