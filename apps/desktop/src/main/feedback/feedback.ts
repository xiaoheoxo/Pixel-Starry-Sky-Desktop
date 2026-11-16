// 设置 › 反馈的主进程部分（docs/ui/feedback.md §5）：IPC、轮询、通知去重。
// 系统通知由渲染层按通知设置决定弹不弹，这里只把「新出现的团队回复」随 feedback:changed 推过去。
import { join } from 'node:path'
import { app } from 'electron'
import { logger } from '@pixelsky/engine'
import * as ipc from '../ipc/guard'
import type { AppContext } from '../app/context'
import { appInfo } from '../app/info'
import { shrinkImage } from '../app/images'
import { logService } from '../app/logging'
import { windowLocale } from '../app/ui-language'
import { onAccountChange, signedInEmail } from '../account/account'
import {
  type FeedbackAttachmentData,
  type FeedbackCreateInput,
  type FeedbackDetail,
  type FeedbackDiagnostics,
  type FeedbackList,
  type FeedbackLogPreview,
  type FeedbackPreview,
  type FeedbackPreviewQuery,
  type FeedbackReplyInput,
  type FeedbackState,
  type FeedbackSummary,
  type FeedbackType,
} from '../../shared/types/feedback'
import {
  checkAttachmentId,
  checkThreadId,
  closeFeedback,
  createFeedback,
  fetchAttachment,
  FeedbackError,
  getFeedback,
  listFeedback,
  markAllFeedbackRead,
  replyFeedback,
} from './api'
import {
  buildAttachFields,
  buildDiagnostics,
  buildLogs,
  checkBody,
  checkTitle,
  phoneInput,
  type MessageDeps,
} from './attachments'
import { FeedbackTracker, FileNotifiedStore } from './tracker'

/** 定时器多久醒一次，看要不要检查（只比时间，不发请求）；真正的间隔由 tracker.pollInterval() 决定 */
const TICK_MS = 30_000
/** 切回窗口时，离上次检查至少这么久才再查 */
const FOCUS_MIN_INTERVAL_MS = 15_000
/** 预览日志的默认时间窗 */
const DEFAULT_LOG_WINDOW_MS = 2 * 3_600_000

const log = logger('feedback')

function clientLocale(): string {
  return windowLocale().startsWith('zh') ? 'zh' : 'en'
}

function parseTime(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name}不对`)
  return value
}

function parseType(value: unknown): FeedbackType {
  if (value === 'bug' || value === 'feature' || value === 'other') return value
  throw new Error('反馈类型不对')
}

/** 渲染层参数必须是对象 */
function asObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}参数不对`)
  return value as Record<string, unknown>
}

/** 日志服务没起来（例如测试环境）时给一个空读取器 */
const emptyLogs = { read: async () => [] }

