import type { SessionRecord } from '@pixelsky/protocol'
import { Button, Spinner } from '@/ui'
import { tr } from '@/i18n/core'
import { refreshDots, useDots } from './store'
import { DotKeyContext, DotRoomContext } from './context'
import { DotConversation } from './DotConversation'
import { dotRoomKey } from './viewCache'

export function DotSessionView({
  target,
  active = true,
}: {
  target: NonNullable<SessionRecord['dot']>
  active?: boolean
}) {
  const dots = useDots()
  const entry = dots.entries.find(e => e.account === target.account && e.id === target.id)
  const roomKey = entry && dotRoomKey(entry)
  return (
    <div className="dot-window min-w-0 flex-1">
      {entry && roomKey ? (
        <DotKeyContext.Provider value={entry.key}>
          <DotRoomContext.Provider value={roomKey}>
            <DotConversation key={roomKey} initialEntry={entry} roomKey={roomKey} active={active} />
          </DotRoomContext.Provider>
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
