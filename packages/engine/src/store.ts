// 项目、会话记录、对话条目的保存（docs/engines.md §8）
//
// <dataDir>/projects.json              项目列表
// <dataDir>/engine-settings.json       新会话默认设置、各引擎的路径 / 环境变量 / 默认值 / 选项
// <dataDir>/sessions/<id>/record.json  会话记录
// <dataDir>/sessions/<id>/items.jsonl  对话条目，每行一个，只追加：开始时写一次，完成（或一轮结束收尾）时再写一次，
//                                      读出时同一 id 取第一次的位置、最后一次的内容
// <dataDir>/sessions/<id>/items.undo.jsonl  回退前的条目文件（硬链接），撤销回退时从它补回截掉的大字段
//
// 写入都是同步的小文件操作：保证顺序，量也很小（只在条目开始 / 完成时写，不写流式增量）。
// 载入的条目截掉了图片数据、长输出只留头尾（cutItem，docs/session-memory.md）；磁盘上永远是完整内容：写截过的条目前先按 id 读回补全。
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type {
  Effort,
  EngineDefaults,
  EngineId,
  Item,
  ProjectRecord,
  QueueSummary,
  SessionDefaults,
  SessionRecord,
} from '@pixelsky/protocol'
import { cutItem, isQuietWarning, parseSubagentOverrides, withBodies } from '@pixelsky/protocol'
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
  /** 只存 false（关掉自动列计划，docs/ui/progress-card.md §10） */
  autoPlan?: boolean
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
  /** Codex 子智能体的模型和推理强度（docs/ui/codex-subagent-model.md）；只存指定了的 */
  subagentModel?: string
  subagentEffort?: Effort
  /** Codex 输入预测；只存 cheap / same */
  inputPrediction?: 'cheap' | 'same'
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

const ITEMS = 'items.jsonl'
const UNDO = 'items.undo.jsonl'
const LOST = '条目内容读不回来，没有写入'

/** 一行在条目文件里的字节起点和长度（不含换行） */
type Line = [offset: number, length: number]

/** 读出时的单条变换：没等到完成的标成已中断；以前存下的配置类警告返回 null（不进对话） */
function loaded(item: Item): Item | null {
  // docs/ui/ai-commit-codex-warnings-history.md §3
  if (item.kind === 'notice' && item.level !== 'error' && isQuietWarning(item.text)) return null
  // 进程退出、应用关闭时没等到完成的（包括后台子智能体的）
  if (item.kind !== 'user' && item.kind !== 'notice' && item.kind !== 'turn_stats' && item.status === 'running')
    return { ...item, status: 'interrupted' }
  return item
}

/** 按位置读一行并解析；文件打不开、读不全、解析失败返回 null。fds 按路径复用读句柄，调用方负责关 */
function readLine(file: string, [offset, length]: Line, fds: Map<string, number>): Item | null {
  try {
    let fd = fds.get(file)
    if (fd === undefined) fds.set(file, (fd = openSync(file, 'r')))
    const buf = Buffer.alloc(length)
    if (readSync(fd, buf, 0, length, offset) !== length) return null
    return JSON.parse(buf.toString('utf8')) as Item
  } catch {
    return null
  }
}

function closeAll(fds: Map<string, number>): void {
  for (const fd of fds.values()) closeSync(fd)
}

export class Store {
  /** 本进程里已经核对过 items.jsonl 结尾的会话 */
  private readonly appendChecked = new Set<string>()
  /**
   * 已载入（loadItems 过）的会话：每个条目 id 最后一行在 items.jsonl 里的位置，body() 按它读回截掉的大字段。
   * 没有这一项的会话不记位置（追加时不建）
   */
  private readonly lines = new Map<string, Map<string, Line>>()
  /** 回退时留下的 items.undo.jsonl 里的位置（replaceItems keepOld），撤销回退时补全用 */
  private readonly undoLines = new Map<string, Map<string, Line>>()

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
          ...(rec.subagentOverrides ? { subagentOverrides: parseSubagentOverrides(rec.subagentOverrides) } : {}),
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

