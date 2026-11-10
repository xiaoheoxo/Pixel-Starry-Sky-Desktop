// 频道输入框的斜杠命令（docs/ui/channels-local-rest.md §3.3 a）：命令表、菜单筛选、解析、/置顶 的目标
import { allMessages, tr } from '../../i18n/core'
import type { ChannelMessage } from '@/data/types'
import type { Quotable } from './ChannelMessage'

export type SlashId = 'flow' | 'archive' | 'pin' | 'notify' | 'members' | 'digest'

/** 菜单顺序 */
export const SLASH_IDS: readonly SlashId[] = ['flow', 'archive', 'pin', 'notify', 'members', 'digest']

/** 中英两套名字（界面语言是哪种都认） */
const names = (id: SlashId): string[] => {
  const name = allMessages[`channels.slash.${id}`]
  return [name.zh, name.en.toLowerCase()]
}

/** 按界面语言显示 / 补全的名字 */
export const slashName = (id: SlashId): string => tr(`channels.slash.${id}`)

/** 整段输入是「/词」（还没打空格）时返回这个词，菜单按它筛选；否则 undefined */
export function slashQuery(value: string): string | undefined {
  return /^\/(\S*)$/.exec(value)?.[1].toLowerCase()
}

/** 名字或说明里包含 query 的命令 */
export function matchSlash(query: string, available: readonly SlashId[]): SlashId[] {
  return available.filter(id =>
    [...names(id), tr(`channels.slash.${id}.desc`).toLowerCase()].some(text => text.includes(query)),
  )
}

/** 第一个词正好是可用的命令名时返回命令和后面的参数；不认识的 /xxx 返回 null，照常当消息发出去 */
export function parseSlash(text: string, available: readonly SlashId[]): { id: SlashId; arg: string } | null {
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim())
  const id = match && available.find(x => names(x).includes(match[1].toLowerCase()))
  return id ? { id, arg: match[2].trim() } : null
}

/** /置顶 的目标：正在引用文字消息就是它，否则主时间线最后一条文字消息（不算流程卡、讨论串里的） */
export function pinTarget(messages: readonly ChannelMessage[], replyTo: Quotable | null): string | null {
  if (replyTo?.kind === 'message') return replyTo.id
  return messages.findLast(m => m.kind === 'message' && !m.threadId && !m.flow)?.id ?? null
}
