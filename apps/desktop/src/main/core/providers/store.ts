// 自定义 API 的接口配置（docs/ui/custom-api.md §4.2）：providers.json 只存不带密钥的配置，
// Key 和附加请求头的值存在同目录 secrets.json（系统加密）。渲染进程只拿到 ProviderView
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { MASKED_SECRET } from '@pixelsky/engine'
import { PROVIDER_ID } from '@pixelsky/protocol'
import type {
  ProviderAuth,
  ProviderInput,
  ProviderModel,
  ProviderProtocol,
  ProvidersState,
  ProviderTemplate,
  ProviderView,
} from '../../../shared/types/providers'
import { SecureStore, type Cipher } from '../secure-store'

export interface StoredProvider {
  id: string
  name: string
  template: ProviderTemplate
  protocol: ProviderProtocol
  baseUrl: string
  auth: ProviderAuth
  models: ProviderModel[]
  smallModel: string | null
  modelFallback: boolean
  headerNames: string[]
  createdAt: number
  updatedAt: number
}

/** 网关转发时用的完整配置（只在主进程里） */
export interface ResolvedProvider extends StoredProvider {
  apiKey: string | null
  headers: Record<string, string>
}

export const PROVIDER_TEMPLATES: Record<
  Exclude<ProviderTemplate, 'custom'>,
  { protocol: ProviderProtocol; baseUrl: string }
> = {
  anthropic: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  openai: { protocol: 'responses', baseUrl: 'https://api.openai.com/v1' },
}

const MAX_PROVIDERS = 50
const MAX_MODELS = 200
const MAX_HEADERS = 20
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/
/** 网关自己管的请求头：认证、长度、连接等 */
const RESERVED_HEADERS = new Set([
  'host',
  'authorization',
  'x-api-key',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'cookie',
  'accept-encoding',
  'proxy-authorization',
])

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string') throw new Error(`${field}格式不对`)
  const v = value.trim()
  if (!v) throw new Error(`请填写${field}`)
  // eslint-disable-next-line no-control-regex
  if (v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new Error(`${field}格式不对`)
  return v
}

/** 内网地址：本机、10/8、172.16/12、192.168/16、169.254/16、IPv6 本机 / fc00::/7 / fe80::、*.local、*.lan、不带点的主机名 */
export function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan'))
    return true
  const ip = isIP(host)
  if (ip === 4) {
    const [a, b] = host.split('.').map(Number)
    return (
      a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
    )
  }
  if (ip === 6) return host === '::1' || /^f[cd]/.test(host) || host.startsWith('fe80:')
  return !host.includes('.')
}

/** 接口地址：只收 https；http 只允许本机和内网。去掉末尾的 /；Anthropic 协议去掉末尾的 /v1（Claude Code 自己会加） */
export function normalizeBaseUrl(raw: unknown, protocol: ProviderProtocol): string {
  const value = text(raw, '接口地址', 500)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('接口地址格式不对，例如 https://api.example.com')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('接口地址要以 https:// 开头')
  if (url.protocol === 'http:' && !privateHost(url.hostname))
    throw new Error('只有本机和内网地址可以用 http://，其他地址请用 https://')
  if (url.username || url.password) throw new Error('接口地址里不能带用户名或密码，Key 请填在 API Key 里')
  if (url.search || url.hash) throw new Error('接口地址不能带 ? 或 # 后面的部分')
  let path = url.pathname.replace(/\/+$/, '')
  if (protocol === 'anthropic') path = path.replace(/\/v1$/, '')
  return url.origin + path
}

/** 后台小模型必须还在模型列表里，不然存成 null（用列表第一个）；读旧配置时也这样纠正 */
function keptSmallModel(value: unknown, models: ProviderModel[]): string | null {
  return typeof value === 'string' && value && models.some(m => m.id === value) ? value : null
}

function parseModels(value: unknown): ProviderModel[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_MODELS) throw new Error(`模型最多 ${MAX_MODELS} 个`)
  const seen = new Set<string>()
  return value.flatMap((m: unknown) => {
    const raw = typeof m === 'string' ? { id: m } : (m as Partial<ProviderModel> | null)
    if (!raw || typeof raw !== 'object') throw new Error('模型列表格式不对')
    const id = text(raw.id, '模型名', 200)
    if (seen.has(id)) return []
    seen.add(id)
    const out: ProviderModel = { id }
    if (raw.contextWindow !== undefined && raw.contextWindow !== null) {
      const n = raw.contextWindow
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1000 || n > 100_000_000)
        throw new Error(`模型 ${id} 的上下文长度不对`)
      out.contextWindow = n
    }
    if (typeof raw.priceRef === 'string' && raw.priceRef.trim()) out.priceRef = text(raw.priceRef, '计价参照', 200)
    else if (raw.priceRef !== undefined && raw.priceRef !== null && raw.priceRef !== '')
      throw new Error(`模型 ${id} 的计价参照不对`)
    return [out]
  })
}

