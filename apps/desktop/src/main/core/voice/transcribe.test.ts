import { describe, expect, it } from 'vitest'
import type { VoiceEndpoint } from './config'
import { parseTranscribeRequest, transcribeAudio } from './transcribe'

const endpoint = (over: Partial<VoiceEndpoint> = {}): VoiceEndpoint => ({
  baseUrl: 'https://api.example.test/v1',
  apiKey: 'sk-secret-1234',
  mode: 'file',
  ...over,
})
const req = { model: 'whisper-1', mime: 'audio/wav', audio: new Uint8Array([1, 2, 3]), language: 'zh' }
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

  it('上传文件：发到 <地址>/audio/transcriptions，带 Key、文件、模型、语言；返回 text', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const text = await transcribeAudio(endpoint(), req, async (url, init) => {
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
    expect((form.get('file') as File).name).toBe('speech.wav')
  })

  it('对话接口：发到 <地址>/chat/completions，录音放 input_audio；返回 choices[0].message.content', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const text = await transcribeAudio(
      endpoint({ mode: 'chat' }),
      { ...req, model: 'mimo-v2.5-asr', language: null },
      async (url, init) => {
        seen.push({ url, init })
        return new Response(JSON.stringify({ choices: [{ message: { content: ' 你好 ' } }] }), { status: 200 })
      },
    )
    expect(text).toBe('你好')
    expect(seen[0].url).toBe('https://api.example.test/v1/chat/completions')
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret-1234')
    expect(JSON.parse(seen[0].init.body as string)).toEqual({
      model: 'mimo-v2.5-asr',
      messages: [
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,AQID' } }] },
      ],
      asr_options: { language: 'auto' },
    })
  })

  it('对话接口不收 webm（不发请求）；返回里没有文字报格式不对', async () => {
    let called = false
    await expect(
      transcribeAudio(endpoint({ mode: 'chat' }), { ...req, mime: 'audio/webm' }, async () => {
        called = true
        return new Response('')
      }),
    ).rejects.toThrow('wav')
    expect(called).toBe(false)
    await expect(transcribeAudio(endpoint({ mode: 'chat' }), req, reply(200, '{"choices":[]}'))).rejects.toThrow(
      '格式不对',
    )
  })

  it('纯文本回复也认；JSON 里没有 text 报格式不对', async () => {
    expect(await transcribeAudio(endpoint(), req, reply(200, '你好\n'))).toBe('你好')
    await expect(transcribeAudio(endpoint(), req, reply(200, '{"ok":true}'))).rejects.toThrow('格式不对')
  })

  it('404 说这个地址没有这个接口；报错里不带 Key', async () => {
    await expect(transcribeAudio(endpoint(), req, reply(404, 'Not Found'))).rejects.toThrow('/audio/transcriptions')
    const err = await transcribeAudio(
      endpoint(),
      req,
      reply(401, '{"error":{"message":"bad key sk-secret-1234"}}'),
    ).catch((e: Error) => e.message)
    expect(err).toContain('拒绝了这个 Key')
    expect(err).not.toContain('sk-secret-1234')
  })
})
