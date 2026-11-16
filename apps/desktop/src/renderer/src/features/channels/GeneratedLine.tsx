import { tr } from '../../i18n/core'
import { formatUsd } from '../../../../shared/cloudImage'
import type { ChannelGenerated } from '../../../../shared/types/channels'

/** 频道里云端生图发的消息：一行小字写分组、尺寸、张数和费用（查到实扣前写估价，docs/ui/channel-image-gen.md §3.1） */
export function GeneratedLine({ generated: g }: { generated: ChannelGenerated }) {
  const cost =
    typeof g.cost === 'number'
      ? formatUsd(g.cost)
      : g.estimate !== null
        ? tr('channels.image.estimate', { cost: formatUsd(g.estimate) })
        : null
  const parts = [
    tr('channels.image.meta', { group: g.group, size: g.size, n: g.n }),
    cost,
    g.dropped ? tr('channels.image.dropped', { n: g.dropped }) : null,
  ].filter(Boolean)
  return (
    <span data-channel-generated="" className="mt-0.5 px-1 text-meta text-fg-faint">
      {parts.join(' · ')}
    </span>
  )
}
