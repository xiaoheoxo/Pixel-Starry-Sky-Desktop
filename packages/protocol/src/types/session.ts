import type { ApprovalRequest } from './approval'
import type { Effort, EngineId, PermissionMode } from './base'

/** 项目的附加文件夹（docs/ui/multi-root-projects.md §3） */
export interface ProjectFolder {
  path: string
  /** 显示名；不写时用文件夹名 */
  name?: string
}

/** 项目 = 一个主文件夹（AI 在这里启动），可以再带几个附加文件夹 */
export interface ProjectRecord {
  id: string
  name: string
  path: string
  /** 附加文件夹，按添加顺序；没有时不写这个字段（旧数据就是单文件夹项目） */
  folders?: ProjectFolder[]
  /** 毫秒时间戳 */
  addedAt: number
}

/** 一次添加多个项目的结果（docs/ui/multi-root-projects.md §2）：新加的、本来就在列表里的、加不上的 */
export interface AddProjectsResult {
  added: ProjectRecord[]
  existing: ProjectRecord[]
  failed: { path: string; error: string }[]
}

export type TurnOutcome = 'completed' | 'interrupted' | 'failed'

export interface SessionSettings {
  /** 仅像素星空：后续子任务的类型覆盖，不写入引擎默认值、不改已经启动的子进程。 */
  subagentOverrides?: import('../subagents').SubagentOverride[]
  /** null/缺省为自有认证；平台记录分组与账号，避免跨账号扣费。 */
  platform?: { groupId: string; account: string } | null
  /** 自定义 API 的接口（docs/ui/custom-api.md）；模型仍在 model 里。和 platform 不能同时有 */
  provider?: { id: string } | null
  /** null 表示用引擎自己的默认模型 */
  model: string | null
  /** null 表示用引擎自己的默认强度 */
  effort: Effort | null
  permissionMode: PermissionMode
  /** Ultracode 开关（只有能力表里 ultracode 为真的引擎才有效） */
  ultracode: boolean
  /** Fast 模式（更快、更贵） */
  fast: boolean
  /** Ultrafast（只有官方登录、模型目录列了的才生效）：fast 为真时才算数，只对这个会话，不进默认值 */
  ultrafast?: boolean
  /** 显示思考摘要 */
  thinkingSummaries: boolean
}

/** 入队时固定成本相关设置；权限与会话开关在实际执行时读取。 */
export type QueueSettings = Pick<SessionSettings, 'model' | 'effort'> & {
  platform: NonNullable<SessionSettings['platform']> | null
  /** 旧的排队项没有这个字段，按 null 处理 */
  provider?: NonNullable<SessionSettings['provider']> | null
  /** 这条消息用哪个引擎（跨引擎接力）；旧的排队项没有这个字段，按会话当前引擎处理 */
  engine?: EngineId
}

/**
 * 一个引擎在这段对话里的原生会话（跨引擎接力）：id 是它自己的会话 id，seen 是它上下文里最后一条对话条目的 id
 * （null 表示它什么都没看到，下次用它时要带上完整交接）。当前引擎的 id 仍以 SessionRecord.engineSessionId 为准
 */
export interface EngineSessionState {
  id: string | null
  seen: string | null
  /** 换走时还没生效的回退 / 分叉截断点，换回来时放回记录 */
  pendingRewind?: string | null
  pendingFork?: { from: string; at: string } | null
}

/** 用户输入的图片。Base64 只保存在本地队列 / 引擎发送链路，不进入搜索正文。 */
export interface ImageAttachment {
  id: string
  name: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  dataBase64: string
}

/**
 * 用户添加的文字文件，或只发送机器可访问路径的文件引用。文字附件超过 100 KB 时只带开头和结尾；路径引用不内联内容。
 * 发给引擎时接在消息后面（messageWithFiles），对话里显示成文件卡片。
 */
export interface FileAttachment {
  id: string
  name: string
  /** 原文件大小 */
  bytes: number
  /** 原文件行数 */
  lines: number
  /** 原文件的编码（都已转成文字） */
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'
  text: string
  /** 截断时的结尾部分；从文档提取的（有 source）只留开头，tail 是空串 */
  tail?: string
  omitted?: number
  /** 不是纯文本、是从这种文件里提取的文字（docs/ui/composer-file-attachments.md §7）；没有就是文本文件 */
  source?: FileSource
  /**
   * agent 所在机器可访问的路径：本机文件可以直接引用，远程 / 无本机路径时会暂存到目标机器。
   * 发给引擎时写在 <attached_file> 上；截断或仅路径引用的文件可由智能体按路径读取。
   */
  path?: string
  /** 只发送路径引用，不把文件内容内联到消息。 */
  pathOnly?: boolean
  /** 路径指向应用临时副本，30 天后清理。 */
  staged?: boolean
}

