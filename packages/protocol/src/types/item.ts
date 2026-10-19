import type { EngineId } from './base'
import type { FileAttachment, ImageAttachment, TurnOutcome } from './session'
import type { TurnUsage } from './usage'

export type ItemStatus = 'running' | 'completed' | 'failed' | 'declined' | 'interrupted'

/** 显示时去掉的外层 shell（Codex 命令）：line 原始整行，shell 外壳名（小写、无 .exe：powershell / pwsh / bash / sh / zsh / cmd …），extra 引出脚本的开关以外的参数 */
export interface CommandWrapper {
  line: string
  shell: string
  extra: string[]
}

export interface FileChange {
  path: string
  /** 编辑输入的新内容片段，用于编辑器定位；旧记录可能缺失。 */
  newText?: string
  kind: 'add' | 'update' | 'delete'
  /** unified diff 的正文（@@ 行和 +/-/空格 开头的行，没有文件头）；拿不到时为空字符串 */
  diff: string
  added: number
  removed: number
}

export interface TodoStep {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type ToolKind = 'read' | 'search' | 'web' | 'mcp' | 'task' | 'other'

/** 报错提示的归类：界面据此给一键按钮、侧栏给状态图标（覆盖按文字猜的老办法）；overflow 是上下文超限 */
export type NoticeErrorKind = 'auth' | 'balance' | 'route' | 'busy' | 'overflow'

/**
 * 报错提示的结构化信息，引擎在认出 API 报错时填：kind 归类（认不出就没有）、code 引擎给的原始错误代码、status HTTP 状态码。
 * 没有这个字段的（旧会话、旧引擎）界面按文字猜
 */
export interface NoticeError {
  kind?: NoticeErrorKind
  code?: string
  status?: number
}

/** 后台任务结束提示的结构化信息；label 是任务说明（可能为空），summary 是结束时的摘要 */
export interface NoticeTask {
  toolUseId?: string
  kind: 'agent' | 'workflow' | 'bash' | 'monitor' | 'remote_agent'
  status: 'completed' | 'failed' | 'stopped'
  label: string
  summary?: string
}

export type Item =
  | {
      kind: 'user'
      id: string
      text: string
      attachments?: ImageAttachment[]
      /** 带的文本文件（text 是用户写的话，不含文件内容） */
      files?: FileAttachment[]
      createdAt: number
      turnId?: string
      mode?: 'normal' | 'guidance'
      /** 处理这条消息的引擎（跨引擎接力）；旧条目没有，按会话当前引擎处理 */
      engine?: EngineId
      /** 连接中断后宿主自动发的「继续」是第几次重连：界面显示成一行小字，不当成用户说的话 */
      reconnect?: number
      /** 发送失败后用户点了「关掉」：没送到，留在对话里变淡，标「未送达」 */
      dismissed?: boolean
    }
  /** 助手回复，Markdown */
  | { kind: 'assistant'; id: string; text: string; status: ItemStatus }
  /**
   * 思考过程，界面默认折叠。durationMs：引擎算好的思考用时（Codex 的思考条目要等想完才发，界面自己计时只有 0 秒）；
   * 没有时界面按亲眼看到的运行时间算
   */
  | { kind: 'reasoning'; id: string; text: string; status: ItemStatus; durationMs?: number }
  | {
      kind: 'command'
      id: string
      command: string
      /** Codex 命令显示时去掉了外层 shell：原始整行和外壳信息；没拆过（或旧数据）没有 */
      wrapper?: CommandWrapper
      /** 命令说明（Claude 的 description），可能没有 */
      description: string | null
      output: string
      exitCode: number | null
      status: ItemStatus
      /** 是哪个子智能体调用的（名字）；主智能体调用时没有 */
      subagent?: string
      /** 派出这个子智能体的 Agent 工具调用 id（对应智能体追踪的 AgentRun.toolUseId，docs/ui/subagent-changes.md §2.3） */
      subagentCall?: string
      /** 后台子智能体的工具：这一轮结束时还在跑，不跟着这一轮收尾 */
      background?: boolean
    }
  | {
      kind: 'file_change'
      id: string
      changes: FileChange[]
      status: ItemStatus
      subagent?: string
      subagentCall?: string
      background?: boolean
    }
  | {
      kind: 'tool'
      id: string
      tool: ToolKind
      /** 原始工具名，例如「Read」「mcp__github__search」 */
      name: string
      /** 一行摘要，例如文件路径、搜索词、网址 */
      title: string
      output: string
      status: ItemStatus
      subagent?: string
      subagentCall?: string
      background?: boolean
      /** 结果里的图片（例如 Read 了一张图片），有大小上限；超出的只在 output 里留「[图片]」 */
      images?: ImageAttachment[]
    }
  | { kind: 'todo'; id: string; steps: TodoStep[]; status: ItemStatus }
  /** detail：引擎给出的原始报错详情（附加说明、错误类型、HTTP 状态码等），界面默认折叠 */
  /**
   * task：后台任务（子智能体、编排、后台命令……）结束的提示带的结构化信息，界面据此画完成小框（docs/ui/subagent-box.md §4.4）；
   * 没有这个字段的（旧会话、旧引擎）只显示 text
   */
  | {
      kind: 'notice'
      id: string
      level: 'info' | 'warn' | 'error'
      text: string
      detail?: string | null
      task?: NoticeTask
      error?: NoticeError
      /** 提示右边的按钮（接着引擎自己的会话：加载更早的 / 补上终端里新聊的 N 轮）；count 是轮数 */
      action?: { kind: 'native-earlier' | 'native-sync'; count: number }
    }
  /**
   * 压缩上下文（docs/ui/compaction.md）：进行中显示动画和计时，结束后显示「压缩前 → 压缩后」和用时。
   * trigger：手动 /compact 还是自动；引擎没说时为 null。几个大小、用时拿不到时为 null
   */
  | {
      kind: 'compaction'
      id: string
      status: ItemStatus
      trigger: 'manual' | 'auto' | null
      startedAt: number
      durationMs: number | null
      preTokens: number | null
      postTokens: number | null
      error?: string | null
      /** 经过本机网关时的汇总（详情里显示）：实际请求的模型、首字用时、摘要输出的 token、一共发了几次请求 */
      model?: string | null
      firstTokenMs?: number | null
      outputTokens?: number | null
      requests?: number
    }
  /** 一轮结束后的统计（耗时、token、费用、模型），显示在这一轮回复下方（docs/ui/usage.md §4） */
  | { kind: 'turn_stats'; id: string; turnId: string; outcome: TurnOutcome; usage: TurnUsage }

export type ItemKind = Item['kind']
