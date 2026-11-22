import type { EngineInfo, SessionRecord } from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, SessionContext } from '../adapter'
import { engineBase } from '../registry'
import { DotClient, type DotClientOptions, type DotCredentials, type DotHistoryPage, type DotIdentity } from './client'
import { DotSession } from './session'

export {
  DotClient,
  type DotClientOptions,
  type DotCredentials,
  type DotIdentity,
  type DotMessage,
  type DotWorkflow,
  type DotProfile,
  type DotChatMessage,
  type DotHistoryPage,
  type DotOverview,
  type DotAttachment,
  type DotFileData,
  DOT_FILE_LIMIT,
} from './client'

export interface DotAdapterOptions extends Omit<DotClientOptions, 'credentials'> {
  credentials: (signal?: AbortSignal, account?: string) => DotCredentials | null | Promise<DotCredentials | null>
  /** 会话里读取出错后的重试间隔（测试时缩短），见 DotSessionOptions.retryMs */
  retryMs?: readonly number[]
  /** 会话里轮询新消息、状态的间隔（测试时缩短），见 DotSessionOptions.pollMs */
  pollMs?: number
}

export class DotAdapter implements EngineAdapter {
  private readonly client: DotClient
  private readonly busy = new Set<string>()
  private readonly readers = new Map<string, { at: number; value: Promise<{ client: DotClient; dot: DotIdentity }> }>()
  readonly enginePicksSessionId = true
  constructor(private readonly options: DotAdapterOptions) {
    this.client = new DotClient(options)
  }

  async info(force = false): Promise<EngineInfo> {
    return this.connectionInfo(undefined, force)
  }

  infoForSession(record: SessionRecord): Promise<EngineInfo> {
    return this.connectionInfo(record.dot?.account)
  }

  /** 这个账号（不传是 Codex 当前账号）在本机登录着 ChatGPT、而且是 Pro 档：凭据函数对别的档位返回 null */
  async signedIn(account?: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const c = await this.options.credentials(signal, account)
      return !!(c?.accessToken && c.accountId && c.accountUserId)
    } catch {
      // Codex 不可用或未登录：凭据相关的底层错误不进入 UI 或日志。
      return false
    }
  }

  private async connectionInfo(account?: string, force = false): Promise<EngineInfo> {
    const configured = await this.signedIn(account)
    const info: EngineInfo = {
      ...engineBase('dot'),
      status: configured ? 'ready' : 'unauthenticated',
      version: null,
      path: null,
      message: configured ? null : 'Sign in to ChatGPT with Codex to use Dot',
      auth: { kind: 'login' },
    }
    if (configured && force) {
      try {
        await this.client.discover()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Dot connection unavailable'
        info.status = /^Dot HTTP (401|403)$/.test(message) ? 'unauthenticated' : 'error'
        info.message = message
      }
    }
    return info
  }

  createSession(ctx: SessionContext): EngineSession {
    const record = ctx.record()
    if (record.platform || record.provider) throw new Error('Dot uses its ChatGPT connection, not a model API endpoint')
    const target = record.dot
    const client = target
      ? new DotClient({
          ...this.options,
          target,
          credentials: signal => this.options.credentials(signal, target.account),
        })
      : this.client
    return new DotSession(client, ctx, {
      retryMs: this.options.retryMs,
      pollMs: this.options.pollMs,
      acquire: dot => {
        // A personal Dot has one shared native room, not one remote conversation per local tab.
        const key = client.connectionKey(dot)
        if (this.busy.has(key)) throw new Error('Dot is serving another local session; wait for its reply')
        this.busy.add(key)
        return () => {
          this.busy.delete(key)
        }
      },
    })
  }

  listDots(account: string, signal?: AbortSignal) {
    return new DotClient({ ...this.options, credentials: abort => this.options.credentials(abort, account) }).catalog(
      signal,
    )
  }

  async readDot(
    account: string,
    target: { id: string; threadId: string },
    options: { before?: string; after?: string; overview?: boolean; overviewOnly?: boolean },
    signal?: AbortSignal,
  ) {
    const { client, dot } = await this.reader(account, target, signal)
    const historyRequest: DotHistoryPage | Promise<DotHistoryPage> = options.overviewOnly
      ? { items: [], before: null }
      : options.after
        ? client.historyAfter(dot, options.after, signal)
        : client.history(dot, options.before, signal)
    const [history, overview] = await Promise.all([
      historyRequest,
      options.overview || options.overviewOnly ? client.overview(dot, signal) : undefined,
    ])
    return { history, ...(overview ? { overview } : {}) }
  }

  async download(account: string, target: { id: string; threadId: string }, fileId: string, signal?: AbortSignal) {
    const { client, dot } = await this.reader(account, target, signal)
    return client.download(dot, fileId, signal)
  }

  async computerOffer(account: string, target: { id: string; threadId: string }, offer: string, signal?: AbortSignal) {
    const { client, dot } = await this.reader(account, target, signal)
    return client.computerOffer(dot, offer, signal)
  }

  private async reader(account: string, target: { id: string; threadId: string }, signal?: AbortSignal) {
    const key = JSON.stringify([account, target.id, target.threadId])
    let reader = this.readers.get(key)
    if (!reader || Date.now() - reader.at > 60_000) {
      const client = new DotClient({
        ...this.options,
        target,
        credentials: abort => this.options.credentials(abort, account),
      })
      const value = client.discover(signal).then(dot => ({ client, dot }))
      reader = { at: Date.now(), value }
      this.readers.set(key, reader)
      void value.catch(() => {
        if (this.readers.get(key)?.value === value) this.readers.delete(key)
      })
      if (this.readers.size > 50) this.readers.delete(this.readers.keys().next().value!)
    }
    return reader.value
  }
}
