import type { SessionRecord } from '@pixelsky/protocol'
import { Button, Spinner } from '@/ui'
import { tr } from '@/i18n/core'
import { refreshDots, useDots } from './store'
import { DotKeyContext } from './context'
import { DotConversation } from './DotConversation'

export function DotSessionView({
  target,
  active = true,
}: {
  target: NonNullable<SessionRecord['dot']>
  active?: boolean
}) {
  const dots = useDots()
  const entry = dots.entries.find(e => e.account === target.account && e.id === target.id)
  return (
    <div className="dot-window min-w-0 flex-1">
      {entry ? (
        <DotKeyContext.Provider value={entry.key}>
          <DotConversation key={entry.key} entryKey={entry.key} active={active} />
        </DotKeyContext.Provider>
      ) : (
        <div role="status" className="flex h-full items-center justify-center gap-3">
          {dots.loading ? <Spinner /> : <Button onClick={() => void refreshDots()}>{tr('dot.refresh')}</Button>}
          <span>{tr('dot.listUnavailable')}</span>
        </div>
      )}
    </div>
  )
}