export type FileSource = 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'pdf' | 'rtf' | 'epub' | 'html' | 'ipynb'

export interface MessageInput {
  text: string
  clientMessageId: string
  attachments?: ImageAttachment[]
  files?: FileAttachment[]
  settings?: QueueSettings
}

export type QueueStatus = 'queued' | 'dispatching' | 'running' | 'delivering' | 'failed' | 'uncertain'

export interface QueuedMessage {
  id: string
  text: string
  attachments?: ImageAttachment[]
  files?: FileAttachment[]
  createdAt: number
  settings: QueueSettings
  status: QueueStatus
  error: string | null
  mode: 'normal' | 'guidance'
  attempt?: number
  messageUuid?: string
  /** 引擎已经收到 messageUuid 那条原文（确认送达或已有输出）：断线重连时只发「继续」；没送达的原样重发。
   *  每次整条发送时宿主先写 false，收到引擎的确认后写 true */
  delivered?: boolean
  /** 队列暂停时用户在空闲状态直接发送了新消息：这条旧排队项单独保持暂停，等「继续队列」 */
  held?: boolean
  /** 发送时没有对话在运行、前面也没有可执行的排队项：立即执行，不算排队。
   *  界面在对话里显示「正在启动」而不是放进消息队列；未能开始（被停止）时宿主清掉此标记。 */
  direct?: boolean
  /** 连接中断、宿主正在自动重连（retry.ts isConnectionError）：到时间之前留在队首不派发，
   *  界面显示重连卡片而不是放进消息队列 */
  reconnect?: QueueReconnect
  /** 因限流 / 额度用完在等到点自动继续（docs/ui/rate-limit-resume.md）：和 reconnect 一起出现，界面显示限流卡片而不是重连卡片 */
  limit?: QueueLimit
  /** 自动重连了几次还是没接上（或用户点了停止）才算失败的：界面在错误原因后面写「已自动重连 n 次」 */
  reconnected?: number
}

/**
 * 调序目标。新形态按消息 id 定位（{ before: 锚点消息 id } 排到它前面，null 排到最后），
 * 点击到宿主收到之间队列变了（队首刚好发完）也不会挪错；锚点或被挪的消息已不在队里就整条拒绝（错误码 queue.changed）。
 * 数字是旧版的「挪到第几位」，只为旧版手机连新版电脑保留。
 */
export type QueueMove = { before: string | null } | number

export interface QueueReconnect {
  /** 第几次重连，从 1 起 */
  attempt: number
  max: number
  /** 这条消息累计自动重连了几次（有输出时 attempt 会从 1 重算，它不重算）：超过 max 的 3 倍就不再重连，免得上游每次出几个字就断时无限「继续」；旧数据没有，按 attempt 算 */
  total?: number
  /** 开始等的时间和到点派发的时间（毫秒时间戳） */
  since: number
  at: number
  /** 上一次断开的原因（第一行） */
  reason: string
  /** 引擎还没收到这条消息（!delivered）：到时原样重发；否则发一句「继续」接着断开前的上下文做。只给界面提示，派发时以 delivered 为准 */
  resend?: boolean
  /** 额度用完、自动换了订阅账号后重新派发（docs/ui/engine-accounts.md §5）：马上派发，不受重连次数限制 */
  account?: boolean
  /** 被 Cloudflare 这类防护拦下（engine retry.ts 'blocked'）：等得更久，界面写「被拦截」而不是「连接中断」 */
  blocked?: boolean
  /** 因限流 / 额度用完在等（对应 QueuedMessage.limit）：不受重连次数设置限制，次数按 limit.tries 算 */
  limited?: boolean
}

/** 限流 / 额度用完后的等待（engine retry.ts limitKind / limitDelay） */
export interface QueueLimit {
  /** quota：订阅额度用完（窗口见 window）；rate：只有一条 429 */
  kind: 'quota' | 'rate'
  window: 'five_hour' | 'seven_day' | null
  /** 引擎给的恢复时间（毫秒）；没有为 null，按退避等 */
  resetsAt: number | null
  /** 到点自动继续后仍被限流的时间点；满 3 个就不再自动继续 */
  tries: number[]
}

export interface SendReceipt {
  queueId: string
  status: 'queued' | 'accepted' | 'cancelled'
}

