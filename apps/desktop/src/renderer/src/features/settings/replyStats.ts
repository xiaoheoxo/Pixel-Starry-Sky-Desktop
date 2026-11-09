import { tr } from '../../i18n/core'
// 回复下方统计的全局显示偏好；所有窗格共用，刷新 / 重启后沿用本机选择。
import { useSyncExternalStore } from 'react'

export const REPLY_STAT_KEYS = [
  'elapsed',
  'tokens',
  'cost',
  'model',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheRead',
  'cacheWrite',
  'cacheHitRate',
  'requests',
  'speed',
  'firstToken',
] as const
export type ReplyStatKey = (typeof REPLY_STAT_KEYS)[number]
export const REPLY_STAT_LABELS: Record<ReplyStatKey, string> = {
  get elapsed() {
    return tr('session.turnStatsData.totalDuration')
  },
  get tokens() {
    return tr('settings.replyStats.tokensInputOutput')
  },
  get cost() {
    return tr('settings.replyStats.cost')
  },
  get model() {
    return tr('session.ModelSourceMenu.model')
  },
  get inputTokens() {
    return tr('settings.replyStats.uncachedInputTokens')
  },
  get outputTokens() {
    return tr('session.turnStatsData.outputTokens')
  },
  get totalTokens() {
    return tr('settings.replyStats.totalTokens')
  },
  get cacheRead() {
    return tr('session.contextData.cacheRead')
  },
  get cacheWrite() {
    return tr('session.contextData.cacheWrite')
  },
  get cacheHitRate() {
    return tr('settings.replyStats.cacheHitRate')
  },
  get requests() {
    return tr('settings.replyStats.modelRequestCount')
  },
  get speed() {
    return tr('usageColumns.speed')
  },
  get firstToken() {
    return tr('settings.usage.RemoteCallsTable.firstToken')
  },
}

/** 默认只显示用时，鼠标停上去看全部明细（docs/ui/conversation-concise.md §3 D） */
export const DEFAULT_REPLY_STATS: readonly ReplyStatKey[] = ['elapsed']
export const REPLY_STAT_GROUPS: readonly { label: string; keys: readonly ReplyStatKey[] }[] = [
  {
    get label() {
      return tr('settings.replyStats.basicInformation')
    },
    keys: ['elapsed', 'tokens', 'cost', 'model'],
  },
  {
    get label() {
      return tr('settings.replyStats.tokenBreakdown')
    },
    keys: ['inputTokens', 'outputTokens', 'totalTokens', 'cacheRead', 'cacheWrite', 'cacheHitRate'],
  },
  {
    get label() {
      return tr('settings.replyStats.requestStatistics')
    },
    keys: ['requests', 'speed', 'firstToken'],
  },
]

export function isDefaultReplyStats(keys: readonly ReplyStatKey[]): boolean {
  return keys.length === DEFAULT_REPLY_STATS.length && DEFAULT_REPLY_STATS.every(key => keys.includes(key))
}

const KEY = 'pixelsky.reply-stats'
const DEFAULT_STATS = DEFAULT_REPLY_STATS

function load(): readonly ReplyStatKey[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!Array.isArray(saved)) return DEFAULT_STATS
    // 去重并按显示顺序整理；空数组表示用户主动关闭整行。
    const valid = REPLY_STAT_KEYS.filter(key => saved.includes(key))
    return saved.length > 0 && valid.length === 0 ? DEFAULT_STATS : valid
  } catch {
    return DEFAULT_STATS
  }
}

let selected = load()
const listeners = new Set<() => void>()
const getSnapshot = () => selected

function update(next: readonly ReplyStatKey[]): void {
  selected = next
  try {
    localStorage.setItem(KEY, JSON.stringify(selected))
  } catch {
    // 存储不可用时，当前窗口内仍可正常切换。
  }
  listeners.forEach(listener => listener())
}

export function setReplyStat(key: ReplyStatKey, enabled: boolean): void {
  update(REPLY_STAT_KEYS.filter(k => (k === key ? enabled : selected.includes(k))))
}

export function resetReplyStats(): void {
  update(DEFAULT_STATS)
}

function onStorage(event: StorageEvent): void {
  if (event.storageArea !== localStorage || (event.key !== KEY && event.key !== null)) return
  selected = load()
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}

export function useReplyStats(): readonly ReplyStatKey[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
