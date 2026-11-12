// 语音输入的转写（docs/ui/voice-input.md §10）：把录音发到设置里的地址。
// 两种调用方式：OpenAI 的 /audio/transcriptions（上传文件），或 /chat/completions 里带 input_audio（小米 MiMo 等）
import { classifyError, classifyStatus, providerHeaders, type Fetch } from '../providers/upstream'
import type { VoiceEndpoint } from './config'

/** OpenAI 转写接口的上限 */
const MAX_BYTES = 25 * 1024 * 1024
/** 对话接口：Base64 以后不超过 10 MB（MiMo 的上限） */
const MAX_CHAT_BYTES = 7 * 1024 * 1024
const TIMEOUT = 60_000
/** 上传时的文件扩展名：接口按它认格式 */
const EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}

export interface TranscribeRequest {
  model: string
  /** 不带参数的类型，例如 audio/wav */
  mime: string
  audio: Uint8Array
  /** 两个字母的语言代码；null 让接口自己判断 */
  language: string | null
}

/** 渲染进程传来的参数：格式、大小都在这里拦 */
export function parseTranscribeRequest(raw: unknown): TranscribeRequest {
  const v = (raw ?? {}) as Record<string, unknown>
  const model = typeof v.model === 'string' ? v.model.trim() : ''
  // eslint-disable-next-line no-control-regex
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error('请填写语音识别模型')
  const mime = typeof v.mime === 'string' ? v.mime.split(';')[0].trim().toLowerCase() : ''
  if (!EXT[mime]) throw new Error('不支持的录音格式')
  const audio =
    v.audio instanceof Uint8Array ? v.audio : v.audio instanceof ArrayBuffer ? new Uint8Array(v.audio) : null
  if (!audio || !audio.byteLength) throw new Error('没有录到声音')
  if (audio.byteLength > MAX_BYTES) throw new Error('录音太大（超过 25 MB）')
  const language = typeof v.language === 'string' && /^[a-z]{2}$/.test(v.language) ? v.language : null
  return { model, mime, audio, language }
}

/** 转写一段录音，返回文字（去掉首尾空白，可能是空串） */
export async function transcribeAudio(e: VoiceEndpoint, req: TranscribeRequest, fetch: Fetch): Promise<string> {
  // 报错翻译、Key 打码沿用自定义接口的那一套
  const p = { name: '语音识别', protocol: 'chat' as const, auth: 'bearer' as const, apiKey: e.apiKey, headers: {} }
  const chat = e.mode === 'chat'
  const path = chat ? '/chat/completions' : '/audio/transcriptions'
  const url = e.baseUrl + path
  let body: FormData | string
  if (chat) {
    if (req.mime !== 'audio/wav' && req.mime !== 'audio/mpeg') throw new Error('对话接口只收 wav、mp3 录音')
    if (req.audio.byteLength > MAX_CHAT_BYTES) throw new Error('录音太大（对话接口最多约 7 MB）')
    const data = `data:${req.mime};base64,${Buffer.from(req.audio).toString('base64')}`
    body = JSON.stringify({
      model: req.model,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data } }] }],
      asr_options: { language: req.language ?? 'auto' },
    })
  } else {
    body = new FormData()
    // 复制一份：Blob 不收底层可能是 SharedArrayBuffer 的视图
    body.append('file', new Blob([new Uint8Array(req.audio)], { type: req.mime }), `speech.${EXT[req.mime]}`)
    body.append('model', req.model)
    if (req.language) body.append('language', req.language)
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      // 上传文件时不写 content-type：multipart 的分隔符由 fetch 自己带
      headers: providerHeaders(p, { accept: 'application/json', ...(chat && { 'content-type': 'application/json' }) }),
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch (err) {
    throw new Error(classifyError(err, url).message)
  }
  const reply = await res.text()
  if (!res.ok) {
    const c = classifyStatus(res.status, reply, p, req.model)
    throw new Error(
      c.problem === 'not_found' ? `这个地址没有 ${path}（返回 404），换一种调用方式或检查接口地址` : c.message,
    )
  }
  let json: unknown
  try {
    json = JSON.parse(reply)
  } catch {
    // 有的接口直接回纯文本
    return reply.trim()
  }
  const text = chat
    ? (json as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content
    : (json as { text?: unknown } | null)?.text
  if (typeof text !== 'string') throw new Error('接口返回的转写结果格式不对')
  return text.trim()
}
