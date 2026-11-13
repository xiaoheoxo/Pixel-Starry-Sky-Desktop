// 新反馈的草稿（docs/ui/feedback.md §2.3）：文字按账号存在 localStorage，图片只放内存（重启就没了），不存日志原文；提交成功后清掉
import type { ImageAttachment } from '@pixelsky/protocol'
import type { FeedbackType } from '../../../../shared/types/feedback'

export type LogWindow = 'around' | '30m' | '2h' | '24h'

export interface FeedbackDraft {
  type: FeedbackType
  title: string
  body: string
  steps: string
  diagnostics: boolean
  /** null = 用户没动过，跟着类型走（问题默认勾选，其他不勾） */
  logs: boolean | null
  window: LogWindow
}

export const EMPTY_DRAFT: FeedbackDraft = {
  type: 'bug',
  title: '',
  body: '',
  steps: '',
  diagnostics: true,
  logs: null,
  window: '2h',
}

const PREFIX = 'pixelsky.feedback.draft.v1:'
export const draftKey = (email: string): string => PREFIX + email

const TYPES: FeedbackType[] = ['bug', 'feature', 'other']
const WINDOWS: LogWindow[] = ['around', '30m', '2h', '24h']

/** 本机保存的草稿可能损坏或来自旧版本：逐项校验，不合法的用默认值 */
export function sanitizeDraft(raw: unknown): FeedbackDraft {
  const d = EMPTY_DRAFT
  if (!raw || typeof raw !== 'object') return { ...d }
  const v = raw as Record<string, unknown>
  const text = (key: string): string => (typeof v[key] === 'string' ? (v[key] as string) : '')
  return {
    type: TYPES.includes(v.type as FeedbackType) ? (v.type as FeedbackType) : d.type,
    title: text('title'),
    body: text('body'),
    steps: text('steps'),
    diagnostics: typeof v.diagnostics === 'boolean' ? v.diagnostics : d.diagnostics,
    logs: typeof v.logs === 'boolean' ? v.logs : null,
    window: WINDOWS.includes(v.window as LogWindow) ? (v.window as LogWindow) : d.window,
  }
}

export function loadDraft(email: string, storage: Pick<Storage, 'getItem'> = localStorage): FeedbackDraft {
  try {
    return sanitizeDraft(JSON.parse(storage.getItem(draftKey(email)) ?? 'null'))
  } catch {
    return { ...EMPTY_DRAFT }
  }
}

/** 什么都没填时不留草稿 */
export const isEmptyDraft = (d: FeedbackDraft): boolean => !d.title.trim() && !d.body.trim() && !d.steps.trim()

export function saveDraft(
  email: string,
  draft: FeedbackDraft,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage,
): void {
  try {
    if (isEmptyDraft(draft)) storage.removeItem(draftKey(email))
    else storage.setItem(draftKey(email), JSON.stringify(draft))
  } catch {
    /* 存不下就算了，表单里的内容仍在 */
  }
}

// localStorage 放不下图片：按账号放在内存里，关掉表单再打开还在
const draftImages = new Map<string, ImageAttachment[]>()
export const loadDraftImages = (email: string): ImageAttachment[] => draftImages.get(email) ?? []
export function saveDraftImages(email: string, images: ImageAttachment[]): void {
  if (images.length) draftImages.set(email, images)
  else draftImages.delete(email)
}

export function clearDraft(email: string, storage: Pick<Storage, 'removeItem'> = localStorage): void {
  draftImages.delete(email)
  try {
    storage.removeItem(draftKey(email))
  } catch {
    /* 忽略 */
  }
}
