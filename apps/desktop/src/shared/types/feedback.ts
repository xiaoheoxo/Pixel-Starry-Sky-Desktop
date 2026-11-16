// 设置 › 反馈：用户把问题、建议、日志发给像素星空团队，团队在云端后台回复、关闭（docs/ui/feedback.md）

export type FeedbackType = 'bug' | 'feature' | 'other'
/** open 等待回复 / replied 团队已回复 / closed 已关闭 */
export type FeedbackStatus = 'open' | 'replied' | 'closed'
/** user 用户自己 / team 像素星空团队（不下发管理员是谁） */
export type FeedbackAuthor = 'user' | 'team'

/** 列表里的一条反馈 */
export interface FeedbackSummary {
  id: string
  type: FeedbackType
  title: string
  status: FeedbackStatus
  createdAt: number
  updatedAt: number
  /** 团队有用户还没看过的回复（服务端判定，换电脑也一致） */
  unread: boolean
  /** 最后一条消息的开头 */
  preview: string
  previewAuthor: FeedbackAuthor
  /** 团队看过用户最新的动作（旧云端没有这个字段时为 false） */
  teamSeen: boolean
  teamSeenAt: number | null
  /** 未关闭且已有人负责（不暴露是谁） */
  working: boolean
  workingAt: number | null
  /** 普通消息条数（用户 + 团队） */
  messageCount: number
  attachments: FeedbackAttachmentCounts
}

export interface FeedbackAttachmentCounts {
  logs: number
  images: number
}

export interface FeedbackList {
  threads: FeedbackSummary[]
  unreadCount: number
  /** 下一页的游标，没有更早的为 null */
  nextBefore: string | null
}

export interface FeedbackEngineInfo {
  name: string
  version: string | null
  /** 引擎检测状态，例如 ready / missing / error */
  status: string
}

/** 诊断信息：只有版本、系统这类字段，不含路径和数据目录 */
export interface FeedbackDiagnostics {
  appVersion: string
  channel: string
  os: string
  arch: string
  electron: string
  chrome: string
  node: string
  locale: string
  engines: FeedbackEngineInfo[]
}

/** 出错对话的报错片段：只有错误文字、会话编号和时间，不含对话内容 */
export interface FeedbackErrorSnippet {
  text: string
  sessionId: string
  at: number
}

export interface FeedbackAttachmentMeta {
  id: number
  kind: 'log' | 'image'
  name: string
  mediaType: string
  /** 存储大小（日志是压缩后的） */
  size: number
  /** 原始大小 */
  rawSize: number
  /** 过了保留期内容已清掉时为 false */
  available: boolean
}

export interface FeedbackMessage {
  id: number
  author: FeedbackAuthor
  /** message 普通消息 / closed、reopened 状态变化（显示成一行事件） */
  kind: 'message' | 'closed' | 'reopened'
  body: string
  createdAt: number
  diagnostics: FeedbackDiagnostics | null
  error: FeedbackErrorSnippet | null
  attachments: FeedbackAttachmentMeta[]
}

export interface FeedbackThread extends FeedbackSummary {
  closedBy: FeedbackAuthor | null
  closedAt: number | null
}

export interface FeedbackDetail {
  thread: FeedbackThread
  messages: FeedbackMessage[]
}

/** 提交前预览：给出将要发送的原文 */
export interface FeedbackPreviewQuery {
  /** 日志时间窗；不要日志时省略 */
  logs?: { since: number; until?: number }
}

export interface FeedbackLogPreview {
  /** 将要发送的原文（已脱敏、主目录换成 ~） */
  text: string
  lines: number
  bytes: number
  /** 超过上限时丢了最早的行 */
  truncated: boolean
  since: number
  until: number
}

export interface FeedbackPreview {
  diagnostics: FeedbackDiagnostics
  /** 诊断信息的文字版，预览里原样显示 */
  diagnosticsText: string
  logs: FeedbackLogPreview | null
}

export interface FeedbackImageInput {
  name: string
  mediaType: string
  /** base64，不带 data: 前缀 */
  data: string
}

/** 新反馈和补充都能带的附件 */
export interface FeedbackAttachInput {
  diagnostics: boolean
  /** 预览里显示过的日志原文；主进程再清洗一遍后压缩发送 */
  logs: string | null
  images: FeedbackImageInput[]
  error: FeedbackErrorSnippet | null
}

export interface FeedbackCreateInput extends FeedbackAttachInput {
  type: FeedbackType
  title: string
  body: string
}

export interface FeedbackReplyInput extends FeedbackAttachInput {
  body: string
}

export type FeedbackAttachmentData = { kind: 'image'; mediaType: string; data: string } | { kind: 'log'; text: string }

/**
 * 主进程维护的反馈状态：
 * signed-out 没登录 / ready 正常 / not-deployed 云端还没有反馈接口（404）/ error 最近一次检查失败
 */
export interface FeedbackState {
  status: 'signed-out' | 'ready' | 'not-deployed' | 'error'
  email: string | null
  unreadCount: number
  /** 第一页（轮询拿到的） */
  threads: FeedbackSummary[]
  nextBefore: string | null
  error: string | null
  checkedAt: number | null
}

export interface FeedbackChange {
  state: FeedbackState
  /** 这次检查新出现的团队回复（每条回复只出现一次），渲染层据此弹系统通知 */
  fresh: FeedbackSummary[]
}

/** 和云端一致的限额（services/cloud/internal/feedback/limits.go） */
export const FEEDBACK_LIMITS = {
  titleChars: 100,
  bodyChars: 10_000,
  errorChars: 4_000,
  images: 5,
  imageBytes: 2 * 1024 * 1024,
  /** 日志原文上限（压缩前） */
  logBytes: 1024 * 1024,
  /** 日志压缩后上限 */
  logPackedBytes: 512 * 1024,
} as const

// ---------------------------------------------------------------------------
// 手机经电脑网关用反馈（docs/mobile-app.md §8.5）：令牌不离开电脑，手机看不到邮箱
// ---------------------------------------------------------------------------

/** 给手机的反馈状态：去掉邮箱，只说登没登录 */
export type PhoneFeedbackState = Omit<FeedbackState, 'email'> & { signedIn: boolean }

/** 给手机的预览：电脑诊断信息的文字版 + 电脑日志（网关会截短再发） */
export interface PhoneFeedbackPreview {
  diagnosticsText: string
  logs: FeedbackLogPreview | null
}

/**
 * 主进程交给手机网关的反馈操作（feedback/feedback.ts 填进 AppContext）。参数是手机原样传来的，校验在里面做：
 * 新反馈 / 补充的 logs 是时间窗 { since, until } 或 null（日志在电脑上取），error 手机不带
 */
export interface PhoneFeedback {
  state(): PhoneFeedbackState
  list(before: unknown): Promise<FeedbackList>
  get(id: unknown): Promise<FeedbackDetail>
  attachment(threadId: unknown, attachmentId: unknown): Promise<FeedbackAttachmentData>
  preview(logs: unknown): Promise<PhoneFeedbackPreview>
  create(input: unknown): Promise<FeedbackDetail>
  reply(id: unknown, input: unknown): Promise<FeedbackDetail>
  close(id: unknown): Promise<FeedbackDetail>
  markAllRead(): Promise<void>
}
