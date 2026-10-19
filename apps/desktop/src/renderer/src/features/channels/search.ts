// 频道消息搜索（docs/ui/channels-local-ai.md §3.1 #8）：频道列表的搜索框和 Ctrl+P 全局搜索共用。
import { containsTerms, searchSnippet, searchTerms } from '@pixelsky/protocol'
import { useEffect, useState } from 'react'
import type { Channel, ChannelMessage } from '@/data/types'
import type { ChannelSearchHit, ChannelSearchResult } from '../../../../shared/types/channels'
import { channelsBridge, getChannels } from './store'

export const NO_HITS: ChannelSearchResult = { hits: [], truncated: false }

/**
 * 在读进来的消息里搜（演示模式用；规则和主进程 Channels.search 一样）：
 * 文字消息和任务卡标题，每个词都要出现，新的在前
 */
export function searchLoaded(
  channels: readonly Channel[],
  messages: Readonly<Record<string, readonly ChannelMessage[] | undefined>>,
  text: string,
  opts: { limit: number; projectId?: string | null },
): ChannelSearchResult {
  const terms = searchTerms(text)
  if (!terms.length) return NO_HITS
  const found: { m: Extract<ChannelMessage, { kind: 'message' | 'task' }>; body: string }[] = []
  for (const c of channels) {
    if (c.scope !== 'local' || (opts.projectId && c.projectId !== opts.projectId)) continue
    for (const m of messages[c.id] ?? []) {
      const body = m.kind === 'message' ? m.text : m.kind === 'task' ? m.title : ''
      if (m.kind !== 'event' && body && containsTerms(body, terms)) found.push({ m, body })
    }
  }
  found.sort((a, b) => b.m.at - a.m.at)
  return {
    hits: found.slice(0, opts.limit).map(({ m, body }) => ({
      channelId: m.channelId,
      messageId: m.id,
      kind: m.kind,
      authorId: m.kind === 'task' ? m.assigneeId : m.authorId,
      at: m.at,
      snippet: searchSnippet(body, terms),
    })),
    truncated: found.length > opts.limit,
  }
}

/** 搜频道消息：正式模式问主进程（含还没读进来的消息），演示模式搜内存里的演示消息 */
export function searchChannelMessages(
  text: string,
  opts: { limit: number; projectId?: string | null },
): Promise<ChannelSearchResult> {
  if (!text.trim()) return Promise.resolve(NO_HITS)
  if (channelsBridge) return channelsBridge.search(text, opts)
  const s = getChannels()
  return Promise.resolve(searchLoaded(s.channels, s.messages, text, opts))
}

/** 一条结果的说明：「#频道 · 作者」，归档的频道注明 */
export function hitPlace(
  hit: ChannelSearchHit,
  channels: readonly Channel[],
  names: ReadonlyMap<string, string>,
): { channel: string; archived: boolean; author: string } {
  const channel = channels.find(c => c.id === hit.channelId)
  return {
    channel: channel?.name ?? '?',
    archived: !!channel?.archivedAt,
    author: names.get(hit.authorId) ?? '?',
  }
}

/** 输入停一下再搜（150ms）；搜索词变了，旧的结果不要 */
export function useChannelSearch(
  text: string,
  opts: { limit: number; enabled?: boolean },
): ChannelSearchResult & { loading: boolean } {
  const [result, setResult] = useState<ChannelSearchResult & { loading: boolean }>({ ...NO_HITS, loading: false })
  const enabled = opts.enabled !== false && !!text.trim()
  useEffect(() => {
    if (!enabled) {
      setResult({ ...NO_HITS, loading: false })
      return
    }
    let live = true
    setResult(r => ({ ...r, loading: true }))
    const timer = window.setTimeout(() => {
      searchChannelMessages(text, { limit: opts.limit })
        .then(
          r => live && setResult({ ...r, loading: false }),
          () => live && setResult({ ...NO_HITS, loading: false }),
        )
        .catch(() => undefined)
    }, 150)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [text, enabled, opts.limit])
  return result
}
