// 频道里正在生成的云端生图（docs/ui/channel-image-gen.md §3.1）：时间线 / 讨论串底部一行，生成完换成你发的带图消息
import { ImageIcon, RotateCcw, Square, X } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { IconButton, Spinner, useToast } from '@/ui'
import { useChannels } from './store'
import { canRetryChannelImage, cancelChannelImage, dismissChannelImage, retryChannelImage } from './channelImage'

export function ImagePendingRows({ channelId, threadId }: { channelId: string; threadId: string | null }) {
  useI18n()
  const toast = useToast()
  const all = useChannels(s => s.imagePending)
  const rows = all.filter(p => p.channelId === channelId && p.threadId === threadId)
  if (!rows.length) return null
  const run = (job: Promise<unknown>) =>
    void job.catch(error => toast(tr('channels.image.failed', { error: translateMessage((error as Error).message) })))
  return (
    <div
      data-channel-image-pending=""
      role="status"
      className="conversation-message mt-4 flex flex-col gap-1 pl-[38px]"
    >
      {rows.map(p => (
        <div key={p.id} className="flex min-w-0 items-center gap-2 text-meta text-fg-muted">
          {p.status === 'running' ? (
            <Spinner size={12} />
          ) : (
            <ImageIcon size={13} strokeWidth={1.6} className="shrink-0 text-danger" />
          )}
          <span className="min-w-0 truncate">
            {p.status === 'running'
              ? `${tr('channels.image.running')} ${p.prompt} · ${p.size} · ${tr('cloudImage.n', { n: p.n })}`
              : tr('channels.image.failed', { error: translateMessage(p.error ?? '') })}
          </span>
          {p.status === 'running' ? (
            <IconButton
              icon={Square}
              label={tr('channels.image.stop')}
              size={22}
              iconSize={11}
              onClick={() => run(cancelChannelImage(p.id))}
            />
          ) : (
            <>
              {canRetryChannelImage(p.id) && (
                <IconButton
                  icon={RotateCcw}
                  label={tr('channels.image.retry')}
                  size={22}
                  iconSize={12}
                  onClick={() => run(retryChannelImage(p.id))}
                />
              )}
              <IconButton
                icon={X}
                label={tr('channels.image.dismiss')}
                size={22}
                iconSize={13}
                onClick={() => run(dismissChannelImage(p.id))}
              />
            </>
          )}
        </div>
      ))}
    </div>
  )
}
