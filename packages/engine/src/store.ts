// 项目、会话记录、对话条目的保存（docs/engines.md §8）
//
// <dataDir>/projects.json              项目列表
// <dataDir>/engine-settings.json       新会话默认设置、各引擎的路径 / 环境变量 / 默认值 / 选项
// <dataDir>/sessions/<id>/record.json  会话记录
// <dataDir>/sessions/<id>/items.jsonl  对话条目，每行一个，只追加：开始时写一次，完成（或一轮结束收尾）时再写一次，
//                                      读出时同一 id 取第一次的位置、最后一次的内容
//
// 写入都是同步的小文件操作：保证顺序，量也很小（只在条目开始 / 完成时写，不写流式增量）。
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  EngineDefaults,
  EngineId,
  Item,
  ProjectRecord,
  QueueSummary,
  SessionDefaults,
  SessionRecord,
} from '@pixelsky/protocol'
import { isQuietWarning } from '@pixelsky/protocol'
import { messageInput, type QueueFile } from './queue'
import { retryLimit } from './retry'
import { removeTree } from './exec'

const VERSION = 1

export interface EngineSettingsFile {
  maxRetries: number | null
  defaults: EngineDefaults
  /** 各引擎替换的命令：绝对路径或 PATH 上的命令名（docs/ui/engine-launch.md） */
  paths: Partial<Record<EngineId, string>>
  /** 各引擎追加的环境变量 */
  env: Partial<Record<EngineId, Record<string, string>>>
  /** 各引擎压缩上下文用的模型 */
  compactModels: Partial<Record<EngineId, string>>
  /** 各引擎的新会话默认值；没有时用 defaults 里的（旧版只有一份全局默认，docs/ui/engine-settings-redesign.md §4） */
  engineDefaults: Partial<Record<EngineId, SessionDefaults>>
  /** 各引擎的对话 / 上下文 / 菜单选项 */
  options: Partial<Record<EngineId, EngineOptions>>
}

/** 设置 › 本机引擎 › 详情里的引擎级选项；没写的项用默认值 */
export interface EngineOptions {
  outputStyle?: string
  /** 只存 false（关掉提问） */
  askQuestions?: boolean
  autoCompactPct?: number
  /** 每个模型的上下文窗口，按额度来源分开（GitHub #20）；只存填了的 */
  contextWindows?: { platform?: Record<string, number>; self?: Record<string, number> }
  hidden?: boolean
  /** 每次启动引擎进程时追加的参数（docs/ui/engine-launch.md）；只存非空 */
  args?: string[]
  /** 会话里改推理强度那几项时也记成默认值（GitHub #6）；只存 true */
  rememberChoices?: boolean
  /** Claude Code 接收其他 Claude Code 会话发来的消息；只存 true */
  peerMessages?: boolean
  /** 让 AI 只读地查看本机其他会话的范围；只存 project / all */
  peekSessions?: 'project' | 'all'
}

export const DEFAULT_SETTINGS: EngineSettingsFile = {
  maxRetries: null,
  defaults: {
    engine: 'claude',
    model: null,
    effort: 'high',
    permissionMode: 'edits',
    ultracode: false,
    fast: false,
    thinkingSummaries: true,
  },
  paths: {},
  env: {},
  compactModels: {},
  engineDefaults: {},
  options: {},
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * 改名替换目标文件。Windows 上目标正被别的句柄打开（同时在读、杀毒软件扫描）时会短暂报 EPERM / EBUSY / EACCES，
 * 稍等几毫秒重试即可；重试几次还不行再抛出。
 */
function replaceFile(tmp: string, file: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1))
    }
  }
}

/** 先写临时文件再改名，写到一半断电也不会留下坏文件 */
function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  replaceFile(tmp, file)
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** 文件最后一个字节不是换行（写到一半断电留下的坏行）；文件不存在或是空的算 false */
function endsMidLine(file: string): boolean {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return false
  }
  try {
    const { size } = fstatSync(fd)
    if (!size) return false
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } finally {
    closeSync(fd)
  }
}