export interface SessionRecord extends SessionSettings {
  /** 持久化的列表置底偏好，旧记录为 null。 */
  bottomedAt?: number | null
  /** 置顶的时间：置顶的会话显示在侧栏最上面的「置顶」分组（和置底互斥），旧记录为 null。 */
  pinnedAt?: number | null
  /** 用户显式改名后，不再生成首条消息的默认标题。 */
  titleEdited?: boolean
  /** 旧调用方可缺失，读取与新建时统一为 null；归档保留会话内容。 */
  archivedAt?: number | null
  id: string
  projectId: string
  /** 工作目录（创建时从项目复制，项目路径以后变了也不影响已有会话） */
  cwd: string
  /** 项目的附加文件夹（创建时从项目复制，之后给项目加减文件夹不影响已有会话；docs/ui/multi-root-projects.md §3.2） */
  extraDirs?: string[]
  engine: EngineId
  /** 引擎自己的会话 id（Claude 的 session_id / Codex 的 thread id）；还没启动过引擎时为 null */
  engineSessionId: string | null
  /** 各引擎的原生会话和读到的位置（跨引擎接力）；旧记录没有，按「当前引擎已看到全部对话」处理 */
  engineSessions?: Partial<Record<EngineId, EngineSessionState>>
  /** 运行中或有排队时选了别的引擎：从下一条发出的消息起使用，派发到它时才真正切换；没有时为 null */
  nextEngine?: EngineId | null
  title: string
  createdAt: number
  updatedAt: number
  /** 最近一轮的结果；还没发过消息时为 null */
  lastOutcome: TurnOutcome | null
  /** 最近一轮失败时的错误摘要（最多 500 字），其余情况为 null；旧记录没有此字段（docs/ui/tasks-inbox.md） */
  lastError?: string | null
  /**
   * 最近一轮 AI 最后一条回复的纯文本开头（会话列表的「最后一句回复」，docs/mobile-remote.md §21.3）：一行、最多 120 个字符
   * （超出截断并加「…」），已去掉 Markdown 记号（代码块整块换成「[代码]」、行内代码去反引号、链接只留文字、
   * 标题 / 列表符号 / 引用 / 加粗斜体记号去掉、多个空白合成一个空格；见 replyPreview）。
   * 用户消息不算；一轮结束时（完成 / 失败 / 中断）如果这一轮有回复就更新，没有回复的轮次保持旧值；还没有回复时不写或为 null
   */
  lastReply?: string | null
  /** 回退后尚未生效的引擎截断点（Claude 记录里的条目 uuid）：下次启动引擎时使用，成功启动后清空 */
  pendingRewind?: string | null
  /** 分叉出来、还没启动过引擎的会话：第一次启动时从原引擎会话的截断点复制（docs/ui/rewind-fork-sidechat.md §2） */
  pendingFork?: { from: string; at: string } | null
  /** 从哪个会话分叉出来的（顶部一行「分叉自『…』」） */
  forkedFrom?: { sessionId: string; title: string } | null
  /** 「开分支」开出的会话（docs/ui/branch-merge.md §3.2）：上级就是 forkedFrom；普通分叉没有 */
  branch?: SessionBranch | null
  /** 合并回来的分支摘要（docs/ui/branch-merge.md §5.2）：下一条消息发给 AI 时放在前面，发出后清掉 */
  pendingMerge?: PendingMerge | null
  /** 接着引擎自己留下的会话（终端里的 Claude Code……）导入来的（docs/ui/claude-resume.md §4.5） */
  imported?: ImportedSession | null
  /**
   * 订阅额度用完、自动改用了平台（docs/ui/engine-accounts.md §5.2）：用完的订阅账号、改用平台前的模型、恢复时间。
   * 额度恢复后据此换回订阅；用户自己改了来源、线路或模型就清掉，不再自动换回
   */
  platformFallback?: { account: string; model: string | null; resetsAt: number | null } | null
  /** 定时任务开出来的会话（docs/ui/board-schedule.md）：来源任务的 id；看板的 AI 卡片据此显示「⏱ 定时」 */
  scheduleTaskId?: string | null
  /**
   * Codex 目标是像素星空关进程时暂停的（docs/ui/codex-goal.md §2.1）：那时目标的 updatedAt。下次发普通消息时，
   * 目标还是这次暂停的样子就改回进行中；用户自己停止、暂停的不记
   */
  goalHeldAt?: number | null
  /**
   * 当前在终端（TUI）模式（docs/ui/tui-toggle.md §5.1）：terminalId 是本机内置终端 id，since 是切过去的时间。
   * 远程机器不开放；重启后打开会话当作已切回并补轮次
   */
  tui?: { terminalId: string; since: number } | null
}

