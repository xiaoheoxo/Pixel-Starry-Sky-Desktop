// 接着本机会话（Claude Code / Codex）共用的类型：不分引擎，各引擎的读取层都按这些形状返回。
import type { Item } from '@pixelsky/protocol'

export interface NativeListedSession {
  id: string
  file: string
  size: number
  mtimeMs: number
  /** 先是 mtime，尾部读到最后一个 timestamp 后（detail.lastActive）界面只改显示，不改排序 */
  updatedAt: number
  /** 记录里的工作目录 */
  cwd: string
  /** 会话开在项目的子文件夹里时的相对路径，在项目根目录为 null */
  subdir: string | null
  title: string
  firstPrompt: string
  lastPrompt: string | null
  branch: string | null
  /** entrypoint 是 cli 的算终端，其余（sdk-cli、读不到……）算其他程序 */
  source: 'terminal' | 'other'
  model: string | null
}

export interface ListOptions {
  /** 最多给多少个，默认 LIST_LIMIT */
  limit?: number
  /** 项目子文件夹里开的会话也列出来（§3.1 D） */
  subfolders?: boolean
  /** 尾部总预算（字节）、单个文件上限，默认 TAIL_BUDGET / TAIL_CAP */
  tailBudget?: number
  tailCap?: number
}

export interface NativeSessionList {
  /** 第一步的结果：按修改时间从新到旧；只有元数据的已经去掉 */
  sessions: NativeListedSession[]
  /**
   * 第二步：按顺序读这些会话的尾部（不传 ids 就是 sessions 全部），读一个出一个。
   * 共用这次列表的预算；读到的内容也会补进 sessions 里对应的条目。signal 触发时停下
   */
  details(ids?: readonly string[], signal?: AbortSignal): AsyncGenerator<NativeListedDetail>
  /** 这次列表的尾部预算（剩余字节） */
  budget?: TailBudget
}

export interface TailBudget {
  left: number
}

export interface NativeListedDetail {
  id: string
  lastPrompt: string | null
  title: string
  /** 最后一个 timestamp；读不到为 null */
  lastActive: number | null
  /** 最后一条 assistant 的 message.model（跳过 <synthetic> 和接力行） */
  model: string | null
  branch: string | null
  /** 头部没有用户输入、尾部也没有 last-prompt：只有元数据，该隐藏 */
  hidden: boolean
  /** 末尾的 continued-in 指向的会话 id */
  continuedIn: string | null
  /** continuedIn 对应的记录在同一个目录里：这一行不列 */
  superseded: boolean
  /** 预算用完了，没有读尾部（其余字段是第一步的） */
  skipped: boolean
  /** 这次实际读了多少字节（命中缓存为 0） */
  read: number
}

export type LiveState = 'terminal' | 'other' | 'maybe' | null

export interface ReadOptions {
  /** 最近多少轮，默认 50 */
  turns?: number
  /** 条目上限，默认 1000 */
  maxItems?: number
  signal?: AbortSignal
  /** 建索引的进度（已读字节 / 总字节） */
  onProgress?: (read: number, total: number) => void
  /** 加载更早的：当前显示着的最早一条用户条目（行 uuid），取它之前的 turns 轮 */
  before?: string
  /** 会话正开着：末尾还没结束的一轮（有没结果的 tool_use）不导入，截断点退到它前面 */
  live?: boolean
  /** 索引的块大小，测试用 */
  chunk?: number
}

export interface NativeRead {
  file: string
  /** 条目：user 的 id 是行 uuid、engine 为 claude；其余 imp-<uuid>-<n>；工具用 toolu id；提示用 randomUUID */
  items: Item[]
  title: string
  /** 这条分支一共多少轮（沿 logicalParentUuid 越过压缩边界数，不读内容） */
  turns: number
  /** 这次给出了多少轮 */
  shown: number
  /** 最近一次压缩的摘要文字 */
  summary: string | null
  source: 'terminal' | 'other'
  /** 最后一条 assistant 的 message.model */
  model: string | null
  /** 分支末端（last-prompt 的 leafUuid 规则，可能是 system / attachment 行） */
  leafUuid: string | null
  /** 导入的这一段里最后一条 user / assistant 的 uuid：复制一份接着聊的截断点（live 时退到没结束的那一轮前面） */
  at: string | null
  /** 给出的最早一条用户条目（加载更早的从这里接着往前） */
  earliestShownUuid: string | null
  hasEarlier: boolean
  /** 给出的内容在最近一次压缩之前（模型只看到压缩摘要）；加载更早的越过边界时为 true */
  compacted: boolean
  /** 记录里的工作目录（Codex 读线程时给；Claude 不填） */
  cwd?: string
  /** 只能复制一份、不能原地接着聊 */
  copyOnly?: boolean
  /** 这个会话是像素星空自己建的 */
  pixelsky?: boolean
}

export interface NewerTurns {
  /** 接在已有条目后面的新条目；超过 turns 轮时最前面是一条「中间还有 M 轮没有显示」 */
  items: Item[]
  /** after 之后一共多少轮 */
  turns: number
  /** 给出了多少轮 */
  shown: number
  /** 中间没显示的轮数 */
  gap: number
  leafUuid: string | null
  at: string | null
  /** after（或它这一轮的末尾）那一行的 uuid：像素星空认识的最后位置，「复制一份接着聊」从这里分叉 */
  base: string
}
