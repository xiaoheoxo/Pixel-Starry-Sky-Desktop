// 团队频道的系统通知（docs/ui/channels-phase-c.md §6.2）：有人 @ 了我，或我的 AI 成员有新活等我同意。
// 云端有收件箱时改成看收件箱（docs/multica-learn.md §11.5）：一行的最近时间变新、没读、没延后的才弹；没有时照旧按消息算。
// 窗口级挂载一次，不渲染任何内容；演示模式不工作。遵守通知设置（勿扰、仅在后台时通知、声音），正在看这个频道时不发。
import { useEffect } from 'react'
import { codexPlainText } from '@pixelsky/protocol'
import { tr } from '../../i18n/core'
import { getPage, setPage } from '@/features/layout/page'
import { getNotificationPrefs } from '@/features/settings/notifications'
import { shouldNotify } from '@/features/feedback/logic'
import { channelActions, channelsBridge, getChannels, selectedChannel, selfIdIn, subscribeChannels } from './store'
import { channelOfNotice, teamNotice, teamNoticeId } from './teamModel'
import { freshInbox, INBOX_KIND } from './teamInboxModel'

/** 重连后补齐的旧消息不提醒：只提醒这么久以内的 */
const RECENT_MS = 10 * 60_000
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function TeamNotifier() {
  useEffect(() => {
    const bridge = window.pixelsky
    if (!bridge || bridge.demo || !channelsBridge) return
    // 同一张卡会因为状态变化反复推送，每条消息只提醒一次
    const seen = new Set<string>()
    /** 不弹：正在看这个频道，或通知设置不让 */
    const quiet = (channelId: string, now: number): ReturnType<typeof getNotificationPrefs> | null => {
      const focused = document.hasFocus()
      if (focused && getPage() === 'channels' && selectedChannel(getChannels())?.id === channelId) return null
      const prefs = getNotificationPrefs()
      return shouldNotify(prefs, focused, now) ? prefs : null
    }
    // 收件箱：和上次看到的比，变新的才弹（第一次拿到只记下）
    let inboxSeen: Map<string, number> | null = null
    let lastInbox = getChannels().inbox
    const offInbox = subscribeChannels(() => {
      const state = getChannels()
      if (!state.inboxSupported || state.inbox === lastInbox) return
      lastInbox = state.inbox
      const now = Date.now()
      const { notify, seen: next } = freshInbox(inboxSeen, state.inbox, now)
      inboxSeen = next
      for (const it of notify) {
        const prefs = quiet(it.channelId, now)
        if (!prefs) continue
        const name = state.members.find(m => m.id === it.actor)?.name ?? tr('inbox.unknown')
        const channel = state.channels.find(c => c.id === it.channelId)
        void bridge.notifications
          .show({
            id: `team:${it.channelId}:inbox:${it.key}`,
            title: clip(tr(INBOX_KIND[it.kind], { name }) + (channel ? ` · # ${channel.name}` : ''), 120),
            body: clip(it.text, 300),
            sessionId: null,
            sound: prefs.sound,
            attention: false,
          })
          .catch(() => {})
      }
    })
    const offMessages = channelsBridge.onMessage(({ channelId, message }) => {
      const state = getChannels()
      // 云端有收件箱：由上面那条管
      if (state.inboxSupported) return
      const channel = state.channels.find(c => c.id === channelId)
      const notice = teamNotice(message, channel, selfIdIn(state, channel?.memberIds))
      if (!notice) return
      const key = `${notice.kind}:${message.id}`
      if (seen.has(key)) return
      if (seen.size > 500) seen.clear()
      seen.add(key)
      const now = Date.now()
      if (now - message.at > RECENT_MS) return
      const prefs = quiet(channelId, now)
      if (!prefs) return
      const name = (id: string) => state.members.find(m => m.id === id)?.name ?? '?'
      const content =
        message.kind === 'task'
          ? {
              title: tr('team.notify.approval', { agent: name(message.assigneeId) }),
              body: tr('team.notify.approvalBody', { author: name(message.authorId), title: message.title }),
            }
          : message.kind === 'message'
            ? {
                title: tr('team.notify.mentioned', { author: name(message.authorId), channel: channel?.name ?? '' }),
                body: codexPlainText(message.text).replace(/\s+/g, ' ').trim(),
              }
            : null
      if (!content) return
      void bridge.notifications
        .show({
          id: teamNoticeId(notice),
          title: clip(content.title, 120),
          body: clip(content.body, 300),
          sessionId: null,
          sound: prefs.sound,
          attention: false,
        })
        .catch(() => {})
    })
    // 点通知：主进程已经把窗口带到前台，这里打开频道页并选中那个频道
    const offClicks = bridge.notifications.onClick(({ id }) => {
      const channelId = channelOfNotice(id)
      if (!channelId) return
      setPage('channels')
      // 收件箱来的：跳到那张卡（focusMessage 会关掉「需要你」）
      const inbox = /^team:[^:]+:inbox:(.+)$/.exec(id)
      if (inbox) return void channelActions.focusMessage(channelId, inbox[1])
      // 开着「需要你」时先关掉，让这个频道真的显示出来（显示了才标已读）
      channelActions.openNeeds(false)
      channelActions.select(channelId)
    })
    return () => {
      offInbox()
      offMessages()
      offClicks()
    }
  }, [])
  return null
}