const copy = (p: StoredProvider): StoredProvider => ({
  ...p,
  models: p.models.map(m => ({ ...m })),
  headerNames: [...p.headerNames],
})

export class ProviderStore {
  private providers: StoredProvider[] = []
  private readonly file: string
  private readonly secrets: SecureStore
  private loadWarning: string | null = null

  constructor(
    private readonly dir: string,
    cipher: Cipher,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(dir, 'providers.json')
    this.secrets = new SecureStore(join(dir, 'secrets.json'), cipher)
    if (existsSync(this.file))
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { providers?: unknown }
        this.providers = Array.isArray(parsed.providers) ? parsed.providers.flatMap(p => this.revive(p)) : []
      } catch {
        this.loadWarning = '自定义 API 配置文件读不出来，已按空列表处理；原文件没有改动。'
      }
  }

  /** 读盘时宽松：一条坏的不影响其他 */
  private revive(raw: unknown): StoredProvider[] {
    try {
      const p = raw as StoredProvider
      if (!p || typeof p.id !== 'string' || !PROVIDER_ID.test(p.id)) return []
      const protocol: ProviderProtocol = p.protocol === 'responses' || p.protocol === 'chat' ? p.protocol : 'anthropic'
      return [
        {
          id: p.id,
          name: text(p.name, '名称', 60),
          template: p.template === 'anthropic' || p.template === 'openai' ? p.template : 'custom',
          protocol,
          baseUrl: normalizeBaseUrl(p.baseUrl, protocol),
          auth: p.auth === 'bearer' ? 'bearer' : 'x-api-key',
          models: parseModels(p.models),
          smallModel: keptSmallModel(p.smallModel, parseModels(p.models)),
          modelFallback: p.modelFallback !== false,
          headerNames: Array.isArray(p.headerNames)
            ? p.headerNames.filter(h => typeof h === 'string' && HEADER_NAME.test(h))
            : [],
          createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
          updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
        },
      ]
    } catch {
      return []
    }
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true })
    const temp = this.file + '.tmp'
    writeFileSync(temp, JSON.stringify({ version: 1, providers: this.providers }, null, 2), { mode: 0o600 })
    renameSync(temp, this.file)
    this.loadWarning = null
  }

  private view(p: StoredProvider): ProviderView {
    const key = this.secrets.get(p.id)?.key
    return { ...copy(p), keyHint: key ? key.slice(-4) : null, insecure: p.baseUrl.startsWith('http:') }
  }

  state(): ProvidersState {
    const warnings = [this.loadWarning, this.secrets.warning].filter(Boolean)
    return {
      providers: this.providers.map(p => this.view(p)),
      persistent: this.secrets.persistent,
      warning: warnings.length ? warnings.join(' ') : null,
    }
  }

  get(id: string): StoredProvider | null {
    const p = this.providers.find(x => x.id === id)
    return p ? copy(p) : null
  }

  /** 网关用：带上真实 Key 和请求头的值 */
  resolve(id: string): ResolvedProvider | null {
    const p = this.get(id)
    if (!p) return null
    const saved = this.secrets.get(id) ?? {}
    const headers: Record<string, string> = {}
    for (const name of p.headerNames) {
      const value = saved['header:' + name]
      if (value !== undefined) headers[name] = value
    }
    return { ...p, apiKey: saved.key ?? null, headers }
  }

  /** 新建或修改。Key 留空不改；请求头值为 MASKED_SECRET 不改，没列出的删掉 */
  save(input: ProviderInput): ProviderView {
    const { next, secrets, existing } = this.build(input)
    this.secrets.set(next.id, secrets)
    this.providers = existing ? this.providers.map(p => (p.id === next.id ? next : p)) : [...this.providers, next]
    this.persist()
    return this.view(next)
  }

  /** 对话框里还没保存的配置：校验后带上密钥（留空的沿用已保存的），给测试连接和读取模型用；不写盘 */
  draft(input: ProviderInput): ResolvedProvider {
    const { next, secrets } = this.build(input, true)
    const headers = Object.fromEntries(next.headerNames.map(n => [n, secrets['header:' + n]]))
    return { ...next, apiKey: secrets.key ?? null, headers }
  }

  private build(
    input: ProviderInput,
    draft = false,
  ): { next: StoredProvider; secrets: Record<string, string>; existing: StoredProvider | undefined } {
    if (!input || typeof input !== 'object') throw new Error('接口配置格式不对')
    const existing = input.id !== undefined ? this.providers.find(p => p.id === input.id) : undefined
    if (input.id !== undefined && !existing) throw new Error('这个接口已经删除')
    if (!existing && !draft && this.providers.length >= MAX_PROVIDERS)
      throw new Error(`最多添加 ${MAX_PROVIDERS} 个接口`)
    if (input.protocol !== 'anthropic' && input.protocol !== 'responses' && input.protocol !== 'chat')
      throw new Error('请选择协议')
    const protocol = input.protocol
    if (existing && existing.protocol !== protocol) throw new Error('已有接口不能换协议，请新建一个')
    const template: ProviderTemplate =
      input.template === 'anthropic' || input.template === 'openai' || input.template === 'custom'
        ? input.template
        : (existing?.template ?? 'custom')
    const auth: ProviderAuth =
      input.auth === 'bearer' || input.auth === 'x-api-key'
        ? input.auth
        : (existing?.auth ?? (protocol === 'anthropic' ? 'x-api-key' : 'bearer'))
    const models = input.models !== undefined ? parseModels(input.models) : (existing?.models ?? [])
    const small = input.smallModel !== undefined ? input.smallModel : (existing?.smallModel ?? null)
    if (small !== null && (typeof small !== 'string' || small.length > 200)) throw new Error('后台小模型格式不对')

    const old = existing ? (this.secrets.get(existing.id) ?? {}) : {}
    const secrets: Record<string, string> = {}
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      const key = input.apiKey.trim()
      // eslint-disable-next-line no-control-regex
      if (key.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(key)) throw new Error('API Key 格式不对')
      secrets.key = key
    } else if (old.key) secrets.key = old.key
    const rawHeaders =
      input.headers ?? Object.fromEntries((existing?.headerNames ?? []).map(n => [n, MASKED_SECRET] as const))
    if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders))
      throw new Error('附加请求头格式不对')
    const headerNames: string[] = []
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (!HEADER_NAME.test(name)) throw new Error(`请求头名称不对：${name}`)
      if (RESERVED_HEADERS.has(name.toLowerCase())) throw new Error(`请求头 ${name} 由程序自己设置，不能改`)
      if (headerNames.some(n => n.toLowerCase() === name.toLowerCase())) throw new Error(`请求头 ${name} 重复了`)
      const resolved = value === MASKED_SECRET ? old['header:' + name] : value
      if (typeof resolved !== 'string' || resolved.length > 4096 || /[\r\n\0]/.test(resolved))
        throw new Error(`请求头 ${name} 的值不对，请重新填写`)
      headerNames.push(name)
      secrets['header:' + name] = resolved
    }
    if (headerNames.length > MAX_HEADERS) throw new Error(`附加请求头最多 ${MAX_HEADERS} 个`)

    const now = this.now()
    const next: StoredProvider = {
      id: existing?.id ?? randomBytes(8).toString('hex'),
      // 测试连接、读取模型列表用的草稿不需要名称（还没填名称就先点「获取模型」很常见）
      name:
        draft && (typeof input.name !== 'string' || !input.name.trim()) ? '未命名接口' : text(input.name, '名称', 60),
      template,
      protocol,
      baseUrl: normalizeBaseUrl(input.baseUrl, protocol),
      auth,
      models,
      // 后台小模型已经不在模型列表里（列表里删掉了）：存成 null，用列表第一个
      smallModel: protocol === 'anthropic' ? keptSmallModel(small, models) : null,
      modelFallback:
        input.modelFallback !== undefined ? input.modelFallback !== false : (existing?.modelFallback ?? true),
      headerNames,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    return { next, secrets, existing }
  }

  remove(id: string): void {
    if (!this.providers.some(p => p.id === id)) return
    this.providers = this.providers.filter(p => p.id !== id)
    this.persist()
    this.secrets.remove(id)
  }
}
