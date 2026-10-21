// 协作频道的本机存储（docs/ui/channels-phase-b.md §10）。数据都读进内存，改动按顺序写盘：
//   members.json                全局 AI 成员
//   runs.json                   每项活这一轮的运行信息（重启后对账）
//   <频道 id>/channel.json       频道信息、成员、已读位置
//   <频道 id>/messages.jsonl     消息，只追加；任务卡的变化追加 { kind: 'task_update', id, patch }，读的时候合并
//   <频道 id>/attachments/<消息 id>.json  消息带的图片和文件全文（消息里只有说明，按需读）
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentConfig, ChannelAttachments, ChannelMessage, ChannelTask } from '../../../shared/types/channels'
import type { TaskRun } from './tracker'

import type { ChannelNotify } from '../../../shared/types/channels'

export interface StoredChannel {
  id: string
  name: string
  topic: string | null
  projectId: string | null
  /** 'you' 和 AI 成员的 id */
  memberIds: string[]
  /** 频道说明：每次派活都带上（docs/ui/channels-local-ai.md §3.1 #9）；旧数据没有 */
  notes?: string | null
  /** 置顶的消息 id（先后顺序），派活时作为资料带上；旧数据没有 */
  pinned?: string[]
  /** 系统提醒级别；旧数据没有（= all） */
  notify?: ChannelNotify
  /** 归档的时间；旧数据没有（= 没归档） */
  archivedAt?: number | null
  createdAt: number
  /** 看到哪里了：这之后别人发的算未读 */
  readAt: number
}

interface TaskUpdate {
  kind: 'task_update'
  id: string
  patch: Partial<ChannelTask>
}

const ID = /^[A-Za-z0-9-]{1,64}$/

/** 任务卡上只在内存里、不写盘的字段：进度、待确认请求、正在做什么（追加和整理压缩一致） */
const MEMORY_ONLY = ['progress', 'request', 'activity'] as const

/** 去掉只在内存里的字段（追加 task_update 和整理压缩共用） */
function persisted<T extends Partial<ChannelTask>>(task: T): T {
  const saved = { ...task }
  for (const key of MEMORY_ONLY) delete saved[key]
  return saved
}

/** jsonl 的一行 → 合并进消息列表；坏行跳过（写到一半断电） */
function mergeLine(list: ChannelMessage[], index: Map<string, number>, line: string): void {
  let row: ChannelMessage | TaskUpdate
  try {
    row = JSON.parse(line) as ChannelMessage | TaskUpdate
  } catch {
    return
  }
  if (!row || typeof row !== 'object' || typeof row.id !== 'string') return
  if (row.kind === 'task_update') {
    const i = index.get(row.id)
    if (i !== undefined && list[i].kind === 'task') list[i] = { ...list[i], ...row.patch } as ChannelTask
    return
  }
  const i = index.get(row.id)
  if (i !== undefined) list[i] = row
  else {
    index.set(row.id, list.length)
    list.push(row)
  }
}

