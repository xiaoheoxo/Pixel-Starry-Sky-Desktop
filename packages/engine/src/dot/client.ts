// Native web protocol, documented references and compatibility limits: packages/engine/DOT.md.
export interface DotCredentials {
  accessToken: string
  accountId: string
  accountUserId: string
  userId?: string
}

export interface DotIdentity {
  id: string
  roomId: string
  threadId: string
  memberId: string
}

export interface DotMessage {
  id: string
  account_user_id: string
  created_at: string
  deleted_at?: string | null
  request_id?: string
  content: {
    text?: string
    attachments?: { type: string; thread_id?: string }[]
    elicitation?: unknown
  }
}

export interface DotWorkflow {
  id: string
  title: string
  status: 'thinking' | 'inProgress' | 'needsInput' | 'completed' | 'failed' | 'interrupted'
  startedAt: number
  updatedAt: number
}

export interface DotClientOptions {
  credentials: (signal?: AbortSignal) => DotCredentials | null | Promise<DotCredentials | null>
  fetch?: typeof fetch
  /** 固定 Dot 时跳过 primary 选择，仍逐项核对 profile 和消息房间。 */
  target?: { id: string; threadId: string }
}

export interface DotProfile {
  id: string
  name: string
  threadId: string
  status: string
  avatarUrl?: string
  lastActiveAt?: number
}

export interface DotAttachment {
  type: string
  name: string
  fileId?: string
  mime?: string
  url?: string
}
export interface DotFileData {
  name: string
  mime: string
  data: Uint8Array
}
export const DOT_FILE_LIMIT = 20 * 1024 * 1024
export interface DotChatMessage {
  id: string
  requestId?: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  attachments: DotAttachment[]
}
export interface DotHistoryPage {
  items: DotChatMessage[]
  before: string | null
  latest?: string
}
export interface DotOverview {
  profile: DotProfile
  environment: { status: string; capabilities: { type: string; status: string }[] } | null
  activity: { id: string; title: string; status: string }[] | null
  tasks: { id: string; title: string; status: string }[] | null
  errors: string[]
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch {
    return undefined
  }
}
function profileOf(item: Record<string, unknown>): DotProfile {
  const lastActiveAt = typeof item.last_check_in_at === 'string' ? Date.parse(item.last_check_in_at) : NaN
  return {
    id: string(item.id),
    threadId: string(item.active_root_thread_id ?? item.root_thread_id),
    name: typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name.trim() : 'Dot',
    status: item.is_paused === true ? 'paused' : typeof item.status === 'string' ? item.status : 'unknown',
    ...(httpsUrl(item.avatar_url) ? { avatarUrl: httpsUrl(item.avatar_url) } : {}),
    ...(Number.isFinite(lastActiveAt) ? { lastActiveAt } : {}),
  }
}
function attachmentOf(value: unknown): DotAttachment {
  const a = object(value)
  const file = a.file && typeof a.file === 'object' ? object(a.file) : a
  return {
    type: string(a.type),
    name: typeof file.name === 'string' ? file.name : typeof file.file_name === 'string' ? file.file_name : '',
    ...(typeof a.file_id === 'string' ? { fileId: a.file_id } : {}),
    ...(typeof file.mime_type === 'string' ? { mime: file.mime_type } : {}),
    ...(httpsUrl(file.download_url ?? file.url) ? { url: httpsUrl(file.download_url ?? file.url) } : {}),
  }
}

