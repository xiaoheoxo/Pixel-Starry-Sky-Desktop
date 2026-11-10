import { useEffect, useRef, useState } from 'react'
import { CircleHelp } from 'lucide-react'
import { Button, cn, Popover, useToast } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '@/i18n/core'
import { claimTip, markTipSeen, releaseTip, setTipsOff, type TipId } from './featureTips'

/**
 * 入口旁的「?」：第一次碰到时自动弹出说明（带「知道了」），之后只在点「?」时弹。
 * 不遮罩、不抢焦点；点别处、按 Esc 都算看过（docs/ui/feature-tips.md）
 */
export function FeatureTip({ id, className }: { id: TipId; className?: string }) {
  useI18n()
  const toast = useToast()
  const anchor = useRef<HTMLButtonElement>(null)
  const [mode, setMode] = useState<'closed' | 'first' | 'help'>('closed')
  useEffect(() => {
    // 入口在看不见的地方（后台标签、被频道页盖住的工作台）不弹，下次碰到再弹
    if (anchor.current?.closest('[inert]') || !claimTip(id)) return
    setMode('first')
    return () => releaseTip(id)
  }, [id])
  const close = (): void => {
    if (mode === 'first') markTipSeen(id)
    setMode('closed')
  }
  // 提示开着时 Esc 只关提示：捕获阶段先拿走，输入框就不会用这次 Esc 停止回复（同 AgentTracePanel）
  useEffect(() => {
    if (mode === 'closed') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  })
  const key = (part: string): TranslationKey => `tips.${id}.${part}` as TranslationKey
  const title = tr(key('title'))
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={tr('tips.help', { name: title })}
        title={tr('tips.help', { name: title })}
        aria-expanded={mode !== 'closed'}
        aria-haspopup="dialog"
        onClick={() => (mode === 'closed' ? setMode('help') : close())}
        className={cn(
          'no-drag inline-flex size-4 shrink-0 items-center justify-center rounded-full text-fg-faint hover:text-fg-muted',
          mode !== 'closed' && 'text-accent-fg hover:text-accent-fg',
          className,
        )}
      >
        <CircleHelp size={13} strokeWidth={1.75} />
      </button>
      <Popover
        open={mode !== 'closed'}
        onClose={close}
        anchor={anchor}
        offset={8}
        bare
        role="dialog"
        aria-label={title}
        className="w-80 p-3 text-left"
      >
        {mode === 'first' && <div className="text-label font-semibold text-accent-fg">{tr('tips.new')}</div>}
        <div className="mt-0.5 text-ui font-semibold text-fg">{title}</div>
        <p className="mt-1 text-meta text-fg-secondary">{tr(key('body'))}</p>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-meta text-fg-secondary">
          {tr(key('points'))
            .split('\n')
            .map(p => (
              <li key={p}>{p}</li>
            ))}
        </ul>
        <div className="mt-2 rounded-md bg-subtle px-2 py-1.5 text-meta text-fg-secondary">{tr(key('eg'))}</div>
        {mode === 'first' && (
          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" className="h-7 px-3 text-meta" onClick={close}>
              {tr('tips.ok')}
            </Button>
            <span className="flex-1" />
            <button
              type="button"
              className="text-meta text-fg-muted underline hover:text-fg"
              onClick={() => {
                markTipSeen(id)
                setTipsOff(true)
                setMode('closed')
                toast(tr('tips.turnedOff'), {
                  duration: 8_000,
                  action: { label: tr('portTip.undo'), run: () => setTipsOff(false) },
                })
              }}
            >
              {tr('tips.never')}
            </button>
          </div>
        )}
      </Popover>
    </>
  )
}
