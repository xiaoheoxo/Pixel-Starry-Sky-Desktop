// 会话视图里的回退（含代码、撤销）、分叉、旁聊（docs/ui/rewind-fork-sidechat.md §1–§3）
// 桌面版走引擎；演示模式用演示数据，只演示样子，不改任何东西
import { useEffect, useMemo, useRef, useState } from 'react'
import { ENGINES, validateFiles, validateImages, type SessionSnapshot } from '@pixelsky/protocol'
import { tr, translateMessage } from '@/i18n/core'
import { useComingSoon, useToast } from '@/ui'
import { demo, isDemo } from '@/data/demo'
import { bridge } from '@/features/engine'
import { appendComposerDraft, removeComposerDraftTail } from '@/features/engine/drafts'
import { updateFiles, updateImages } from '@/features/session/attachments/drafts'
import { fitAttachments } from '@/features/session/attachments/fit'
import { paneActions } from '@/features/panes/store'
import type { MessageActionsValue } from './live/MessageActions'
import type { RewindDone } from './ComposerNotices'
import type { SideAsk, SideCancel } from './sidechat/store'

interface UndoState extends RewindDone {
  /** 回退放进输入框的原文、图片和文件：撤销时拿掉 */
  text: string
  imageIds: string[]
  fileIds: string[]
}

export function useBranchActions(sessionId: string | null, snapshot: SessionSnapshot | null, composerKey: string) {
  const comingSoon = useComingSoon()
  const toast = useToast()
  const caps = snapshot ? ENGINES[snapshot.record.engine]?.caps : undefined
  const busy =
    !!snapshot &&
    (snapshot.state !== 'idle' || snapshot.queue.some(q => ['dispatching', 'running', 'delivering'].includes(q.status)))
  const [undo, setUndo] = useState<UndoState | null>(null)
  useEffect(() => setUndo(null), [sessionId])
  // 这个 hook 不随会话重新挂载：回退 / 撤销返回时核对还是不是发起时的会话，免得撤销栏出现在切过去的会话里
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId
  // 回退后开始了新的一轮：不能撤销了
  const state = snapshot?.state
  useEffect(() => {
    if (state && state !== 'idle') setUndo(null)
  }, [state])
  const firstUserId = snapshot?.items.find(i => i.kind === 'user')?.id ?? null
  const title = snapshot?.record.title ?? ''

  const messageActions = useMemo<MessageActionsValue | null>(() => {
    if (!sessionId || (!bridge && !isDemo) || !caps?.rewind) return null
    return {
      rewindDisabledReason: busy ? tr('session.message.rewindBusy') : null,
      rewindCode: caps.rewindCode === true,
      rewindPreview: async item => {
        if (bridge) return bridge.rewindPreview(sessionId, item.id)
        // 演示：像真的辅助进程一样等一会儿，看得到「正在检查」时也能只恢复对话（GitHub #35）
        await new Promise(resolve => setTimeout(resolve, 1500))
        return demo().conversations.rewindPreview(sessionId, item.id, firstUserId)
      },
      rewind: async (item, options) => {
        if (!bridge) {
          // 演示：只显示撤销栏
          setUndo({
            conversation: options.conversation,
            files: options.code ? 3 : null,
            text: '',
            imageIds: [],
            fileIds: [],
          })
          return
        }
        const result = await bridge.rewind(sessionId, item.id, options)
        // 选了对话和代码、代码没恢复（压缩之前的消息等，GitHub #82）：对话照样回退了，说一声
        if (result.codeSkipped) toast(tr('rewind.codeSkipped', { reason: translateMessage(result.codeSkipped) }))
        // 原消息的图片和文件放回输入框：输入框里已有的加上它们超了上限时，放得下的放回，放不下的说一声（保存失败输入框自己会提示）
        let images: { id: string }[] = [],
          files: { id: string }[] = [],
          dropped = 0
        if (options.conversation) {
          appendComposerDraft(composerKey, result.text)
          if (result.attachments?.length)
            await updateImages(composerKey, current => {
              const fit = fitAttachments(current, result.attachments!, validateImages)
              images = fit.added
              dropped += fit.dropped.length
              return fit.items
            }).catch(() => undefined)
          if (result.files?.length)
            await updateFiles(composerKey, current => {
              const fit = fitAttachments(current, result.files!, validateFiles)
              files = fit.added
              dropped += fit.dropped.length
              return fit.items
            }).catch(() => undefined)
          if (dropped) toast(tr('rewind.attachmentsDropped', { n: dropped }))
        }
        if (currentSession.current !== sessionId) return
        setUndo(
          result.undoable
            ? {
                conversation: options.conversation,
                files: result.filesRestored ?? null,
                text: options.conversation ? result.text : '',
                imageIds: images.map(i => i.id),
                fileIds: files.map(f => f.id),
              }
            : null,
        )
      },
      fork: caps.fork
        ? async item => {
            if (!bridge) {
              comingSoon(tr('fork.action'))
              return
            }
            const result = await bridge.fork(sessionId, item.id, `${title}${tr('fork.titleSuffix')}`)
            const key = result.record.id
            appendComposerDraft(key, result.text)
            if (result.attachments?.length) await updateImages(key, () => result.attachments!).catch(() => undefined)
            if (result.files?.length) await updateFiles(key, () => result.files!).catch(() => undefined)
            paneActions.open(key)
          }
        : null,
    }
  }, [sessionId, caps, busy, composerKey, firstUserId, title, comingSoon, toast])

  const undoRewind = async (): Promise<void> => {
    if (!sessionId || !undo) return
    if (bridge) await bridge.undoRewind(sessionId)
    removeComposerDraftTail(composerKey, undo.text)
    if (undo.imageIds.length) {
      const ids = new Set(undo.imageIds)
      await updateImages(composerKey, current => current.filter(i => !ids.has(i.id))).catch(() => undefined)
    }
    if (undo.fileIds.length) {
      const ids = new Set(undo.fileIds)
      await updateFiles(composerKey, current => current.filter(f => !ids.has(f.id))).catch(() => undefined)
    }
    if (currentSession.current === sessionId) setUndo(null)
  }

  const sideAsk: SideAsk = (id, question, history) =>
    bridge
      ? bridge.sideQuestion(id, question, history)
      : new Promise(resolve => setTimeout(() => resolve(demo().conversations.sideAnswer(question)), 900))
  const sideCancel: SideCancel = id => bridge?.cancelSideQuestion(id)
  const sideChat = caps?.sideChat
    ? {
        ask: sideAsk,
        cancel: sideCancel,
        disabledReason: bridge && !snapshot?.record.engineSessionId ? tr('side.needMessage') : null,
      }
    : null

  return { messageActions, undo, undoRewind, dismissUndo: () => setUndo(null), sideChat }
}