export class ChannelStore {
  members: AgentConfig[] = []
  readonly channels = new Map<string, StoredChannel>()
  readonly messages = new Map<string, ChannelMessage[]>()
  readonly runs = new Map<string, TaskRun>()
  /** 频道 id → messages.jsonl 现在有几行（超过消息数两倍时整理） */
  private readonly lines = new Map<string, number>()
  private readonly index = new Map<string, Map<string, number>>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    this.members = await this.readJson<AgentConfig[]>(join(this.dir, 'members.json'), [])
    for (const run of await this.readJson<TaskRun[]>(join(this.dir, 'runs.json'), [])) this.runs.set(run.taskId, run)
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue
      const channel = await this.readJson<StoredChannel | null>(join(this.dir, entry.name, 'channel.json'), null)
      if (!channel || channel.id !== entry.name) continue
      this.channels.set(channel.id, channel)
      const list: ChannelMessage[] = [],
        index = new Map<string, number>()
      let count = 0
      const text = await readFile(join(this.dir, channel.id, 'messages.jsonl'), 'utf8').catch(() => '')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        count++
        mergeLine(list, index, line)
      }
      list.sort((a, b) => a.at - b.at)
      this.messages.set(channel.id, list)
      this.index.set(channel.id, new Map(list.map((m, i) => [m.id, i])))
      this.lines.set(channel.id, count)
    }
    // 频道已经删了的活不再跟踪
    for (const [id, run] of this.runs) if (!run.team && !this.channels.has(run.channelId)) this.runs.delete(id)
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T
    } catch {
      return fallback
    }
  }

  /** 写盘按调用顺序排队；一次失败不挡后面的 */
  private write(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.catch(() => {}).then(fn)
    this.queue = next
    return next
  }

  private atomic(file: string, data: unknown): Promise<void> {
    return this.write(async () => {
      const temp = `${file}.${randomUUID()}.tmp`
      await writeFile(temp, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8')
      await rename(temp, file)
    })
  }

  /** 等前面排队的写盘都做完（测试、退出前用） */
  flush(): Promise<void> {
    return this.queue.catch(() => {}).then(() => {})
  }

  saveMembers(): Promise<void> {
    return this.atomic(join(this.dir, 'members.json'), this.members)
  }

  saveRuns(): Promise<void> {
    return this.atomic(join(this.dir, 'runs.json'), [...this.runs.values()])
  }

  async saveChannel(channel: StoredChannel): Promise<void> {
    const fresh = !this.channels.has(channel.id)
    this.channels.set(channel.id, channel)
    if (fresh) {
      this.messages.set(channel.id, [])
      this.index.set(channel.id, new Map())
      this.lines.set(channel.id, 0)
      await this.write(() => mkdir(join(this.dir, channel.id), { recursive: true }).then(() => {}))
    }
    return this.atomic(join(this.dir, channel.id, 'channel.json'), channel)
  }

  deleteChannel(id: string): Promise<void> {
    this.channels.delete(id)
    this.messages.delete(id)
    this.index.delete(id)
    this.lines.delete(id)
    for (const [taskId, run] of this.runs) if (run.channelId === id) this.runs.delete(taskId)
    return this.write(() => rm(join(this.dir, id), { recursive: true, force: true }))
  }

  /** 追加一条消息（按时间插入；同 id 的替换） */
  append(message: ChannelMessage): Promise<void> {
    const list = this.messages.get(message.channelId)
    const index = this.index.get(message.channelId)
    if (!list || !index) return Promise.reject(new Error('频道不存在'))
    const i = index.get(message.id)
    if (i !== undefined) list[i] = message
    else {
      index.set(message.id, list.length)
      list.push(message)
    }
    return this.appendLine(message.channelId, message)
  }

  /** 改任务卡：内存里原地改，磁盘上追加一行 task_update */
  patchTask(channelId: string, id: string, patch: Partial<ChannelTask>): ChannelTask | null {
    const list = this.messages.get(channelId)
    const i = this.index.get(channelId)?.get(id)
    if (!list || i === undefined || list[i].kind !== 'task') return null
    const task = { ...list[i], ...patch } as ChannelTask
    list[i] = task
    // 只在内存里的字段不写盘
    const saved = persisted(patch)
    if (Object.keys(saved).length)
      void this.appendLine(channelId, { kind: 'task_update', id, patch: saved }).catch(() => {})
    return task
  }

  /** 消息带的附件全文另存一个文件（要在 append 那条消息之前写好） */
  async saveAttachments(channelId: string, messageId: string, data: ChannelAttachments): Promise<void> {
    if (!ID.test(channelId) || !ID.test(messageId)) throw new Error('消息不存在')
    const dir = join(this.dir, channelId, 'attachments')
    await this.write(() => mkdir(dir, { recursive: true }).then(() => {}))
    return this.atomic(join(dir, `${messageId}.json`), JSON.stringify(data))
  }

  /** 读不到（没有附件、文件坏了）时两个空数组 */
  async readAttachments(channelId: string, messageId: string): Promise<ChannelAttachments> {
    const none: ChannelAttachments = { images: [], files: [] }
    if (!ID.test(channelId) || !ID.test(messageId)) return none
    await this.flush()
    const data = await this.readJson<Partial<ChannelAttachments> | null>(
      join(this.dir, channelId, 'attachments', `${messageId}.json`),
      null,
    )
    return {
      images: Array.isArray(data?.images) ? data.images : [],
      files: Array.isArray(data?.files) ? data.files : [],
    }
  }

  task(taskId: string): ChannelTask | null {
    const run = this.runs.get(taskId)
    const lists = run ? [this.messages.get(run.channelId) ?? []] : [...this.messages.values()]
    for (const list of lists) for (const m of list) if (m.kind === 'task' && m.id === taskId) return m
    return null
  }

  private appendLine(channelId: string, row: ChannelMessage | TaskUpdate): Promise<void> {
    const file = join(this.dir, channelId, 'messages.jsonl')
    const lines = (this.lines.get(channelId) ?? 0) + 1
    this.lines.set(channelId, lines)
    const list = this.messages.get(channelId) ?? []
    if (lines > list.length * 2 + 50) {
      // 整理：只留合并后的消息；任务卡同样去掉只在内存里的字段
      this.lines.set(channelId, list.length)
      const text = list.map(m => JSON.stringify(m.kind === 'task' ? persisted(m) : m) + '\n').join('')
      return this.atomic(file, text)
    }
    return this.write(() => appendFile(file, JSON.stringify(row) + '\n', 'utf8'))
  }
}