/**
 * 导入的原生会话：sessionId 是它在引擎里的会话 id；turns 是这条分支一共多少轮，shown 是现在显示着多少轮
 * （「加载更早的」「补上」之后更新）；forked 是「复制一份接着聊」：原会话一个字节都不写，但仍算被这个对话占用
 */
export interface ImportedSession {
  engine: EngineId
  sessionId: string
  at: number
  turns: number
  shown: number
  forked?: boolean
  /** 导入时这个会话是从终端还是其他程序开的：启动时撞上「正被别的进程写着」按它给提示（Codex） */
  source?: 'terminal' | 'other'
}

/** 一个引擎自己留下的、可以接着聊的会话（终端里的 Claude Code……） */
export interface NativeSessionSummary {
  id: string
  title: string
  firstPrompt: string
  /** 第二步（nativeSessionDetails）才有 */
  lastPrompt: string | null
  branch: string | null
  /** 会话开在项目子文件夹里时的相对路径，在项目根目录为 null */
  subdir: string | null
  updatedAt: number
  size: number
  /** 第二步才有 */
  model: string | null
  source: 'terminal' | 'other'
  /** 已被像素星空的某个对话占用：那个对话的 id，没有为 null */
  ownerId: string | null
  /** 现在有进程开着：'maybe' 是读不到登记、只看记录修改时间的退路 */
  live: 'terminal' | 'other' | 'maybe' | null
}

/** 第二步补上的尾部信息 */
export interface NativeSessionDetail {
  id: string
  lastPrompt: string | null
  title: string
  /** 最后一条记录的时间；读不到为 null */
  lastActive: number | null
  model: string | null
  branch: string | null
  /** 已经接到别的会话里了（那个会话单独列出）：这一行不该显示 */
  superseded: boolean
  /** 尾部读取的预算用完了：其余字段还是第一步的 */
  skipped: boolean
}

/** 导入结果：新对话 / 已经被占用 / 正开着（原地导入时，界面给「复制一份接着聊」） */
export type NativeImportResult =
  | { sessionId: string; model: string | null; turns: number; shown: number }
  | { ownerId: string }
  | { live: 'terminal' | 'other' }

/** nativeSessionAction 的操作：加载更早的 / 补上终端里新聊的 / 原地改成复制 / 只检查有没有新聊的（有就在末尾加提示） */
export type NativeAction = 'earlier' | 'sync' | 'copy' | 'check'

/** added：这次加进显示的轮数（copy 为 0；check 是发现的新轮数，没有加进显示） */
export interface NativeActionResult {
  added: number
}

/** 回退要做什么（docs/ui/rewind-fork-sidechat.md §1）；省略时只回退对话 */
export interface RewindOptions {
  conversation: boolean
  code: boolean
  /** 只还原这些文件（相对工作目录，预览给出的路径）；省略时全部（docs/ui/undo-changes.md §4） */
  paths?: string[]
}

/** 回退前的代码检查：要还原哪些文件；做不了时给原因 */
export type RewindCodePreview =
  | {
      ok: true
      /** 相对工作目录的路径（工作目录外的保持绝对路径） */
      files: string[]
      insertions: number
      deletions: number
      /** 还原前能不能先存一份以便撤销（总共不超过 20 MiB） */
      undoable: boolean
      /** 最后一轮结束之后又被改过（手改等）的文件，还原会盖掉；只有对话检查点能查 */
      edited?: string[]
      /** 用的是对话检查点（docs/ui/undo-changes.md）：能只还原其中几个文件 */
      checkpoint?: boolean
    }
  /**
   * compacted：没有检查点，而且这条消息在上下文压缩之前（Claude Code 只保留压缩之后的检查点，GitHub #82）；
   * expired：有过对话检查点，但快照缺了内容（项目的 git 清理了借来的对象、快照文件被删），引擎自己也没有检查点
   */
  | { ok: false; reason: 'unsupported' | 'no-checkpoint' | 'compacted' | 'expired' | 'failed'; message?: string }

export interface RewindPreview {
  code: RewindCodePreview
}

/** 回退结果：被移除的用户消息原文和图片，放回输入框（只恢复代码时为空）；能不能撤销 */
export interface RewindResult {
  text: string
  attachments?: ImageAttachment[]
  files?: FileAttachment[]
  /** 还原了几个文件；没动代码时省略 */
  filesRestored?: number
  /** 发新消息或重启前可以撤销 */
  undoable?: boolean
  /** 同时选了恢复对话和代码、代码没能恢复时：对话照样回退了，这里是代码没恢复的原因（GitHub #82） */
  codeSkipped?: string
}

/** 对话检查点停用的原因：没装 git / 拍快照太慢 / 超过大小上限 / 其他错误 */
export type CheckpointDisabled = 'no-git' | 'slow' | 'too-large' | 'failed'

