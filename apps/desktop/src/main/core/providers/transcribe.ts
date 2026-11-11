// 语音输入的转写（docs/ui/voice-input.md）：把录音发到用户自定义接口的 OpenAI 兼容 /audio/transcriptions
import type { ResolvedProvider } from './store'
import { classifyError, classifyStatus, providerHeaders, upstreamUrl, type Fetch } from './upstream'

/** OpenAI 转写接口的上限 */
const MAX_BYTES = 25 * 1024 * 1024
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
  /** 不带参数的类型，例如 audio/webm */
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
export async function transcribeAudio(p: ResolvedProvider, req: TranscribeRequest, fetch: Fetch): Promise<string> {
  if (p.protocol === 'anthropic')
    throw new Error(`接口「${p.name}」是 Anthropic 协议，没有语音转写；请换一个 OpenAI 兼容的接口`)
  const url = upstreamUrl(p, '/v1/audio/transcriptions')
  const form = new FormData()
  // 复制一份：Blob 不收底层可能是 SharedArrayBuffer 的视图
  form.append('file', new Blob([new Uint8Array(req.audio)], { type: req.mime }), `speech.${EXT[req.mime]}`)
  form.append('model', req.model)
  if (req.language) form.append('language', req.language)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      // 不写 content-type：multipart 的分隔符由 fetch 自己带
      headers: providerHeaders(p, { accept: 'application/json' }),
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch (err) {
    throw new Error(classifyError(err, url).message)
  }
  const body = await res.text()
  if (!res.ok) {
    const c = classifyStatus(res.status, body, p, req.model)
    throw new Error(
      c.problem === 'not_found' ? `接口「${p.name}」没有语音转写（/audio/transcriptions 返回 404）` : c.message,
    )
  }
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    // 有的接口直接回纯文本
    return body.trim()
  }
  const text = (json as { text?: unknown } | null)?.text
  if (typeof text !== 'string') throw new Error('接口返回的转写结果格式不对')
  return text.trim()
}
