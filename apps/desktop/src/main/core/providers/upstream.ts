// 发往用户接口的请求（docs/ui/custom-api.md §4.1）：地址拼法、认证头、错误分类。网关、测试连接、读取模型共用
import type { ProviderProblem, ProviderProtocol, ProviderTestResult } from '../../../shared/types/providers'
import type { ResolvedProvider } from './store'

/** 各协议的请求路径（本机网关和上游共用同一套） */
export const PROTOCOL_PATH = {
  anthropic: '/v1/messages',
  responses: '/v1/responses',
  chat: '/v1/chat/completions',
} as const satisfies Record<ProviderProtocol, string>

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * 后台小模型：只认还在模型列表里的；没选、或者选的模型已经从列表里删掉了，用列表第一个（列表空时 null）。
 * 旧配置里可能还存着删掉的模型名，启动 Claude 和网关兜底都要经过这里，免得把请求发给已经下线的模型
 */
export function smallModelOf(p: Pick<ResolvedProvider, 'models' | 'smallModel'>): string | null {
  const ids = p.models.map(m => m.id)
  return p.smallModel && ids.includes(p.smallModel) ? p.smallModel : (ids[0] ?? null)
}

/**
 * 本机网关收到的路径换成接口地址：
 * - Anthropic 协议：接口地址不带 /v1（https://api.anthropic.com），Claude Code 发 /v1/messages，原样拼上；
 * - Responses 协议：接口地址带 /v1（https://api.openai.com/v1），Codex 发到网关的 /v1/responses，去掉 /v1 再拼。
 * - Chat Completions 协议：同 Responses，接口地址就是 /chat/completions 前面的部分（https://api.deepseek.com、https://openrouter.ai/api/v1）。
 */
export function upstreamUrl(p: Pick<ResolvedProvider, 'protocol' | 'baseUrl'>, path: string): string {
  const rest = p.protocol !== 'anthropic' ? path.replace(/^\/v1(?=\/|$)/, '') : path
  return p.baseUrl + rest
}

/** 认证头和附加请求头；Anthropic 协议没带版本头时补上（读取模型、测试连接时用） */
export function providerHeaders(
  p: Pick<ResolvedProvider, 'protocol' | 'auth' | 'apiKey' | 'headers'>,
  base: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { ...base, ...p.headers }
  if (p.apiKey) {
    if (p.auth === 'bearer') headers.authorization = `Bearer ${p.apiKey}`
    else headers['x-api-key'] = p.apiKey
  }
  if (p.protocol === 'anthropic' && !Object.keys(headers).some(k => k.toLowerCase() === 'anthropic-version'))
    headers['anthropic-version'] = '2023-06-01'
  return headers
}

/** 接口返回的错误说明：去掉 Key，最多 300 字 */
export function redact(message: string, p: Pick<ResolvedProvider, 'apiKey' | 'headers'>): string {
  let out = message
  for (const secret of [p.apiKey, ...Object.values(p.headers)])
    if (secret && secret.length >= 4) out = out.split(secret).join('••••')
  return out.length > 300 ? out.slice(0, 300) + '…' : out
}

function upstreamMessage(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
    if (typeof json.error === 'string') return json.error
    if (json.error && typeof json.error.message === 'string') return json.error.message
    if (typeof json.message === 'string') return json.message
  } catch {
    /* 不是 JSON，用原文 */
  }
  return body.trim()
}

/** HTTP 错误翻成人话（§3.1、§3.3） */
export function classifyStatus(
  status: number,
  body: string,
  p: Pick<ResolvedProvider, 'name' | 'apiKey' | 'headers'>,
  model: string | null,
): { problem: ProviderProblem; message: string } {
  const detail = redact(upstreamMessage(body), p)
  if (status === 401 || status === 403)
    return {
      problem: 'auth',
      message: `自定义接口「${p.name}」拒绝了这个 Key（${status}）${detail ? '：' + detail : ''}`,
    }
  if (status === 402 || status === 429)
    return { problem: 'quota', message: detail || (status === 429 ? '请求太频繁或额度用完（429）' : '余额不足（402）') }
  if ((status === 404 || status === 400) && model && /model/i.test(detail))
    return { problem: 'model', message: `接口「${p.name}」没有模型 ${model}${detail ? '：' + detail : ''}` }
  if (status === 404) return { problem: 'not_found', message: '地址不对：接口返回 404，检查是否多写或少写了 /v1' }
  return { problem: 'other', message: `接口返回 ${status}${detail ? '：' + detail : ''}` }
}

/** fetch 抛出的错误：超时、跳转、证书、连不上 */
export function classifyError(err: unknown, url: string): { problem: ProviderProblem; message: string } {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  const origin = (() => {
    try {
      return new URL(url).origin
    } catch {
      return url
    }
  })()
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
    return { problem: 'timeout', message: `连不上 ${origin}：超时` }
  const code = e?.cause?.code ?? ''
  const text = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`
  if (/redirect/i.test(text))
    return { problem: 'redirect', message: `${origin} 要求跳转到别的地址，为了不把 Key 带走已拦下` }
  if (/CERT|SSL|TLS/i.test(code + text)) return { problem: 'network', message: `连不上 ${origin}：证书错误` }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return { problem: 'network', message: `连不上 ${origin}：找不到这个域名` }
  if (code === 'ECONNREFUSED') return { problem: 'network', message: `连不上 ${origin}：连接被拒绝` }
  return { problem: 'network', message: `连不上 ${origin}${code ? '：' + code : ''}` }
}

const TIMEOUT = 20_000

/** 从接口读取模型（GET /v1/models），按 id 去重排序 */
export async function fetchModels(p: ResolvedProvider, fetch: Fetch): Promise<string[]> {
  const url = upstreamUrl(p, '/v1/models')
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: providerHeaders(p, { accept: 'application/json' }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch (err) {
    throw new Error(classifyError(err, url).message)
  }
  const body = await res.text()
  if (!res.ok) throw new Error(classifyStatus(res.status, body, p, null).message)
  let data: unknown
  try {
    data = (JSON.parse(body) as { data?: unknown }).data
  } catch {
    throw new Error('接口返回的模型列表格式不对，请手动填写')
  }
  if (!Array.isArray(data)) throw new Error('接口返回的模型列表格式不对，请手动填写')
  const ids = data
    .map(m => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && !!id.trim() && id.length <= 200)
  return [...new Set(ids)].sort().slice(0, 200)
}

/** 测试连接：用第一个模型发一个最小请求；没有模型时改为读取模型列表 */
export async function testProvider(p: ResolvedProvider, fetch: Fetch): Promise<ProviderTestResult> {
  const model = p.models[0]?.id ?? null
  if (!model)
    try {
      await fetchModels(p, fetch)
      return { ok: true, status: 200, model: null }
    } catch (err) {
      return { ok: false, problem: 'other', status: null, message: (err as Error).message }
    }
  const url = upstreamUrl(p, PROTOCOL_PATH[p.protocol])
  const body =
    p.protocol === 'anthropic'
      ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
      : p.protocol === 'chat'
        ? { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }
        : { model, input: 'ping', max_output_tokens: 16 }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: providerHeaders(p, { 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch (err) {
    return { ok: false, status: null, ...classifyError(err, url) }
  }
  const text = await res.text().catch(() => '')
  if (res.ok) return { ok: true, status: res.status, model }
  return { ok: false, status: res.status, ...classifyStatus(res.status, text, p, model) }
}
