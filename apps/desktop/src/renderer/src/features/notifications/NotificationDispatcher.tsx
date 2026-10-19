// 系统通知调度（docs/ui/notifications.md §3–§4）：监听所有机器的引擎事件，按偏好决定是否让主进程弹出。
// 窗口级挂载一次，不渲染任何内容；演示模式不工作。
import { useEffect, useRef } from 'react'
import { tr, translateMessage } from '../../i18n/core'
import { getEngineState, isViewingSession, subscribeEngine } from '@/features/engine/store'
import { OPEN_SESSION_EVENT } from '@/features/engine/openRequests'
import { getNotificationPrefs, useNotificationPrefs } from '@/features/settings/notifications'
import { useSettings } from '@/features/settings/SettingsProvider'
import { recovered } from '@/features/recovery/recovered'
import { requestFeedback } from '@/features/feedback/focus'
import { threadOfNotification } from '@/features/feedback/logic'
import { getPage, setPage } from '@/features/layout/page'
import { channelActions, getChannels, selectedChannel } from '@/features/channels/store'
import { channelNotice, taskOfNotice } from '@/features/channels/channelNotice'
import {
  BACKGROUND_SETTLE_MS,
  backgroundChange,
  createDeliveryState,
  decide,
  notificationFor,
  recoveredIntents,
  settledIntent,
  type NotificationIntent,
} from './policy'

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function payload(
  intent: NotificationIntent,
  summary: boolean,
  count: number,
): { title: string; body: string; sessionId: string | null } {
  if (summary)
    return { title: tr('notifications.title'), body: tr('notifications.body.summary', { count }), sessionId: null }
  const record = getEngineState().sessions.find(s => s.record.id === intent.sessionId)?.record
  const title = clip(record?.title || tr('notifications.title'), 120)
  const detail = intent.detail ? clip(translateMessage(intent.detail).replace(/\s+/g, ' ').trim(), 120) : ''
  const body =
    intent.kind === 'completed'
      ? tr('notifications.body.completed')
      : intent.kind === 'failed'
        ? detail
          ? tr('notifications.body.failedWith', { error: detail })
          : tr('notifications.failed.title')
        : detail
          ? tr('notifications.body.waitingWith', { detail })
          : tr('notifications.waiting.title')
  return { title, body: clip(body, 300), sessionId: intent.sessionId }
}

export function NotificationDispatcher() {
  // 托盘菜单显示「勿扰 1 小时」还是「结束勿扰」（docs/ui/tray.md §2.2）
  const { dndUntil } = useNotificationPrefs()
  const { openSettings } = useSettings()
  const openSettingsRef = useRef(openSettings)
  openSettingsRef.current = openSettings
  useEffect(() => {
    if (!window.pixelsky?.demo) window.pixelsky?.tray?.reportDnd(dndUntil)
  }, [dndUntil])
  useEffect(() => {
    const bridge = window.pixelsky
    if (!bridge || bridge.demo) return
    const state = createDeliveryState()
    const deliver = (intent: NotificationIntent) => {
      const prefs = getNotificationPrefs()
      // 频道派出去的活：按频道的说法写，点开回到频道里那张卡（docs/ui/channels-local-ai.md §3.1 #12）
      const channels = getChannels()
      const record = getEngineState().sessions.find(s => s.record.id === intent.sessionId)?.record
      const detail = intent.detail ? translateMessage(intent.detail) : ''
      const channel = channelNotice(intent, detail, channels, record?.title ?? null)
      // 这个频道调成了不提醒 / 只提醒要我处理的：会话自己的提醒也不发（同一件事）
      if (channel?.muted) return
      const viewingChannel =
        !!channel && getPage() === 'channels' && selectedChannel(channels)?.id === channel.channelId
      const decision = decide(
        intent,
        {
          prefs,
          focused: document.hasFocus(),
          viewing: isViewingSession(intent.sessionId) || viewingChannel,
          now: Date.now(),
        },
        state,
      )
      if (!decision.show) return
      const content =
        channel && !decision.summary
          ? { title: channel.title, body: channel.body, sessionId: intent.sessionId }
          : payload(intent, decision.summary, state.recent.length)
      void bridge.notifications
        .show({
          id: decision.summary ? `summary-${Date.now()}` : (channel?.id ?? intent.dedupeKey),
          ...content,
          sound: prefs.sound,
          attention: intent.kind === 'waiting',
        })
        .catch(() => {})
    }
    // 后台子智能体跑完后引擎通常马上接着开一轮，那一轮结束时提醒；一直没接着干就补一条（docs/ui/notifications.md §7）
    const settling = new Map<string, ReturnType<typeof setTimeout>>()
    const summaryOf = (id: string) => getEngineState().sessions.find(s => s.record.id === id)
    const offEvents = bridge.engine.onEvent(event => {
      const bg = backgroundChange(event, id => summaryOf(id)?.state === 'idle')
      if (bg) {
        clearTimeout(settling.get(bg.sessionId))
        settling.delete(bg.sessionId)
        if (bg.change === 'settled')
          settling.set(
            bg.sessionId,
            setTimeout(() => {
              settling.delete(bg.sessionId)
              const s = summaryOf(bg.sessionId)
              if (s?.state === 'idle' && !s.background) deliver(settledIntent(bg.sessionId, Date.now()))
            }, BACKGROUND_SETTLE_MS),
          )
      }
      const intent = notificationFor(event)
      if (intent) deliver(intent)
    })
    // 崩溃后重新加载：恢复期间丢掉的审批请求，等会话列表到了补一次（只补一次）
    let offRecovered: (() => void) | undefined
    if (recovered) {
      const catchUp = () => {
        if (!getEngineState().ready) return
        offRecovered?.()
        for (const intent of recoveredIntents(getEngineState().sessions)) deliver(intent)
      }
      offRecovered = subscribeEngine(catchUp)
      catchUp()
    }
    // 点击通知：主进程已经把窗口带到前台，这里打开对应会话（会自动切换机器、切回工作台）
    const offClicks = bridge.notifications.onClick(({ id, sessionId }) => {
      // 团队回复了反馈：打开设置 › 反馈 › 那一条（docs/ui/feedback.md §2.5）
      const threadId = threadOfNotification(id)
      if (threadId) {
        requestFeedback({ threadId })
        openSettingsRef.current('feedback')
        return
      }
      // 频道任务的提醒：回到频道，定位到那张卡
      const task = taskOfNotice(id)
      if (task) {
        setPage('channels')
        void channelActions.focusMessage(task.channelId, task.taskId)
        return
      }
      if (sessionId) window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId } }))
    })
    return () => {
      offEvents()
      offRecovered?.()
      offClicks()
      for (const timer of settling.values()) clearTimeout(timer)
    }
  }, [])
  return null
}