/** 一轮（一条我方消息）的检查点 */
export interface CheckpointTurn {
  itemId: string
  /** 这一轮改了哪些文件（相对工作目录）；这一轮还没结束、没拍到结束时的快照为 null */
  files: string[] | null
  at: number
}

/** 改动卡片里撤回的文件（只在内存里，重启后没有） */
export interface RevertedFiles {
  revertId: string
  itemId: string
  /** 撤回时传进来的路径，原样 */
  paths: string[]
}

/** 会话的对话检查点（docs/ui/undo-changes.md） */
export interface CheckpointList {
  disabled: CheckpointDisabled | null
  message?: string
  turns: CheckpointTurn[]
  reverted: RevertedFiles[]
}

/** 文件不能撤回的原因：在工作目录外 / 被排除 / 这一轮没有快照 / 子模块或链接 / 读写失败 */
export type RevertSkip = 'outside' | 'excluded' | 'no-checkpoint' | 'special' | 'failed'

/** 撤回文件：这一轮之后又被改过、没确认时只返回冲突，不改文件；否则返回撤回结果 */
export type RevertFilesResult =
  | { kind: 'conflict'; conflicts: { path: string; diff: string; added: number; removed: number }[] }
  | {
      kind: 'done'
      /** 恢复时用；一个都没撤回时为 null */
      revertId: string | null
      reverted: string[]
      skipped: { path: string; reason: RevertSkip; message?: string }[]
    }

/** 开分支的会话（docs/ui/branch-merge.md §3.2） */
export interface SessionBranch {
  /** 副本 id；null 是和上级同一个目录（只分开对话） */
  copyId: string | null
  /** 副本所在的 Git 分支；同目录时为 null */
  gitBranch: string | null
  /** 开分支时上级所在的分支（显示用）；不是 Git 仓库或分离头指针时为 null */
  baseBranch: string | null
  /** 代码起点（含开分支时上级没提交的改动）：合并时按它算分支自己的改动；同目录时为 null */
  startCommit: string | null
  /** 带过来的最后一个条目 id：分支自己的内容从它后面开始；什么都没带时为 null */
  startAfter: string | null
  /** 最近一次合并回上级的时间；还没合并过为 null */
  mergedAt: number | null
  /** 合并时删了副本：这个会话只能回看 */
  copyRemoved?: boolean
}

/** 等着带给 AI 的分支合并摘要 */
export interface PendingMerge {
  /** 分支会话 id */
  sessionId: string
  title: string
  summary: string
}

/** 开分支 / 分叉的选项：不传时和原来的分叉一样（同一个工作目录、没有 branch） */
export interface ForkOptions {
  /** 新会话的工作目录（开分支建的副本） */
  cwd?: string
  branch?: Omit<SessionBranch, 'startAfter' | 'mergedAt'>
}

/** 分叉结果：新会话，以及放进它输入框的原文和图片 */
export interface ForkResult {
  record: SessionRecord
  text: string
  attachments?: ImageAttachment[]
  files?: FileAttachment[]
}

/** 旁聊里之前的一问一答 */
export interface SideTurn {
  question: string
  answer: string
}

/**
 * 会话运行状态（不保存，只在内存里）：
 * - idle 空闲
 * - starting 正在启动引擎
 * - running 这一轮正在进行
 * - waiting 等用户审批
 */
export type SessionState = 'idle' | 'starting' | 'running' | 'waiting'

/** 侧边栏用的会话摘要 */
export interface SessionSummary {
  record: SessionRecord
  state: SessionState
  /** 空闲但后台还有子智能体 / 编排在跑：有几个（docs/ui/notifications.md §7）；没有时省略 */
  background?: number
  /**
   * 消息队列概况：有排队或失败的消息时才有（任务 › 待处理、手机任务列表用，docs/ui/tasks-inbox.md）。
   * queued 只数还在等的：不含失败项，也不含正在执行、正在交付的那条。没打开过的会话按磁盘上的队列文件计数
   */
  queue?: QueueSummary
  /** 已载入的会话第一个等你批准的请求：看板、收件箱不用为它整份打开会话；没有时省略 */
  pending?: ApprovalRequest
  /** 所有等你批准的请求 id（有 pending 时才有）：收件箱「已处理」按它认，又来一个请求时重新出现 */
  pendingIds?: string[]
}

export interface QueueSummary {
  queued: number
  failed: number
  paused: boolean
  /** 在等限流恢复后自动继续时，下一次继续的时间点（侧栏时钟用）；没在等、已暂停或已停止时省略 */
  limitAt?: number
}
