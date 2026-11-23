// 推理强度菜单的图标条：一格一个开关，下面一块说明，显示指着、聚焦或刚点过的那一格（docs/ui/effort-menu-strip.md）
import { useId, useState, type KeyboardEvent } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { cn } from '@/ui'
import { FeatureTip } from '@/features/tips/FeatureTip'
import type { EffortSwitch, HelpText } from './effortSwitches'
import { useSpeedHold } from './speedHold'

const TAGS = { cost: 'session.ComposerMenus.usesMore', pending: 'codex.fastPending' } as const

export function SwitchStrip({ items }: { items: EffortSwitch[] }) {
  useI18n()
  const helpId = useId()
  const [picked, setPicked] = useState<EffortSwitch['id'] | null>(null)
  const held = items.find(i => i.hold)
  const hold = useSpeedHold(held?.hold?.speed ?? 'off', s => held?.hold?.set(s))
  const hinting = held && (hold.holding || hold.tooShort)
  // 按住和「要按满」的提示没过时说明不换走
  const shown = hinting ? held.id : items.some(i => i.id === picked) ? picked : items[0]?.id

  const onArrow = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key]
    if (!step) return
    const cells = [...e.currentTarget.querySelectorAll<HTMLElement>('[role=switch]')]
    const at = cells.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    e.preventDefault()
    cells[(at + step + cells.length) % cells.length]!.focus()
  }

  return (
    <>
      <div
        role="group"
        aria-label={tr('session.ComposerMenus.sessionSwitches')}
        className="switch-strip mt-3"
        data-count={items.length}
        onKeyDown={onArrow}
      >
        {items.map(item => {
          const Icon = item.icon
          const holds = item.hold !== undefined
          return (
            <button
              key={item.id}
              type="button"
              role="switch"
              aria-checked={item.on}
              aria-disabled={item.blocked || undefined}
              aria-label={holds && item.tone !== 'warn' ? tr('speed.holdLabel') : item.help.title}
              aria-describedby={`${helpId}-${item.id}`}
              data-switch={item.id}
              data-speed-switch={item.hold?.speed}
              data-tone={item.tone}
              data-pending={item.pending || undefined}
              data-shown={item.id === shown || undefined}
              className={cn('switch-cell no-drag', holds && hold.launching && 'speed-glow speed-launch')}
              onPointerEnter={() => setPicked(item.id)}
              onFocus={() => {
                setPicked(item.id)
                hold.clearHint()
              }}
              {...(holds ? hold.handlers : { onClick: () => !item.blocked && item.set(!item.on) })}
            >
              {holds && hold.holding && <i className="speed-fill" data-speed-fill aria-hidden />}
              <b className="flex">
                {holds && <span className="speed-trail" aria-hidden />}
                <Icon size={items.length > 2 ? 17 : 15} strokeWidth={1.75} className="speed-rocket" />
              </b>
              <i className="switch-cell-name">{items.length === 1 ? item.help.title : item.short}</i>
              <i className="switch-mini" aria-hidden />
            </button>
          )
        })}
      </div>
      <div className="switch-help mt-2.5 px-0.5 text-meta text-fg-muted">
        {items.map(item => (
          <Help
            key={item.id}
            id={`${helpId}-${item.id}`}
            help={item.help}
            shown={item.id === shown && !hinting}
            glow={item.id === 'ultracode' && item.on}
            tip={item.hold !== undefined}
          />
        ))}
        {items.flatMap(item => item.spare.map((help, i) => <Help key={`${item.id}-${i}`} help={help} />))}
        {held?.hold && (
          <>
            <Help help={held.hold.holding} shown={hold.holding} className="font-medium text-warn-fg" />
            <Help
              help={held.hold.tooShort}
              shown={hold.tooShort && !hold.holding}
              className={cn('text-fg-secondary', hold.tooShort && 'speed-nudge')}
            />
          </>
        )}
      </div>
    </>
  )
}

/** 不显示的只占位 */
function Help({
  help,
  id,
  shown,
  glow,
  tip,
  className,
}: {
  help: HelpText
  id?: string
  shown?: boolean
  glow?: boolean
  tip?: boolean
  className?: string
}) {
  return (
    <div id={id} data-shown={shown || undefined}>
      <p className="mb-0.5 flex flex-wrap items-center gap-1.5 font-semibold text-fg-secondary">
        <span className={cn(glow && 'effort-max ultracode-glow')}>{help.title}</span>
        {tip && <FeatureTip id="fast" />}
        {help.tag && (
          <span
            className={cn(
              'rounded-sm px-1.5 text-label leading-5 font-normal whitespace-nowrap text-warn-fg',
              'bg-[color-mix(in_srgb,var(--warn)_13%,transparent)]',
            )}
          >
            {tr(TAGS[help.tag])}
          </span>
        )}
      </p>
      <p className={className}>{help.text}</p>
    </div>
  )
}