export function initFeedback(ctx: AppContext): void {
  const tracker = new FeedbackTracker({
    list: () => listFeedback(null),
    store: new FileNotifiedStore(join(app.getPath('userData'), 'feedback.json')),
    emit: change => ctx.events.broadcast('feedback:changed', change),
    onError: e => log.warn('检查反馈失败', e),
  })

  async function engineBriefs(): Promise<{ name: string; version: string | null; status: string }[]> {
    try {
      const list = (await ctx.engine?.engines()) ?? []
      return list.map(e => ({ name: e.name, version: e.version, status: e.status }))
    } catch {
      return []
    }
  }

  const diagnostics = async (): Promise<ReturnType<typeof buildDiagnostics>> =>
    buildDiagnostics(appInfo(), await engineBriefs(), clientLocale())

  const deps: MessageDeps = {
    diagnostics: async (): Promise<FeedbackDiagnostics> => (await diagnostics()).diagnostics,
    client: () => {
      const info = appInfo()
      return { app_version: info.version, channel: info.channel, os: info.os, arch: info.arch, locale: clientLocale() }
    },
    shrink: shrinkImage,
  }

  /** 登录状态：没登录就不发请求 */
  const requireEmail = (): string => {
    const email = signedInEmail()
    if (!email) throw new Error('请先登录像素星空账号')
    return email
  }

  /** 提交 / 补充 / 打开 / 关闭之后顺便检查一次未读；检查结果不影响本次返回 */
  const afterAction = <T>(result: T): T => {
    void tracker.poll().catch(() => undefined)
    return result
  }

  const trackSignIn = (): void => {
    void tracker.setAccount(signedInEmail()).catch(() => undefined)
  }
  onAccountChange(trackSignIn)
  trackSignIn()

  setInterval(() => {
    if (tracker.due()) void tracker.poll().catch(() => undefined)
  }, TICK_MS).unref()
  app.on('browser-window-focus', () => {
    if (tracker.sinceLastPoll() >= FOCUS_MIN_INTERVAL_MS) void tracker.poll().catch(() => undefined)
  })

  const deny = { deny: '不允许的调用方' }

  ipc.handle('feedback:state', (): FeedbackState => tracker.state(), deny)
  ipc.handle('feedback:refresh', (): Promise<FeedbackState> => tracker.poll(), deny)
  // 新回复的提醒：界面处理完才记成已提醒；窗口打开时取回没处理的（审查报告 2026-10-14）
  ipc.handle('feedback:pending', (): FeedbackSummary[] => tracker.unacknowledged(), deny)
  ipc.handle(
    'feedback:ack',
    (_event, ids: unknown): void => {
      if (!Array.isArray(ids) || ids.length > 200 || !ids.every(id => typeof id === 'string' && id.length <= 200))
        throw new Error('参数不对')
      tracker.acknowledge(ids)
    },
    deny,
  )
  /** 设置页和手机（经网关，docs/mobile-app.md §8.5）共用的操作：参数校验在这里，两边一样 */
  const ops = {
    async markAllRead(): Promise<void> {
      requireEmail()
      await markAllFeedbackRead()
      // 走现有的检查：feedback:changed 推送新状态；检查失败不算标记失败
      await tracker.poll().catch(() => undefined)
    },
    async list(before: unknown): Promise<FeedbackList> {
      requireEmail()
      if (before !== null && before !== undefined && (typeof before !== 'string' || !before || before.length > 200))
        throw new Error('分页参数不对')
      return listFeedback(before ?? null)
    },
    async get(id: unknown): Promise<FeedbackDetail> {
      requireEmail()
      return afterAction(await getFeedback(checkThreadId(id)))
    },
    async create(raw: unknown): Promise<FeedbackDetail> {
      requireEmail()
      const input = asObject(raw, '反馈') as unknown as FeedbackCreateInput
      const type = parseType(input.type)
      const title = checkTitle(input.title)
      const body = checkBody(input.body)
      const fields = await buildAttachFields(input, deps)
      const detail = await createFeedback({ type, title, body, ...fields })
      log.info('提交反馈', { type, attachments: fields.attachments.length })
      tracker.markActive()
      return afterAction(detail)
    },
    async reply(id: unknown, raw: unknown): Promise<FeedbackDetail> {
      requireEmail()
      const threadId = checkThreadId(id)
      const input = asObject(raw, '补充') as unknown as FeedbackReplyInput
      const body = checkBody(input.body)
      const fields = await buildAttachFields(input, deps)
      const detail = await replyFeedback(threadId, { body, ...fields })
      log.info('补充反馈', { attachments: fields.attachments.length })
      tracker.markActive()
      return afterAction(detail)
    },
    async close(id: unknown): Promise<FeedbackDetail> {
      requireEmail()
      return afterAction(await closeFeedback(checkThreadId(id)))
    },
    /** 日志时间窗：until 省略为现在，since 省略为往前 2 小时 */
    async logs(raw: unknown): Promise<FeedbackLogPreview> {
      const w = asObject(raw, '日志时间窗')
      const until = w.until === undefined ? Date.now() : parseTime(w.until, '日志结束时间')
      const since = w.since === undefined ? until - DEFAULT_LOG_WINDOW_MS : parseTime(w.since, '日志开始时间')
      if (since >= until) throw new Error('日志时间窗不对')
      return buildLogs(logService() ?? emptyLogs, since, until)
    },
    async preview(raw: unknown): Promise<FeedbackPreview> {
      const query = (raw ?? {}) as FeedbackPreviewQuery
      asObject(query, '预览')
      const d = await diagnostics()
      const logs = query.logs !== undefined && query.logs !== null ? await ops.logs(query.logs) : null
      return { diagnostics: d.diagnostics, diagnosticsText: d.text, logs }
    },
    async attachment(threadId: unknown, attachmentId: unknown): Promise<FeedbackAttachmentData> {
      requireEmail()
      const { bytes, mediaType } = await fetchAttachment(checkThreadId(threadId), checkAttachmentId(attachmentId))
      if (mediaType.startsWith('image/')) return { kind: 'image', mediaType, data: bytes.toString('base64') }
      if (mediaType.startsWith('text/')) return { kind: 'log', text: bytes.toString('utf8') }
      throw new FeedbackError('不支持的附件类型', 'INVALID')
    },
  }

  ipc.handle('feedback:markAllRead', () => ops.markAllRead(), deny)
  ipc.handle('feedback:list', (_event, before: unknown) => ops.list(before), deny)
  ipc.handle('feedback:get', (_event, id: unknown) => ops.get(id), deny)
  ipc.handle('feedback:create', (_event, raw: unknown) => ops.create(raw), deny)
  ipc.handle('feedback:reply', (_event, id: unknown, raw: unknown) => ops.reply(id, raw), deny)
  ipc.handle('feedback:close', (_event, id: unknown) => ops.close(id), deny)
  ipc.handle('feedback:preview', (_event, raw: unknown) => ops.preview(raw), deny)
  ipc.handle(
    'feedback:attachment',
    (_event, threadId: unknown, attachmentId: unknown) => ops.attachment(threadId, attachmentId),
    deny,
  )

  // 手机经网关用的那一份：不带邮箱；日志由手机给时间窗、这里取（原文不经手机来回传）
  ctx.feedback = {
    state: () => {
      const { email, ...rest } = tracker.state()
      return { ...rest, signedIn: email !== null }
    },
    list: ops.list,
    get: ops.get,
    attachment: ops.attachment,
    close: ops.close,
    markAllRead: ops.markAllRead,
    preview: async window => {
      const d = await diagnostics()
      return { diagnosticsText: d.text, logs: window ? await ops.logs(window) : null }
    },
    create: async raw => ops.create(await phoneInput(raw, ops.logs)),
    reply: async (id, raw) => ops.reply(id, await phoneInput(raw, ops.logs)),
  }
}
