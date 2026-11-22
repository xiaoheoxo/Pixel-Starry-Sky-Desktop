import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import { CirclePause, ExternalLink, Pencil, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { dotWebUrl } from './DotProfilePanel'

export interface DotQuickSettingsPoint {
  x: number
  y: number
}

export function useDotQuickSettings() {
  const [point, setPoint] = useState<DotQuickSettingsPoint | null>(null)
  const fromTarget = (target: HTMLElement): void => {
    const { left, bottom } = target.getBoundingClientRect()
    setPoint({ x: left, y: bottom })
  }
  return {
    point,
    openAt: fromTarget,
    close: () => setPoint(null),
    onContextMenu(event: MouseEvent<HTMLElement>) {
      event.preventDefault()
      event.stopPropagation()
      if (event.clientX || event.clientY) setPoint({ x: event.clientX, y: event.clientY })
      else fromTarget(event.currentTarget)
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      event.preventDefault()
      event.stopPropagation()
      fromTarget(event.currentTarget)
    },
  }
}

export function dotQuickSettingsActions(openWeb: () => void, onRefresh: () => void, refreshing: boolean): MenuAction[] {
  const official = tr('dot.quick.inChatGPT')
  return [
    { label: tr('dot.quick.rename'), icon: Pencil, hint: official, run: openWeb },
    { label: tr('dot.quick.pause'), icon: CirclePause, hint: official, run: openWeb },
    { label: tr('dot.quick.restart'), icon: RotateCcw, hint: official, run: openWeb },
    { label: tr('dot.quick.delete'), icon: Trash2, hint: official, run: openWeb },
    { label: tr('dot.quick.open'), icon: ExternalLink, separator: true, run: openWeb },
    { label: tr('dot.quick.refresh'), icon: RefreshCw, disabled: refreshing, run: onRefresh },
  ]
}

export function DotQuickSettings({
  dotId,
  point,
  onClose,
  onRefresh,
  refreshing = false,
}: {
  dotId: string
  point: DotQuickSettingsPoint
  onClose: () => void
  onRefresh: () => void
  refreshing?: boolean
}) {
  useI18n()
  const openWeb = (): void => {
    window.open(dotWebUrl(dotId), '_blank', 'noopener,noreferrer')
  }
  return (
    <ActionMenu
      {...point}
      label={tr('dot.quick.title')}
      actions={dotQuickSettingsActions(openWeb, onRefresh, refreshing)}
      onClose={onClose}
    />
  )
}
