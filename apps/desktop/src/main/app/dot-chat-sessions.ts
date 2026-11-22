import { createHash, randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, sep } from 'node:path'
import { DOT_FILE_LIMIT } from '@pixelsky/engine'
import type { EngineHost } from '@pixelsky/engine'
import type { FileAttachment, SessionSnapshot } from '@pixelsky/protocol'
import { CHAT_PROJECT_ID, supportsChatGptDot } from '@pixelsky/protocol'
import type { DotChatMessage } from '@pixelsky/engine'
import type { DotCatalogState, DotChatChange, DotEntry } from '../../shared/types/dot-chat'
import { safeFileName } from '../../shared/safeFileName'
import { readWindowFile, mergeWindowFile } from './windowFile'

/** 界面这么久内读过这个 Dot，后台就不再查 */
export const DOT_POLL_SKIP_MS = 50_000
/** 粘贴进来的内容按 base64 传：20 MiB 对应的长度上限 */
const BASE64_LIMIT = Math.ceil(DOT_FILE_LIMIT / 3) * 4

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
  /** 看过的最新一条 Dot 消息的时间（键 → createdAt），存盘；没有记录的第一次读当基线 */
  private seen: Record<string, number> = {}
  /** 有没看过的新消息的 Dot：键 → 那条消息的 id */
  private readonly unread = new Map<string, { id: string; createdAt: number }>()
  private readonly readAt = new Map<string, number>()
  /** 粘贴进来存成的临时文件夹：键 → 目录 */
  private readonly temps = new Map<string, Set<string>>()
  private polling = false
  /** 未读变了（主进程广播给界面） */
  onChange: ((change: DotChatChange) => void) | null = null
  constructor(
    private readonly host: EngineHost,
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(root, 'dot-chats.json')
    // 上次运行留下的粘贴临时文件：没发出去的已经没用了
    try {
      rmSync(this.uploads(), { recursive: true, force: true })
    } catch {
      /* 删不掉就留着，下次再删 */
    }
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
    if (saved.seen && typeof saved.seen === 'object')
      this.seen = Object.fromEntries(
        Object.entries(saved.seen).filter(([, at]) => typeof at === 'number' && Number.isFinite(at)),
      ) as Record<string, number>
  }
  private uploads(): string {
    return join(this.root, 'dot-uploads')
  }
  private save(): void {
    mergeWindowFile(this.file, { entries: this.entries, sessions: this.sessions, seen: this.seen })
  }
  private state(): DotCatalogState {
    return { eligible: this.eligible, entries: this.entries, errors: this.errors, unread: [...this.unread.keys()] }
  }
  catalog(refresh = false): Promise<DotCatalogState> {
    if (!refresh) return Promise.resolve(this.state())
    return (this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null
    }))
  }
  private async refresh(): Promise<DotCatalogState> {
    const candidates = (await this.host.accounts('codex')).accounts.filter(
      a => a.status !== 'expired' && supportsChatGptDot(a.plan),
    )
    const entries: DotEntry[] = []
    const errors: string[] = []
    let eligible = false
    // 逐个账号来：一个账号刷新失败不影响其它账号，避免同时启动很多 app-server。
    for (const account of candidates) {
      // 列表里记的套餐可能是旧的（登出、降到 Plus）：本机读得到 Pro 的登录才算，没登录的账号不列它的 Dot
      if (!(await this.host.dotSignedIn(account.id))) continue
      eligible = true
      const accountName = account.label || account.email || account.id
      try {
        const profiles = await this.host.dotCatalog(account.id)
        for (const profile of profiles) {
          // 不含邮箱：账号改了邮箱还是同一个对话
          const key = createHash('sha256')
            .update(JSON.stringify([account.id, profile.id]))
            .digest('hex')
            .slice(0, 32)
          entries.push({ ...profile, key, account: account.id, accountName })
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Dot unavailable')
        entries.push(...this.entries.filter(e => e.account === account.id).map(e => ({ ...e, status: 'unavailable' })))
      }
    }
    this.eligible = eligible
    this.entries = entries
    this.errors = errors
    // 不在列表里的 Dot（登出、降档）不再算未读
    for (const key of [...this.unread.keys()]) if (!entries.some(e => e.key === key)) this.unread.delete(key)
    this.save()
    return this.state()
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
    // 挂在「对话」下面（不建项目）：侧栏、看板、搜索都不列 Dot 会话，只在侧栏的 Dot 组里打开
    const created = this.host.createSession({
      projectId: CHAT_PROJECT_ID,
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
    this.save()
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

  /**
   * 拖进来、粘贴的文件（docs/ui/dot-optimize.md §7 #5）：有本机路径的直接登记；只有内容的（剪贴板截图）
   * 写到 <数据目录>/dot-uploads/<随机>/ 再登记，关窗口或下次启动时删
   */
  async addFiles(key: string, raw: unknown) {
    this.entry(key)
    if (!Array.isArray(raw) || !raw.length || raw.length > 10) throw new Error('Invalid Dot file drop')
    const paths: string[] = []
    for (const item of raw) {
      const file = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      if (typeof file.path === 'string') {
        if (!isAbsolute(file.path) || file.path.length > 4096 || file.path.includes('\0'))
          throw new Error('Invalid Dot file drop')
        paths.push(file.path)
      } else if (typeof file.name === 'string' && typeof file.dataBase64 === 'string') {
        if (file.dataBase64.length > BASE64_LIMIT) throw new Error('Dot attachment exceeds 20 MiB')
        const dir = join(this.uploads(), randomUUID())
        await mkdir(dir, { recursive: true })
        const temps = this.temps.get(key) ?? new Set<string>()
        this.temps.set(key, temps.add(dir))
        const path = join(dir, safeFileName(basename(file.name.replaceAll('\\', '/')), 120, 'attachment'))
        await writeFile(path, Buffer.from(file.dataBase64, 'base64'))
        paths.push(path)
      } else throw new Error('Invalid Dot file drop')
    }
    return this.pickFiles(key, paths)
  }

  release(key: string) {
    this.knownFiles.delete(key)
    this.selected.delete(key)
    // Dot 忙时发的消息还排着（docs/ui/dot-optimize.md §9）：它带的粘贴文件要留到发出去，下次启动时再一起删
    const queued = this.queuedPaths(key)
    for (const dir of this.temps.get(key) ?? [])
      if (!queued.some(path => path.startsWith(dir + sep)))
        void rm(dir, { recursive: true, force: true }).catch(() => undefined)
    this.temps.delete(key)
  }

  /** 这个 Dot 的会话里还没发出去的消息带的本机文件 */
  private queuedPaths(key: string): string[] {
    const id = this.sessions[key]
    if (!id) return []
    try {
      return (this.host.open(id).queue ?? [])
        .filter(q => q.status === 'queued' || q.status === 'dispatching' || q.status === 'delivering')
        .flatMap(q => (q.files ?? []).flatMap(file => (file.path ? [file.path] : [])))
    } catch {
      return []
    }
  }

  /**
   * 记下这次读到的最新一条 Dot 消息（docs/ui/dot-optimize.md §7 #3）。seen：用户正看着，算看过；
   * 没有记录的第一次读当基线，不算未读。比看过的新就记未读并通知界面；这条如果是本轮回复里已经收到的
   * （会话里有 dot-<id>，那一轮结束时提醒过了），只出未读点、不带 notice
   */
  private track(
    entry: DotEntry,
    items: readonly DotChatMessage[],
    seen: boolean,
    alreadyVisible?: { id: string; createdAt: number },
  ): void {
    const key = entry.key
    this.readAt.set(key, this.now())
    const latest = items.findLast(m => m.role === 'assistant')
    const unread = this.unread.get(key)
    const known = this.seen[key]
    if (seen || known === undefined) {
      const observed = latest ?? (seen && unread === alreadyVisible ? alreadyVisible : undefined)
      if (!observed) return
      const observedAt = observed.createdAt
      if (known === undefined || observedAt > known) {
        this.seen[key] = observedAt
        this.save()
      }
      if (unread && (unread.id === observed.id || unread.createdAt < observedAt) && this.unread.delete(key))
        this.onChange?.({ unread: [...this.unread.keys()] })
      return
    }
    if (
      !latest ||
      latest.createdAt <= known ||
      (unread && (unread.id === latest.id || unread.createdAt > latest.createdAt))
    )
      return
    this.unread.set(key, { id: latest.id, createdAt: latest.createdAt })
    const sessionId = this.sessions[key]
    const delivered = !!sessionId && !!this.host.item(sessionId, `dot-${latest.id}`)
    this.onChange?.({
      unread: [...this.unread.keys()],
      ...(sessionId && !delivered
        ? { notice: { key, sessionId, name: entry.name, messageId: latest.id, preview: latest.text.slice(0, 200) } }
        : {}),
    })
  }

  /**
   * 后台查新消息：只查在应用里打开过的 Dot；会话正在回复（消息由会话事件带来）、界面刚读过的跳过。
   * 一次只跑一轮，出错不报（下一轮再查）
   */
  async poll(): Promise<void> {
    if (!this.eligible || this.polling) return
    this.polling = true
    try {
      const busy = new Set(
        this.host
          .sessions()
          .filter(s => s.state !== 'idle')
          .map(s => s.record.id),
      )
      for (const entry of this.entries) {
        const sessionId = this.sessions[entry.key]
        if (!sessionId || entry.status === 'unavailable' || busy.has(sessionId)) continue
        if (this.now() - (this.readAt.get(entry.key) ?? 0) < DOT_POLL_SKIP_MS) continue
        await this.read(entry.key, {}).catch(() => undefined)
      }
    } finally {
      this.polling = false
    }
  }

  async read(
    key: string,
    options: { before?: string; after?: string; overview?: boolean; overviewOnly?: boolean; seen?: boolean },
    signal?: AbortSignal,
  ) {
    const entry = this.entry(key)
    const unreadBeforeRead = this.unread.get(key)
    const data = await this.host.readDot(
      entry.account,
      entry,
      { before: options.before, after: options.after, overview: options.overview, overviewOnly: options.overviewOnly },
      signal,
    )
    if (!options.before && !options.overviewOnly)
      this.track(
        entry,
        data.history.items,
        options.seen === true,
        options.after && data.history.latest === options.after && !data.history.items.length
          ? unreadBeforeRead
          : undefined,
      )
    const known = this.knownFiles.get(key) ?? new Set<string>()
    for (const message of data.history.items)
      for (const file of message.attachments) if (file.type === 'file' && file.fileId) known.add(file.fileId)
    while (known.size > 2000) known.delete(known.values().next().value!)
    this.knownFiles.set(key, known)
    return { ...data, entry: { ...entry, ...data.overview?.profile } }
  }
}