const WEB = 'https://chatgpt.com/backend-api'
const CLOUD = 'https://codex-cloud-backend.chatgpt.com'
function invalid(): never {
  throw new Error('Dot protocol identity or response changed')
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : invalid()
const string = (value: unknown): string => (typeof value === 'string' && value.length > 0 ? value : invalid())
interface DotConnection {
  account: string
  user: string
  member?: string
}
class DotHttpError extends Error {
  constructor(readonly status: number) {
    super(`Dot HTTP ${status}`)
  }
}
const NETWORK_FAILED = 'Dot network request failed'
/** 读取类请求值得隔一会儿再试的错：连不上、超时、5xx、429；登录失效、协议变了这类重试也没用 */
export function dotRetryable(error: unknown): boolean {
  if (error instanceof DotHttpError) return error.status >= 500 || error.status === 429 || error.status === 408
  return error instanceof Error && error.message === NETWORK_FAILED
}

function message(value: unknown): DotMessage {
  const m = object(value)
  string(m.id)
  string(m.account_user_id)
  if (!Number.isFinite(Date.parse(string(m.created_at)))) invalid()
  const content = object(m.content)
  if (content.text !== undefined && typeof content.text !== 'string') invalid()
  if (content.attachments !== undefined && !Array.isArray(content.attachments)) invalid()
  if (Array.isArray(content.attachments))
    for (const attachment of content.attachments) {
      const a = object(attachment)
      string(a.type)
      if (a.type === 'thread') string(a.thread_id)
    }
  return m as unknown as DotMessage
}

export class DotClient {
  private readonly verified = new WeakMap<DotIdentity, DotConnection>()
  private readonly profiles = new WeakMap<DotIdentity, DotProfile>()
  constructor(private readonly options: DotClientOptions) {}

  private async credentials(signal?: AbortSignal): Promise<DotCredentials> {
    const c = await this.options.credentials(signal)
    signal?.throwIfAborted()
    if (!c?.accessToken || !c.accountId || !c.accountUserId) throw new Error('Sign in to ChatGPT with Codex to use Dot')
    return c
  }

  private connection(dot: DotIdentity): DotConnection {
    const known = this.verified.get(dot)
    if (!known) invalid()
    return known
  }

  connectionKey(dot: DotIdentity): string {
    return JSON.stringify([this.connection(dot).account, dot.roomId])
  }

  private async authHeaders(connection?: DotConnection, signal?: AbortSignal): Promise<Record<string, string>> {
    const c = await this.credentials(signal)
    if (connection && (connection.account !== c.accountId || connection.user !== c.accountUserId))
      throw new Error('ChatGPT account changed; start a new Dot conversation')
    return {
      Authorization: `Bearer ${c.accessToken}`,
      'ChatGPT-Account-Id': c.accountId,
      'X-OpenAI-Expected-Account-Id': c.accountId,
    }
  }

  private async request(
    path: string,
    signal?: AbortSignal,
    body?: unknown,
    cloud = false,
    connection?: DotConnection,
  ): Promise<unknown> {
    const headers = await this.authHeaders(connection, signal)
    const multipart = body instanceof FormData
    if (!multipart) headers['Content-Type'] = 'application/json'
    if (cloud) headers['X-OpenAI-Product-Sku'] = 'unknown'
    // Never retry POST: a failed response can still mean the message was delivered.
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)((cloud ? CLOUD : WEB) + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: multipart ? body : body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      })
    } catch {
      signal?.throwIfAborted()
      throw new Error(body === undefined ? NETWORK_FAILED : 'Dot delivery unknown; check ChatGPT before resending')
    }
    if (!response.ok) throw new DotHttpError(response.status)
    try {
      return await response.json()
    } catch {
      return invalid()
    }
  }

  async discover(signal?: AbortSignal): Promise<DotIdentity> {
    const credentials = await this.credentials(signal)
    const connection: DotConnection = { account: credentials.accountId, user: credentials.accountUserId }
    const target = this.options.target
    const result = target ? null : object(await this.request('/tbo/primary', signal, undefined, false, connection))
    if (!target && !result?.selection) throw new Error('No primary Dot; create one in ChatGPT')
    const s = target ? null : object(result!.selection)
    if (s && s.available !== true) throw new Error('Primary Dot unavailable')
    const id = target?.id ?? string(s!.aeon_id)
    let threadId = target?.threadId ?? string(s!.thread_id)
    let profile: Record<string, unknown>
    try {
      profile = object(
        await this.request(`/tbo/by-thread/${encodeURIComponent(threadId)}`, signal, undefined, false, connection),
      )
    } catch (error) {
      // 工作线程索引可能失效；只按已选 Dot 的稳定 ID 恢复，绝不改选 primary 或其它账号。
      if (!(error instanceof DotHttpError) || error.status !== 404) throw error
      profile = object(await this.request(`/tbo/${encodeURIComponent(id)}`, signal, undefined, false, connection))
      if (profile.id !== id) invalid()
      threadId = string(profile.active_root_thread_id ?? profile.root_thread_id)
    }
    if (
      profile.id !== id ||
      (!target && profile.messaging_room_id !== s!.messaging_room_id) ||
      (profile.active_root_thread_id && profile.active_root_thread_id !== threadId)
    )
      invalid()
    if (profile.status !== 'active' || profile.is_paused === true)
      throw new Error('Dot paused or unavailable; open ChatGPT')
    const roomId = string(profile.messaging_room_id)
    const room = object(
      await this.request(`/messaging/rooms/${encodeURIComponent(roomId)}`, signal, undefined, false, connection),
    )
    if (room.id !== roomId || room.aeon_id !== id || room.type !== 'DM' || room.app_source !== 'chatgpt:messaging')
      invalid()
    if (!Array.isArray(room.members)) invalid()
    const members = room.members.map(object)
    const humans = members.filter(
      m =>
        !m.aeon_id &&
        (m.account_user_id === credentials.accountUserId ||
          (!!credentials.userId && m.account_user_id === credentials.userId)),
    )
    if (humans.length !== 1) invalid()
    connection.member = string(humans[0].account_user_id)
    const bot = members.find(m => m.aeon_id === id)
    if (!bot || bot.account_user_id === connection.member) invalid()
    const dot = Object.freeze({ id, threadId, roomId, memberId: string(bot.account_user_id) })
    this.verified.set(dot, connection)
    this.profiles.set(dot, profileOf({ ...profile, active_root_thread_id: threadId }))
    return dot
  }

  /** 公开原生协议的账号 Dot 列表；不把聊天摘要或完整 profile 传到 UI。 */
  async catalog(signal?: AbortSignal): Promise<DotProfile[]> {
    const c = await this.credentials(signal)
    const connection = { account: c.accountId, user: c.accountUserId }
    const profiles = new Map<string, DotProfile>()
    const seen = new Set<string>()
    let cursor = ''
    for (let page = 0; page < 1000; page++) {
      const query = new URLSearchParams({ limit: '25', include_room_preview: 'false' })
      if (cursor) query.set('cursor', cursor)
      const result = object(await this.request(`/tbo?${query}`, signal, undefined, false, connection))
      if (!Array.isArray(result.items)) invalid()
      for (const raw of result.items) {
        const item = object(raw)
        const id = string(item.id)
        const threadId = string(item.active_root_thread_id ?? item.root_thread_id)
        profiles.set(id, profileOf({ ...item, active_root_thread_id: threadId }))
      }
      if (!result.cursor) return [...profiles.values()]
      cursor = string(result.cursor)
      if (seen.has(cursor)) throw new Error('Dot catalog pagination repeated')
      seen.add(cursor)
    }
    throw new Error('Dot catalog too large')
  }

  /** 原生历史按 before 向前翻页，与发送后用 after 等回复的读取分开。 */
  async history(dot: DotIdentity, before?: string, signal?: AbortSignal): Promise<DotHistoryPage> {
    const connection = this.connection(dot)
    const query = new URLSearchParams({ limit: '32' })
    if (before) query.set('before', before)
    const page = object(
      await this.request(
        `/messaging/rooms/${encodeURIComponent(dot.roomId)}/messages?${query}`,
        signal,
        undefined,
        false,
        connection,
      ),
    )
    if (!Array.isArray(page.items)) invalid()
    const messages = page.items.map(message).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    const cursor = page.prev_cursor ? string(page.prev_cursor) : messages.length === 32 ? messages[0].id : null
    if (cursor && cursor === before) throw new Error('Dot history pagination repeated')
    return { items: this.toHistory(dot, messages), before: cursor, latest: messages.at(-1)?.id }
  }

  /** Fetch all additions after a verified room's cursor, not just its newest 32 messages. */
  async historyAfter(dot: DotIdentity, after: string, signal?: AbortSignal): Promise<DotHistoryPage> {
    try {
      const messages = await this.messages(dot, after, signal)
      return { items: this.toHistory(dot, messages), before: null, latest: messages.at(-1)?.id ?? after }
    } catch (error) {
      // The room cursor may have been removed. Reload the newest page in the same verified room.
      if (error instanceof DotHttpError && (error.status === 400 || error.status === 404))
        return this.history(dot, undefined, signal)
      throw error
    }
  }

  private toHistory(dot: DotIdentity, messages: DotMessage[]): DotChatMessage[] {
    const { member } = this.connection(dot)
    return messages
      .filter(m => !m.deleted_at && (m.account_user_id === member || m.account_user_id === dot.memberId))
      .map(m => ({
        id: m.id,
        ...(m.request_id ? { requestId: m.request_id } : {}),
        role: m.account_user_id === dot.memberId ? ('assistant' as const) : ('user' as const),
        text: m.content.text ?? '',
        createdAt: Date.parse(m.created_at),
        attachments: (m.content.attachments ?? []).map(attachmentOf),
      }))
  }

  async overview(dot: DotIdentity, signal?: AbortSignal): Promise<DotOverview> {
    const connection = this.connection(dot)
    const path = `/tbo/${encodeURIComponent(dot.id)}`
    const errors: string[] = []
    const read = async <T>(
      route: string,
      parse: (data: Record<string, unknown>) => T,
      optional = false,
    ): Promise<T | null> => {
      try {
        return parse(object(await this.request(route, signal, undefined, false, connection)))
      } catch (error) {
        signal?.throwIfAborted()
        // Activity/task endpoints are optional on some deployments. A missing list is not a conversation error.
        if (optional && error instanceof DotHttpError && error.status === 404) return null
        errors.push(error instanceof Error ? error.message : 'Dot status unavailable')
        return null
      }
    }
    const rows = (data: Record<string, unknown>) => {
      if (!Array.isArray(data.data)) invalid()
      return data.data
        .map(object)
        .filter(item => typeof item.id === 'string')
        .map(item => ({
          id: string(item.id),
          title: typeof item.title === 'string' ? item.title : typeof item.name === 'string' ? item.name : '',
          status:
            typeof item.status === 'string' ? item.status : typeof item.state === 'string' ? item.state : 'unknown',
        }))
    }
    const [environment, activity, tasks] = await Promise.all([
      read(`${path}/environment/status`, data => ({
        status: string(data.status),
        capabilities: Array.isArray(data.capabilities)
          ? data.capabilities.map(object).map(c => ({ type: string(c.type), status: string(c.status) }))
          : [],
      })),
      read(`${path}/activity?limit=5`, rows, true),
      read(`${path}/tasks?limit=25`, rows, true),
    ])
    return { profile: this.profiles.get(dot)!, environment, activity, tasks, errors }
  }

  async messages(dot: DotIdentity, after = '', signal?: AbortSignal): Promise<DotMessage[]> {
    const connection = this.connection(dot)
    const seen = new Set<string>()
    const messages = new Map<string, DotMessage>()
    for (;;) {
      if (seen.has(after) || seen.size >= 1000) throw new Error('Dot pagination repeated or too large')
      seen.add(after)
      const query = new URLSearchParams({ limit: '32' })
      if (after) query.set('after', after)
      const page = object(
        await this.request(
          `/messaging/rooms/${encodeURIComponent(dot.roomId)}/messages?${query}`,
          signal,
          undefined,
          false,
          connection,
        ),
      )
      if (!Array.isArray(page.items)) invalid()
      const items = page.items.map(message).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      for (const item of items) messages.set(item.id, item)
      if (!items.length || (items.length < 32 && !page.next_cursor)) break
      after = page.next_cursor ? string(page.next_cursor) : items.at(-1)!.id
    }
    return [...messages.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  }

  async send(
    dot: DotIdentity,
    text: string,
    requestId: string,
    signal?: AbortSignal,
    fileIds: string[] = [],
  ): Promise<DotMessage> {
    const connection = this.connection(dot)
    const sent = message(
      await this.request(
        `/messaging/rooms/${encodeURIComponent(dot.roomId)}/messages`,
        signal,
        {
          content: {
            text,
            ...(fileIds.length ? { attachments: fileIds.map(file_id => ({ type: 'file', file_id })) } : {}),
          },
          request_id: requestId,
          idempotency_token: requestId,
        },
        false,
        connection,
      ),
    )
    if (sent.request_id !== requestId || sent.account_user_id !== connection.member)
      throw new Error('Dot delivery unknown; response request identity mismatch')
    return sent
  }

  async upload(
    dot: DotIdentity,
    file: { name: string; mime?: string; data: Uint8Array },
    signal?: AbortSignal,
  ): Promise<string> {
    const connection = this.connection(dot)
    if (file.data.byteLength > DOT_FILE_LIMIT) throw new Error('Dot attachment exceeds 20 MiB')
    const name =
      Array.from(file.name, char =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || '/\\'.includes(char) ? '_' : char,
      )
        .join('')
        .slice(0, 255) || 'attachment'
    const body = new FormData()
    body.append('file', new Blob([new Uint8Array(file.data)], { type: file.mime || 'application/octet-stream' }), name)
    const result = object(
      await this.request(`/messaging/rooms/${encodeURIComponent(dot.roomId)}/files`, signal, body, false, connection),
    )
    return string(result.id)
  }

  /** 历史消息内的 URL 可能失效；先从同一房间按文件 ID 获取新的签名下载地址。 */
  async download(dot: DotIdentity, fileId: string, signal?: AbortSignal): Promise<DotFileData> {
    const connection = this.connection(dot)
    const metadata = object(
      await this.request(
        `/messaging/rooms/${encodeURIComponent(dot.roomId)}/files/${encodeURIComponent(string(fileId))}`,
        signal,
        undefined,
        false,
        connection,
      ),
    )
    if ((metadata.id && metadata.id !== fileId) || (metadata.file_id && metadata.file_id !== fileId))
      throw new Error('Dot attachment identity mismatch')
    const url = new URL(string(metadata.download_url))
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !url.hostname.endsWith('.oaiusercontent.com')
    )
      throw new Error('Unsupported Dot attachment storage')
    const response = await (this.options.fetch ?? fetch)(url.href, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Dot attachment HTTP ${response.status}`)
    if (Number(response.headers.get('content-length')) > DOT_FILE_LIMIT) {
      await response.body?.cancel()
      throw new Error('Dot attachment exceeds 20 MiB')
    }
    const chunks: Uint8Array[] = []
    let length = 0
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Dot attachment empty')
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > DOT_FILE_LIMIT) throw new Error('Dot attachment exceeds 20 MiB')
        chunks.push(chunk.value)
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      reader.releaseLock()
    }
    const data = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      data.set(chunk, offset)
      offset += chunk.byteLength
    }
    return {
      name: typeof metadata.name === 'string' ? metadata.name : 'attachment',
      mime:
        typeof metadata.mime_type === 'string'
          ? metadata.mime_type
          : response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
      data,
    }
  }

  /** 信令通过主进程认证；renderer 只获得 SDP 应答，OAuth 不离开主进程。 */
  async computerOffer(dot: DotIdentity, offer: string, signal?: AbortSignal): Promise<string> {
    const connection = this.connection(dot)
    if (typeof offer !== 'string' || offer.length > 256_000 || !offer.startsWith('v=0'))
      throw new Error('Invalid Dot computer offer')
    const headers = await this.authHeaders(connection, signal)
    const query = new URLSearchParams({ source: 'aeon', thread_id: dot.threadId, aeon_id: dot.id })
    const response = await (this.options.fetch ?? fetch)(`https://realtime.chatgpt.com/v1/cua?${query}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/sdp' },
      body: offer,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Dot computer HTTP ${response.status}`)
    const answer = await response.text()
    if (!answer.startsWith('v=0') || answer.length > 256_000) throw new Error('Invalid Dot computer answer')
    return answer
  }

  /** Root thread activity is separate from the workflows delegated by that thread. */
  async activity(dot: DotIdentity, signal?: AbortSignal): Promise<string> {
    const connection = this.connection(dot)
    const value = object(
      await this.request(`/v1/threads/${encodeURIComponent(dot.threadId)}`, signal, undefined, true, connection),
    )
    const thread = object(value.thread)
    if (thread.id !== dot.threadId) invalid()
    const status = object(thread.status)
    const type = string(status.type)
    // 在忙但带着等待标记（等你确认或回答，和 workflow() 的 needsInput 同一个判断）：报成 waiting
    return type === 'active' && Array.isArray(status.activeFlags) && status.activeFlags.length ? 'waiting' : type
  }

  async workflow(dot: DotIdentity, card: DotMessage, threadId: string, signal?: AbortSignal): Promise<DotWorkflow> {
    const connection = this.connection(dot)
    if (
      card.account_user_id !== dot.memberId ||
      card.deleted_at ||
      !card.id ||
      !card.content.attachments?.some(a => a.type === 'thread' && a.thread_id === threadId)
    )
      throw new Error('Dot workflow requires a verified Dot attachment')
    const path = encodeURIComponent(threadId)
    const metadata = object(await this.request(`/v1/threads/${path}`, signal, undefined, true, connection))
    const thread = object(metadata.thread)
    if (thread.id !== threadId) invalid()
    const state = object(thread.status)
    const turns = object(
      await this.request(
        `/v2/threads/${path}/turns?limit=1&sortDirection=desc&itemsView=notLoaded`,
        signal,
        undefined,
        true,
        connection,
      ),
    )
    if (!Array.isArray(turns.data)) invalid()
    const latest = turns.data.length ? object(turns.data[0]) : null
    const status =
      state.type === 'systemError'
        ? 'failed'
        : state.type === 'active'
          ? Array.isArray(state.activeFlags) && state.activeFlags.length
            ? 'needsInput'
            : 'inProgress'
          : (latest?.status ?? 'thinking')
    if (!['thinking', 'inProgress', 'needsInput', 'completed', 'failed', 'interrupted'].includes(String(status)))
      invalid()
    return {
      id: threadId,
      title: typeof thread.name === 'string' ? thread.name : threadId,
      status: status as DotWorkflow['status'],
      startedAt: typeof latest?.startedAt === 'number' ? latest.startedAt : 0,
      updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : 0,
    }
  }
}
