// 输入框（iOS 样子，docs/mobile-remote.md §26）：一张浮起来的圆角卡片——上面整宽的输入框（有图片时先是缩略图），
// 下面一排：圆形「+」、模式胶囊（权限、模型，会话页给的 mode）、右边一个圆键。
// 圆键：运行中且没字是方形「停止」；运行中带字是「排队发送」（消息由电脑排队，docs/ui/message-queue.md）；其余是发送。
// 可以带图片（拍照 / 相册，在手机上压缩，docs/mobile-remote.md §17 第 1 项）。草稿由外面管：队列里撤回的消息会放回这里。
// 电脑浏览器、接了键盘的平板（精确指针）：回车发送、Shift+回车换行（§18.3）；手机软键盘的回车是换行。
// 以前答完后卡片上面有一排快捷回复（§23），用户说不需要，§26 去掉了。
import { ArrowUp, ListEnd, Square } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { ENGINES, type EngineId } from '@pixelsky/protocol'
import type { DesktopLink } from '@/connection'
import { imageDataUrl, usePendingImages } from '@/data/images'
import { attemptFor, sendKey, type SendAttempt } from '@/data/retry'
import { L } from '@/i18n'
import { FINE_POINTER, Spinner, cn, useMedia } from '@/ui'
import { AttachButton, AttachmentStrip } from '@/ui/images'

export function Composer({
  link,
  sessionId,
  engine,
  canAct,
  running,
  draft,
  onDraft,
  mode,
}: {
  link: DesktopLink | undefined
  sessionId: string
  engine: EngineId
  canAct: boolean
  /** 会话页算好的「正在跑」（含启动中） */
  running: boolean
  draft: string
  onDraft(text: string): void
  /** 模式胶囊（权限、模型），会话页给的，放在「+」和圆键中间；窄屏它们自己收窄 */
  mode?: ReactNode
}) {
  const images = usePendingImages()
  const enterSends = useMedia(FINE_POINTER)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 发送中又输入了新的话：发完只清掉发出去的那句和那几张图，不清新输入的
  const latest = useRef(draft)
  latest.current = draft
  const ready = canAct && (!!draft.trim() || images.images.length > 0) && !busy && !images.busy
  // 上次没发成功的内容和它的 ID：原样重发时沿用，电脑上能认出是同一条（data/retry.ts）
  const attempt = useRef<SendAttempt | null>(null)
  const send = async () => {
    const sent = draft,
      value = draft.trim(),
      attachments = images.images
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
      if (latest.current === sent) onDraft('')
      images.discard(attachments.map(i => i.id))
    } catch (e) {
      setError(
        (e as Error).message === 'MOBILE_FORBIDDEN'
          ? L('这部手机是「只看」。', 'This phone is “View only”.')
          : (e as Error).message,
      )
    } finally {
      setBusy(false)
    }
  }
  const stop = () => void link?.call('engine:interrupt', sessionId).catch(() => undefined)
  // 运行中且没字：右边键是停止；有字（或带图）仍是发送，消息进队列
  const stopping = running && !draft.trim() && images.images.length === 0
  const name =
    ({ claude: 'Claude', codex: 'Codex' } as Partial<Record<EngineId, string>>)[engine] ?? ENGINES[engine]?.name
  const shownError = error ?? images.error
  return (
    <div className="mx-auto w-full max-w-3xl px-3 pt-1 pb-3">
      {shownError && <p className="px-1 pb-1.5 text-meta text-danger">{shownError}</p>}
      <div className="rounded-[22px] border border-line-composer bg-surface px-2.5 pt-2.5 pb-2 shadow-composer focus-within:border-line-composer-focus">
        <AttachmentStrip
          images={images.images.map(i => ({ id: i.id, src: imageDataUrl(i) }))}
          busy={images.busy}
          onRemove={images.remove}
        />
        <textarea
          value={draft}
          onChange={e => onDraft(e.target.value)}
          onKeyDown={e => {
            if (!enterSends || e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            if (ready) void send()
          }}
          rows={1}
          data-key-target="composer"
          disabled={!canAct}
          enterKeyHint="send"
          placeholder={
            !canAct
              ? L('连上电脑后才能发消息，写好的字会留着', 'Connect to the computer to send. Your draft is kept.')
              : running
                ? L('补充说明（会排在后面）…', 'Add a follow-up (queued)…')
                : L(`给 ${name} 发消息`, `Message ${name}`)
          }
          className="field-sizing-content block max-h-40 min-h-7 w-full resize-none bg-transparent px-1 text-prose text-fg outline-none placeholder:text-fg-faint"
        />
        <div className="mt-2 flex items-center gap-2">
          <AttachButton disabled={!canAct || busy} onFiles={files => void images.add(files)} />
          {/* 胶囊容器占满中间：自己是弹性空隙，里面的胶囊在窄屏被挤着收窄 */}
          <div className="flex min-w-0 flex-1 items-center gap-2">{mode}</div>
          {stopping ? (
            <button
              type="button"
              aria-label={L('停止', 'Stop')}
              disabled={!canAct}
              onClick={stop}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-fg disabled:bg-subtle disabled:text-fg-faint"
            >
              <Square size={12} className="fill-current" />
            </button>
          ) : (
            <button
              type="button"
              aria-label={running ? L('排队发送', 'Queue message') : L('发送', 'Send')}
              disabled={!ready}
              onClick={() => void send()}
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-full transition-colors',
                ready ? 'bg-primary text-primary-fg' : 'bg-subtle text-fg-faint',
              )}
            >
              {busy ? (
                <Spinner size={16} />
              ) : running ? (
                <ListEnd size={17} strokeWidth={2} />
              ) : (
                <ArrowUp size={17} strokeWidth={2.25} />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
