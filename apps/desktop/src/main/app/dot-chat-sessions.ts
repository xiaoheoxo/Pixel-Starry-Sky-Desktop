import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DOT_FILE_LIMIT } from '@pixelsky/engine'
import type { EngineHost } from '@pixelsky/engine'
import type { FileAttachment, SessionSnapshot } from '@pixelsky/protocol'
import { supportsChatGptDot } from '@pixelsky/protocol'
import type { DotCatalogState, DotEntry } from '../../shared/types/dot-chat'
import { readWindowFile, mergeWindowFile } from './windowFile'

/** 只保存账号引用与 Dot 身份。登录、凭据及刷新全部交给引擎的 Codex 账号库。 */
export class DotChatSessions {
  private entries: DotEntry[] = []
  private sessions: Record<string, string> = {}
  private errors: string[] = []
  private eligible = false
  private refreshing: Promise<DotCatalogState> | null = null
  private readonly file: string
  private readonly knownFiles = new Map<string, Set<string>>()
  private readonly selected = new Map<string, Map<string, FileAttachment>>()
  constructor(
    private readonly host: EngineHost,
    private readonly root: string,
  ) {
    this.file = join(root, 'dot-chats.json')
    const saved = readWindowFile(this.file)
    if (Array.isArray(saved.entries))
      this.entries = saved.entries.filter(
        (v): v is DotEntry =>
          !!v &&
          typeof v === 'object' &&
          ['key', 'account', 'accountName', 'id', 'threadId', 'name', 'status'].every(k => typeof v[k] === 'string'),
      )
    if (saved.sessions && typeof saved.sessions === 'object')
      this.sessions = Object.fromEntries(
        Object.entries(saved.sessions).filter(([, id]) => typeof id === 'string'),
      ) as Record<string, string>
  }
  catalog(refresh = false): Promise<DotCatalogState> {
    if (!refresh) return Promise.resolve({ eligible: this.eligible, entries: this.entries, errors: this.errors })
    return (this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null
    }))
  }
  private async refresh(): Promise<DotCatalogState> {
    const accounts = (await this.host.accounts('codex')).accounts.filter(a => supportsChatGptDot(a.plan))
    this.eligible = accounts.length > 0
    const entries: DotEntry[] = []
    const errors: string[] = []
    // 限制并发：一个账号刷新失败不影响其它账号，避免同时启动很多 app-server。
    for (const account of accounts) {
      const accountName = account.label || account.email || account.id
      try {
        const profiles = await this.host.dotCatalog(account.id)
        for (const profile of profiles) {
          const key = createHash('sha256')
            .update(JSON.stringify([account.id, account.email, profile.id]))
            .digest('hex')
            .slice(0, 32)
          entries.push({ ...profile, key, account: account.id, accountName })
        }
      } catch (error) {
        errors.push(`${accountName}: ${error instanceof Error ? error.message : 'Dot unavailable'}`)
        entries.push(...this.entries.filter(e => e.account === account.id).map(e => ({ ...e, status: 'unavailable' })))
      }
    }
    this.entries = entries
    this.errors = errors
    mergeWindowFile(this.file, { entries, sessions: this.sessions })
    return { eligible: this.eligible, entries, errors }
  }
  entry(key: string): DotEntry {
    const entry = this.entries.find(e => e.key === key)
    if (!entry) throw new Error('Saved Dot unavailable; refresh the Dot list')
    return entry
  }
  snapshot(key: string): SessionSnapshot {
    const entry = this.entry(key)
    const id = this.sessions[key]
    const record = id ? this.host.sessions().find(s => s.record.id === id)?.record : null
    if (
      record?.engine === 'dot' &&
      record.dot?.account === entry.account &&
      record.dot.id === entry.id &&
      record.dot.threadId === entry.threadId
    )
      return this.host.open(record.id)
    const path = join(this.root, 'dot-workspace')
    mkdirSync(path, { recursive: true })
    const project = this.host.addProject(path)
    const created = this.host.createSession({
      projectId: project.id,
      engine: 'dot',
      dot: { account: entry.account, id: entry.id, threadId: entry.threadId },
      platform: null,
      provider: null,
      model: null,
      effort: null,
      permissionMode: 'ask',
      rememberChoices: false,
    })
    this.host.renameSession(created.id, `${entry.name} · ${entry.accountName}`)
    this.sessions[key] = created.id
    mergeWindowFile(this.file, { entries: this.entries, sessions: this.sessions })
    return this.host.open(created.id)
  }
  async send(key: string, sessionId: unknown, text: unknown, fileIds: unknown = []): Promise<void> {
    if (typeof text !== 'string' || text.length > 100_000) throw new Error('Invalid Dot message')
    if (!Array.isArray(fileIds) || fileIds.length > 10 || fileIds.some(id => typeof id !== 'string'))
      throw new Error('Invalid Dot attachments')
    const files = fileIds.map(id => {
      const file = this.selected.get(key)?.get(id)
      if (!file) throw new Error('Dot attachment unavailable; select it again')
      return file
    })
    if (!text.trim() && !files.length) throw new Error('Invalid Dot message')
    const snapshot = this.snapshot(key)
    if (snapshot.record.id !== sessionId) throw new Error('Dot conversation changed; reload before sending')
    await this.host.send(snapshot.record.id, files.length ? { text, files, clientMessageId: randomUUID() } : text)
    for (const id of fileIds) this.selected.get(key)?.delete(id)
  }

  async pickFiles(key: string, paths: string[]) {
    this.entry(key)
    const selected = this.selected.get(key) ?? new Map<string, FileAttachment>()
    this.selected.set(key, selected)
    const next: FileAttachment[] = []
    for (const path of paths.slice(0, 10)) {
      const info = await stat(path)
      if (!info.isFile() || info.size > DOT_FILE_LIMIT)
        throw new Error('Dot attachment exceeds 20 MiB or is not a file')
      next.push({
        id: randomUUID(),
        name: basename(path),
        bytes: info.size,
        path,
        pathOnly: true,
        lines: 0,
        encoding: 'utf-8',
        text: '',
      })
    }
    // 限制每个窗口尚未发送的本地引用，路径不传给 renderer。
    for (const file of next) selected.set(file.id, file)
    while (selected.size > 50) selected.delete(selected.keys().next().value!)
    return next.map(({ id, name, bytes }) => ({ id, name, bytes }))
  }

  async download(key: string, fileId: unknown, signal?: AbortSignal) {
    if (typeof fileId !== 'string' || !this.knownFiles.get(key)?.has(fileId))
      throw new Error('Dot file is not in this conversation')
    const entry = this.entry(key)
    return this.host.downloadDotFile(entry.account, entry, fileId, signal)
  }

  async computerOffer(key: string, offer: unknown, signal?: AbortSignal) {
    if (typeof offer !== 'string' || offer.length > 256_000 || !offer.startsWith('v=0'))
      throw new Error('Invalid Dot computer offer')
    const entry = this.entry(key)
    return this.host.dotComputerOffer(entry.account, entry, offer, signal)
  }

  release(key: string) {
    this.knownFiles.delete(key)
    this.selected.delete(key)
  }

  async read(key: string, options: { before?: string; overview?: boolean }, signal?: AbortSignal) {
    const entry = this.entry(key)
    const data = await this.host.readDot(entry.account, entry, options, signal)
    const known = this.knownFiles.get(key) ?? new Set<string>()
    for (const message of data.history.items)
      for (const file of message.attachments) if (file.type === 'file' && file.fileId) known.add(file.fileId)
    while (known.size > 2000) known.delete(known.values().next().value!)
    this.knownFiles.set(key, known)
    return { ...data, entry: { ...entry, ...data.overview?.profile } }
  }
}