  /** 追加一行；截过的条目先从磁盘补全，补不全抛错、不写。已载入的会话记下新行的位置 */
  appendItem(sessionId: string, item: Item): void {
    const full = this.body(sessionId, item)
    if (!full) throw new Error(LOST)
    const dir = this.sessionDir(sessionId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, ITEMS)
    // 每个会话本进程第一次追加前看一眼结尾：上次写坏的最后一行没有换行，先补一个，免得新的一条接在后面一起读不出来
    let lead = ''
    if (!this.appendChecked.has(sessionId)) {
      this.appendChecked.add(sessionId)
      if (endsMidLine(file)) lead = '\n'
    }
    try {
      const line = JSON.stringify(full)
      const fd = openSync(file, 'a')
      try {
        const offset = fstatSync(fd).size + lead.length
        writeFileSync(fd, lead + line + '\n', 'utf8')
        this.lines.get(sessionId)?.set(full.id, [offset, Buffer.byteLength(line)])
      } finally {
        closeSync(fd)
      }
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

  /**
   * 用这些条目原子重写对话记录（回退、分叉、导入；先写临时文件再改名）。
   * 截过的条目从 opts.from（默认就是这个会话）的条目文件补全，必要时找它回退前的文件；补不全就在改名前抛错，原文件不动。
   * keepOld：改名前把现在的 items.jsonl 硬链接成 items.undo.jsonl（回退的撤销从它补全，用完 dropUndo）
   */
  replaceItems(sessionId: string, items: Item[], opts: { from?: string; keepOld?: boolean } = {}): void {
    const dir = this.sessionDir(sessionId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, ITEMS),
      tmp = `${file}.tmp`
    const from = opts.from ?? sessionId
    const next = new Map<string, Line>()
    const fds = new Map<string, number>()
    let done = false
    // 一条一条写、攒到约 1 MB 写一次：整个对话拼成一个字符串时几百 MB 的对话内存翻几倍，超过约 512 MB 直接报错
    const fd = openSync(tmp, 'w')
    try {
      let chunk = '',
        offset = 0
      for (const item of items) {
        const full = item.cut ? this.indexedBody(from, item, fds) : item
        if (!full) throw new Error(LOST)
        const line = JSON.stringify(full)
        const length = Buffer.byteLength(line)
        next.set(full.id, [offset, length])
        offset += length + 1
        chunk += line + '\n'
        if (chunk.length >= 1 << 20) {
          writeFileSync(fd, chunk, 'utf8')
          chunk = ''
        }
      }
      if (chunk) writeFileSync(fd, chunk, 'utf8')
      done = true
    } finally {
      closeSync(fd)
      closeAll(fds)
      if (!done) rmSync(tmp, { force: true })
    }
    const old = this.lines.get(sessionId)
    // keepOld：硬链接而不是改名，任何一步崩溃 items.jsonl 都在；先链到临时名，改名成功后才换掉旧的 undo
    // （改名失败时上一次回退的撤销还要用旧的）
    const undo = join(dir, UNDO),
      held = `${undo}.next`
    const keep = !!opts.keepOld && existsSync(file)
    if (keep) {
      rmSync(held, { force: true })
      try {
        linkSync(file, held)
      } catch {
        copyFileSync(file, held)
      }
    }
    try {
      replaceFile(tmp, file)
    } catch (err) {
      if (keep) rmSync(held, { force: true })
      throw err
    }
    if (old) this.lines.set(sessionId, next)
    if (!opts.keepOld) return
    this.dropUndo(sessionId)
    if (!keep) return
    try {
      replaceFile(held, undo)
      if (old) this.undoLines.set(sessionId, old)
    } catch {
      // 换不上（旧的 undo 被占着）：这次回退撤销不了（undoRewind 先核对补得回来），只多占点磁盘
      rmSync(held, { force: true })
    }
  }

  /** 分叉带上整个会话：直接复制来源的条目文件（先复制到临时文件再改名），不用把几百 MB 的对话重新序列化。来源没有条目文件时返回 false */
  copyItems(fromId: string, toId: string): boolean {
    const from = join(this.sessionDir(fromId), ITEMS)
    if (!existsSync(from)) return false
    const dir = this.sessionDir(toId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, ITEMS),
      tmp = `${file}.tmp`
    copyFileSync(from, tmp)
    replaceFile(tmp, file)
    this.lines.delete(toId)
    this.undoLines.delete(toId)
    return true
  }

  /** 删掉回退前留下的 items.undo.jsonl（撤销回退用完、或不再能撤销时） */
  dropUndo(sessionId: string): void {
    this.undoLines.delete(sessionId)
    try {
      rmSync(join(this.sessionDir(sessionId), UNDO), { force: true })
    } catch {
      // 被占着删不掉（Windows）：只是多占点磁盘，不能因此打不开会话、开不了新的一轮；下次载入或回退时再删
    }
  }

  /**
   * 截过的条目（cut）按 id 从磁盘读回完整内容：先找 items.jsonl 里这个 id 最后一行，再找回退前的 items.undo.jsonl。
   * 没截过的原样返回。没记位置、读出的 id 对不上、解析失败返回 null；位置失效时丢掉这个会话的索引（下次 loadItems 重建）。
   * 只补截掉的字段（图片、长输出），其它字段取 item（磁盘上那行可能还是 running）
   */
  body(sessionId: string, item: Item): Item | null {
    if (!item.cut) return item
    const fds = new Map<string, number>()
    try {
      return this.indexedBody(sessionId, item, fds)
    } finally {
      closeAll(fds)
    }
  }

  /**
   * 按 id 取单条完整条目，给没载入的会话用（engine:image 之类）：已载入的按位置读；没载入的流式扫一遍文件，不建整份数组。
   * 同一 id 取最后一行，套和 loadItems 一样的变换（running → interrupted），不截。没有这一条、或是被去掉的配置类警告返回 null
   */
  readItem(sessionId: string, itemId: string): Item | null {
    const fds = new Map<string, number>()
    let indexed: Item | null | undefined
    try {
      indexed = this.indexedLine(sessionId, itemId, fds)
    } finally {
      closeAll(fds)
    }
    if (indexed) return loaded(indexed)
    // 已载入的会话索引是全的：索引里没有就是没有
    if (this.lines.has(sessionId)) return null
    const file = join(this.sessionDir(sessionId), ITEMS)
    if (!existsSync(file)) return null
    let last = null as Item | null
    const needle = JSON.stringify(itemId)
    eachLine(file, line => {
      if (!line.includes(needle)) return
      try {
        const item = JSON.parse(line) as Item
        if (item?.id === itemId) last = item
      } catch {
        // 跳过写坏的行
      }
    })
    return last ? loaded(last) : null
  }

  private indexedBody(sessionId: string, item: Item, fds: Map<string, number>): Item | null {
    const full = this.indexedLine(sessionId, item.id, fds)
    return full ? withBodies(item, full) : null
  }

  /** 按索引读这个 id 最后一行（先 items.jsonl 再 items.undo.jsonl）；没记位置返回 undefined，位置失效返回 null 并丢掉这个会话的索引 */
  private indexedLine(sessionId: string, itemId: string, fds: Map<string, number>): Item | null | undefined {
    for (const [index, name] of [
      [this.lines, ITEMS],
      [this.undoLines, UNDO],
    ] as const) {
      const at = index.get(sessionId)?.get(itemId)
      if (!at) continue
      const full = readLine(join(this.sessionDir(sessionId), name), at, fds)
      if (full?.id === itemId) return full
      // 文件被外面改了（或写坏了一半）：位置都不可信了
      this.lines.delete(sessionId)
      this.undoLines.delete(sessionId)
      return null
    }
    return undefined
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

  /** items.jsonl 的字节数，没有这个文件为 0（不读条目） */
  itemsSize(sessionId: string): number {
    return statSync(join(this.sessionDir(sessionId), ITEMS), { throwIfNoEntry: false })?.size ?? 0
  }

  /** items.jsonl 有内容（不读条目，只看大小） */
  hasItems(sessionId: string): boolean {
    return this.itemsSize(sessionId) > 0
  }

  /**
   * 读出全部条目；同一个 id 出现多次时保留第一次的位置、最后一次的内容。没等到完成的标成已中断，图片数据、长输出截掉（cut），
   * 同时记下每个 id 最后一行的位置，之后这个会话的追加、重写都更新它（body() 用）。
   * 只在建运行时时调用：重新载入后内存里没有撤销状态了，顺便删掉回退前留下的文件
   */
  loadItems(sessionId: string): Item[] {
    const load = this.beginLoad(sessionId)
    if (existsSync(load.file)) eachLine(load.file, load.line)
    this.lines.set(sessionId, load.index)
    return load.items()
  }

  /**
   * 和 loadItems 一样的结果，但按块读、每块之后让出事件循环（打开大对话不卡主进程，docs/session-memory.md 第 4 期）。
   * 读的间隙里没载入时的追加（appendItem 不记位置）读得到就读进来；bytes 是读到的字节数，调用方和读完时的文件大小比，不等就重读。
   * 读完才登记位置，而且只在期间没有别人 loadItems 过时登记（不然会盖掉那份已经跟着追加、重写更新的）
   */
  async loadItemsAsync(sessionId: string, chunk = 1 << 20): Promise<{ items: Item[]; bytes: number }> {
    const load = this.beginLoad(sessionId)
    let bytes = 0
    if (existsSync(load.file)) {
      const buf = Buffer.alloc(chunk)
      const split = lineSplitter(load.line)
      for (;;) {
        // 每块重新打开：间隙里不占着文件（Windows 上占着时回退的改名会失败）
        const fd = openSync(load.file, 'r')
        let n: number
        try {
          n = readSync(fd, buf, 0, chunk, bytes)
        } finally {
          closeSync(fd)
        }
        if (!n) break
        split.feed(buf, n)
        bytes += n
        await nextTurn()
      }
      split.end()
    }
    if (!this.lines.has(sessionId)) this.lines.set(sessionId, load.index)
    return { items: load.items(), bytes }
  }

  /** loadItems / loadItemsAsync 共用：删掉残留的撤销文件，给出逐行解析的回调（边读边截、记位置）和读完后的变换 */
  private beginLoad(sessionId: string) {
    const file = join(this.sessionDir(sessionId), ITEMS)
    this.dropUndo(sessionId)
    // 回退到一半崩溃留下的（replaceItems keepOld 的临时名）；被占着删不掉不能因此打不开会话
    try {
      rmSync(`${join(this.sessionDir(sessionId), UNDO)}.next`, { force: true })
    } catch {
      // 下次载入再删
    }
    const index = new Map<string, Line>()
    const byId = new Map<string, Item>()
    return {
      file,
      index,
      line: (line: string, offset: number, length: number): void => {
        if (!line.trim()) return
        try {
          const item = JSON.parse(line) as Item
          if (!item || typeof item.id !== 'string') return
          // 边读边截：不然整份图片、输出要等读完才放掉，打开时的峰值还是整个文件
          byId.set(item.id, cutItem(item))
          index.set(item.id, [offset, length])
        } catch {
          // 跳过写坏的行（例如写到一半断电）
        }
      },
      items: (): Item[] => {
        const items: Item[] = []
        for (const item of byId.values()) {
          const shown = loaded(item)
          // running 的上面没截，标成已中断后再截
          if (shown) items.push(cutItem(shown))
        }
        return items
      },
    }
  }

  deleteSession(id: string): void {
    removeTree(this.sessionDir(id))
    this.lines.delete(id)
    this.undoLines.delete(id)
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
 * （V8 单个字符串上限约 512 MB，跑了很久的对话 items.jsonl 会超过，整份读会报 ERR_STRING_TOO_LONG 打不开）。
 * 回调另给这一行在文件里的字节起点和字节长度（不含换行）
 */
export function eachLine(
  file: string,
  fn: (line: string, offset: number, length: number) => void,
  chunk = 16 << 20,
): void {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(chunk)
    const split = lineSplitter(fn)
    for (let n: number; (n = readSync(fd, buf, 0, chunk, null)) > 0; ) split.feed(buf, n)
    split.end()
  } finally {
    closeSync(fd)
  }
}

/** 按块喂入、按换行切行（eachLine 和 loadItemsAsync 共用）；回调同 eachLine */
function lineSplitter(fn: (line: string, offset: number, length: number) => void) {
  let parts: Buffer[] = []
  // base：下一块在文件里的起点；lineStart：当前行的起点
  let base = 0,
    lineStart = 0
  return {
    /** buf 的前 n 个字节；buf 之后会被复用 */
    feed(buf: Buffer, n: number): void {
      let start = 0
      // 换行符 0x0A 不会出现在 UTF-8 多字节字符中间，按字节切安全
      for (let i = buf.indexOf(10); i !== -1 && i < n; i = buf.indexOf(10, start)) {
        parts.push(buf.subarray(start, i))
        fn(Buffer.concat(parts).toString('utf8'), lineStart, base + i - lineStart)
        parts = []
        start = i + 1
        lineStart = base + start
      }
      // 下一块会复用 buf：没切完的那段拷出来
      if (start < n) parts.push(Buffer.from(buf.subarray(start, n)))
      base += n
    },
    end(): void {
      if (parts.length) fn(Buffer.concat(parts).toString('utf8'), lineStart, base - lineStart)
    },
  }
}