export class Store {
  /** 本进程里已经核对过 items.jsonl 结尾的会话 */
  private readonly appendChecked = new Set<string>()

  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
  }

  private sessionDir(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`会话 id 不合法：${id}`)
    return join(this.dir, 'sessions', id)
  }

  /** 订阅账号（docs/ui/engine-accounts.md）：用户可改的 JSON，读的一方再校验 */
  loadAccounts(): unknown {
    return readJson<unknown>(join(this.dir, 'engine-accounts.json'))
  }

  saveAccounts(data: unknown): void {
    writeJson(join(this.dir, 'engine-accounts.json'), data)
  }

  loadProjects(): ProjectRecord[] {
    const data = readJson<{ projects?: ProjectRecord[] }>(join(this.dir, 'projects.json'))
    return Array.isArray(data?.projects) ? data.projects : []
  }

  saveProjects(projects: ProjectRecord[]): void {
    writeJson(join(this.dir, 'projects.json'), { version: VERSION, projects })
  }

  loadSettings(): EngineSettingsFile {
    const data = readJson<Partial<EngineSettingsFile>>(join(this.dir, 'engine-settings.json'))
    let maxRetries: number | null = null
    try {
      maxRetries = retryLimit(data?.maxRetries ?? null)
    } catch {
      /* 旧文件或损坏值恢复跟随引擎 */
    }
    return {
      maxRetries,
      defaults: { ...DEFAULT_SETTINGS.defaults, ...(data?.defaults ?? {}) },
      paths: { ...(data?.paths ?? {}) },
      env: { ...(data?.env ?? {}) },
      compactModels: { ...(data?.compactModels ?? {}) },
      engineDefaults: { ...(data?.engineDefaults ?? {}) },
      options: { ...(data?.options ?? {}) },
    }
  }

  saveSettings(settings: EngineSettingsFile): void {
    writeJson(join(this.dir, 'engine-settings.json'), { version: VERSION, ...settings })
  }

  loadRecords(): SessionRecord[] {
    const out: SessionRecord[] = []
    let names: string[]
    try {
      names = readdirSync(join(this.dir, 'sessions'))
    } catch {
      return out
    }
    for (const name of names) {
      if (!SAFE_ID.test(name)) continue
      const rec = readJson<SessionRecord>(join(this.dir, 'sessions', name, 'record.json'))
      // 旧版本保存的记录没有 ultracode 字段
      if (rec && rec.id === name) {
        out.push({
          ...rec,
          bottomedAt:
            typeof rec.bottomedAt === 'number' && Number.isFinite(rec.bottomedAt) && rec.bottomedAt > 0
              ? rec.bottomedAt
              : null,
          pinnedAt:
            typeof rec.pinnedAt === 'number' && Number.isFinite(rec.pinnedAt) && rec.pinnedAt > 0 ? rec.pinnedAt : null,
          titleEdited: rec.titleEdited === true,
          archivedAt: typeof rec.archivedAt === 'number' && Number.isFinite(rec.archivedAt) ? rec.archivedAt : null,
          ultracode: rec.ultracode === true,
          fast: rec.fast === true,
          thinkingSummaries: rec.thinkingSummaries !== false,
        })
      }
    }
    return out
  }

  saveRecord(record: SessionRecord): void {
    const dir = this.sessionDir(record.id)
    mkdirSync(dir, { recursive: true })
    writeJson(join(dir, 'record.json'), record)
  }

  appendItem(sessionId: string, item: Item): void {
    const dir = this.sessionDir(sessionId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'items.jsonl')
    // 每个会话本进程第一次追加前看一眼结尾：上次写坏的最后一行没有换行，先补一个，免得新的一条接在后面一起读不出来
    let lead = ''
    if (!this.appendChecked.has(sessionId)) {
      this.appendChecked.add(sessionId)
      if (endsMidLine(file)) lead = '\n'
    }
    try {
      appendFileSync(file, lead + JSON.stringify(item) + '\n', 'utf8')
    } catch (err) {
      // 写了一半就失败（磁盘满）：下次追加再看一眼结尾
      this.appendChecked.delete(sessionId)
      throw err
    }
  }

  loadQueue(record: SessionRecord): QueueFile {
    const raw = readJson<QueueFile & { version?: number }>(join(this.sessionDir(record.id), 'queue.json'))
    if (!raw || raw.version !== 1 || !Array.isArray(raw.items)) return { items: [], paused: false, receipts: [] }
    const items = raw.items.flatMap(item => {
      try {
        const input = messageInput(
          {
            text: item.text,
            clientMessageId: item.id,
            attachments: item.attachments,
            files: item.files,
            settings: item.settings,
          },
          record,
          () => item.id,
        )
        const settled = item.status === 'queued' || item.status === 'failed' || item.status === 'uncertain'
        // 断线自动重连（docs/ui/message-queue.md）：
        // - 还在等的（queued）保留，整体暂停（下面 paused），界面显示「已暂停」，点「继续重连」才接着连；
        // - 派发中 / 运行中的转「待核对」（不知道有没有发出去），去掉重连标记，记下已自动重连的次数；
        // - 旧数据没有 delivered：有重连标记时由 resend / messageUuid 推出来（!resend 且有 messageUuid），否则不填
        const reconnect = item.reconnect
        const delivered =
          typeof item.delivered === 'boolean'
            ? item.delivered
            : reconnect
              ? !reconnect.resend && !!item.messageUuid
              : undefined
        return [
          {
            ...item,
            id: input.clientMessageId,
            text: input.text,
            files: input.files,
            settings: input.settings,
            status: settled ? item.status : ('uncertain' as const),
            mode: item.mode === 'guidance' ? ('guidance' as const) : ('normal' as const),
            error: settled ? (item.error ?? null) : '上次退出前已开始交付，请核对后再重试',
            ...(delivered === undefined ? {} : { delivered }),
            ...(!settled && reconnect
              ? {
                  reconnect: undefined,
                  limit: undefined,
                  reconnected: Math.max(0, (reconnect.total ?? reconnect.attempt) - 1),
                }
              : {}),
            // 旧版本可能把重连项存成 held：整体已暂停，界面要显示「已暂停」卡片，所以去掉 held
            ...(settled && reconnect && item.held ? { held: false } : {}),
          },
        ]
      } catch {
        return []
      }
    })
    return { items, paused: items.length > 0, receipts: Array.isArray(raw.receipts) ? raw.receipts.slice(-256) : [] }
  }

  /** 不启动会话，只看已保存的队列有多少条、是否暂停（与 loadQueue 一致：重启后有排队就是暂停） */
  peekQueue(id: string): QueueSummary | null {
    const raw = readJson<QueueFile & { version?: number }>(join(this.sessionDir(id), 'queue.json'))
    if (!raw || raw.version !== 1 || !Array.isArray(raw.items) || raw.items.length === 0) return null
    const failed = raw.items.filter(item => item.status === 'failed' || item.status === 'uncertain').length
    return { queued: raw.items.length - failed, failed, paused: true }
  }

  saveQueue(id: string, queue: QueueFile): void {
    const dir = this.sessionDir(id)
    mkdirSync(dir, { recursive: true })
    writeJson(join(dir, 'queue.json'), { version: 1, ...queue })
  }

  /** 回退：用保留的条目原子重写对话记录（先写临时文件再改名） */
  replaceItems(sessionId: string, items: Item[]): void {
    const dir = this.sessionDir(sessionId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'items.jsonl'),
      tmp = `${file}.tmp`
    writeFileSync(tmp, items.map(item => JSON.stringify(item) + '\n').join(''), 'utf8')
    replaceFile(tmp, file)
  }

  /**
   * 只读每轮的统计条目（turn_stats）：后台补录实扣用，流式读、只解析含 turn_stats 的行，
   * 不把整个对话（可能上百 MB、带图片）读进来解析（docs/perf-audit-2026-10-18.md B8）。同一个 id 取最后一次的内容
   */
  async loadTurnStats(sessionId: string): Promise<Extract<Item, { kind: 'turn_stats' }>[]> {
    const file = join(this.sessionDir(sessionId), 'items.jsonl')
    if (!existsSync(file)) return []
    const byId = new Map<string, Extract<Item, { kind: 'turn_stats' }>>()
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (!line.includes('"turn_stats"')) continue
        try {
          const item = JSON.parse(line) as Item
          if (item?.kind === 'turn_stats' && typeof item.id === 'string') byId.set(item.id, item)
        } catch {
          // 跳过写坏的行
        }
      }
    } catch {
      // 读到一半出错（文件被删）：用已经读到的
    }
    return [...byId.values()]
  }

  /** 读出全部条目；同一个 id 出现多次时保留第一次的位置、最后一次的内容 */
  loadItems(sessionId: string): Item[] {
    const file = join(this.sessionDir(sessionId), 'items.jsonl')
    if (!existsSync(file)) return []
    const byId = new Map<string, Item>()
    eachLine(file, line => {
      if (!line.trim()) return
      try {
        const item = JSON.parse(line) as Item
        if (item && typeof item.id === 'string') byId.set(item.id, item)
      } catch {
        // 跳过写坏的行（例如写到一半断电）
      }
    })
    // 没等到完成的条目（进程退出、应用关闭，包括后台子智能体的）：标成已中断。
    // 以前存下的配置类警告（docs/ui/ai-commit-codex-warnings-history.md §3）现在不进对话：去掉
    const items: Item[] = []
    for (const item of byId.values()) {
      if (item.kind === 'notice' && item.level !== 'error' && isQuietWarning(item.text)) continue
      if (item.kind !== 'user' && item.kind !== 'notice' && item.kind !== 'turn_stats' && item.status === 'running')
        items.push({ ...item, status: 'interrupted' })
      else items.push(item)
    }
    return items
  }

  deleteSession(id: string): void {
    removeTree(this.sessionDir(id))
  }

  /** 对话检查点的影子 Git 仓库（docs/ui/undo-changes.md §2），删会话时一起删 */
  checkpointDir(id: string): string {
    return join(this.sessionDir(id), 'checkpoints')
  }

  loadCheckpoints(id: string): unknown {
    return readJson<unknown>(join(this.sessionDir(id), 'checkpoints.json'))
  }

  saveCheckpoints(id: string, data: unknown): void {
    const dir = this.sessionDir(id)
    mkdirSync(dir, { recursive: true })
    writeJson(join(dir, 'checkpoints.json'), data)
  }
}

/**
 * 按行读文件：一块一块读、按换行切，不把整个文件读成一个字符串
 * （V8 单个字符串上限约 512 MB，跑了很久的对话 items.jsonl 会超过，整份读会报 ERR_STRING_TOO_LONG 打不开）
 */
export function eachLine(file: string, fn: (line: string) => void, chunk = 16 << 20): void {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(chunk)
    let parts: Buffer[] = []
    for (let n: number; (n = readSync(fd, buf, 0, chunk, null)) > 0; ) {
      let start = 0
      // 换行符 0x0A 不会出现在 UTF-8 多字节字符中间，按字节切安全
      for (let i = buf.indexOf(10); i !== -1 && i < n; i = buf.indexOf(10, start)) {
        parts.push(buf.subarray(start, i))
        fn(Buffer.concat(parts).toString('utf8'))
        parts = []
        start = i + 1
      }
      // 下一块会复用 buf：没切完的那段拷出来
      if (start < n) parts.push(Buffer.from(buf.subarray(start, n)))
    }
    if (parts.length) fn(Buffer.concat(parts).toString('utf8'))
  } finally {
    closeSync(fd)
  }
}
