// 输入框（聊天样子，docs/mobile-remote.md §21.12.3）：左边圆形「+」、中间胶囊输入框、右边一个键——
// 运行中且没字是方形「停止」，其余是发送（运行中发的消息由电脑排队，docs/ui/message-queue.md）。可以带图片（拍照 / 相册，在手机上压缩，
// docs/mobile-remote.md §17 第 1 项）。草稿由外面管：队列里撤回的消息会放回这里。
// 电脑浏览器、接了键盘的平板（精确指针）：回车发送、Shift+回车换行（§18.3）；手机软键盘的回车是换行。
// 这一轮答完、输入框是空的时候，上面一排快捷回复，点一下直接发（§23）。
import { ArrowUp, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ENGINES, type EngineId } from '@pixelsky/protocol'
import type { DesktopLink } from '@/connection'
import { imageDataUrl, usePendingImages } from '@/data/images'
import { attemptFor, sendKey, type SendAttempt } from '@/data/retry'
import { FINE_POINTER, Spinner, cn, useMedia } from '@/ui'
import { AttachButton, AttachmentStrip } from '@/ui/images'

/** 快捷回复：点了原样发出去 */
export const QUICK_REPLIES = ['继续', '按你推荐的来', '提交吧']

export function Composer({
  link,
  sessionId,
  engine,
  canAct,
  running,
  suggest = false,
  draft,
  onDraft,
}: {
  link: DesktopLink | undefined
  sessionId: string
  engine: EngineId
  canAct: boolean
  /** 会话页算好的「正在跑」（含启动中） */
  running: boolean
  /** 这一轮答完了：输入框空着时显示快捷回复 */
  suggest?: boolean
  draft: string
  onDraft(text: string): void
}) {
  const images = usePendingImages()
  const enterSends = useMedia(FINE_POINTER)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 刚发过快捷回复：会话页那边还没看到这条消息（suggest 还是 true）时先不再显示，消息到了 suggest 变 false 再放开
  const [quickSent, setQuickSent] = useState(false)
  useEffect(() => {
    if (!suggest) setQuickSent(false)
  }, [suggest])
  // 发送中又输入了新的话：发完只清掉发出去的那句和那几张图，不清新输入的
  const latest = useRef(draft)
  latest.current = draft
  const ready = canAct && (!!draft.trim() || images.images.length > 0) && !busy && !images.busy
  // 上次没发成功的内容和它的 ID：原样重发时沿用，电脑上能认出是同一条（data/retry.ts）
  const attempt = useRef<SendAttempt | null>(null)
  // quick：点了快捷回复，只发这句，不动输入框和图片
  const send = async (quick?: string) => {
    const sent = draft,
      value = quick ?? draft.trim(),
      attachments = quick ? [] : images.images
    if (!link || (!value && !attachments.length)) return
    setBusy(true)
    setError(null)
    const current = attemptFor(
      attempt.current,
      sendKey(
        sessionId,
        value,
        attachments.map(i => i.id),
      ),
      () => crypto.randomUUID(),
    )
    attempt.current = current
    try {
      await link.call('engine:send', sessionId, {
        text: value,
        clientMessageId: current.id,
        ...(attachments.length ? { attachments } : {}),
      })
      attempt.current = null
      if (quick) return setQuickSent(true)
      if (latest.current === sent) onDraft('')
      images.discard(attachments.map(i => i.id))
    } catch (e) {
      setError((e as Error).message === 'MOBILE_FORBIDDEN' ? '这部手机是「只看」。' : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const stop = () => void link?.call('engine:interrupt', sessionId).catch(() => undefined)
  // 运行中且没字：右边键是停止；有字（或带图）仍是发送，消息进队列
  const stopping = running && !draft.trim() && images.images.length === 0
  const name =
    ({ claude: 'Claude', codex: 'Codex', pixel: '像素星空' } as Partial<Record<EngineId, string>>)[engine] ??
    ENGINES[engine]?.name
  const shownError = error ?? images.error
  const quick = suggest && !quickSent && canAct && !busy && !draft.trim() && !images.images.length
  return (
    <div className="px-3 pt-1 pb-2">
      {shownError && <p className="px-1 pb-1.5 text-meta text-danger">{shownError}</p>}
      {quick && (
        <div className="no-scrollbar -mx-3 flex gap-2 overflow-x-auto px-3 pb-2">
          {QUICK_REPLIES.map(text => (
            <button
              key={text}
              type="button"
              onClick={() => void send(text)}
              className="min-h-9 shrink-0 rounded-full border border-line-subtle bg-surface px-3.5 text-meta text-fg-secondary active:bg-hover"
            >
              {text}
            </button>
          ))}
        </div>
      )}
      <AttachmentStrip
        images={images.images.map(i => ({ id: i.id, src: imageDataUrl(i) }))}
        busy={images.busy}
        onRemove={images.remove}
      />
      <div className="flex items-end gap-2">
        <AttachButton disabled={!canAct || busy} onFiles={files => void images.add(files)} />
        <div className="flex min-w-0 flex-1 items-end gap-1 rounded-3xl border border-line-composer bg-surface py-1.5 pr-1.5 pl-3.5 shadow-composer focus-within:border-line-composer-focus">
          <textarea
            value={draft}
            onChange={e => onDraft(e.target.value)}
            onKeyDown={e => {
              if (!enterSends || e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
              e.preventDefault()
              if (ready) void send()
            }}
            rows={1}
            disabled={!canAct}
            enterKeyHint="send"
            placeholder={!canAct ? '连接后才能发消息' : running ? '补充说明（会排在后面）…' : `给 ${name} 发消息`}
            className="field-sizing-content max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-prose text-fg outline-none placeholder:text-fg-faint"
          />
          {stopping ? (
            <button
              type="button"
              aria-label="停止"
              disabled={!canAct}
              onClick={stop}
              className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-fg disabled:bg-subtle disabled:text-fg-faint"
            >
              <Square size={13} className="fill-current" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="发送"
              disabled={!ready}
              onClick={() => void send()}
              className={cn(
                'mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-colors',
                ready ? 'bg-primary text-primary-fg' : 'bg-subtle text-fg-faint',
              )}
            >
              {busy ? <Spinner size={14} /> : <ArrowUp size={18} strokeWidth={2.25} />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
