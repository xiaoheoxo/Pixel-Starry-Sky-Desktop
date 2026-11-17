// 内置浏览器的一排工具栏（docs/ui/browser-v2.md §3.1）：← → ⟳ ｜ 地址栏（短地址、下拉） ｜ 选元素 ｜ ⋯ ｜（宽时）+
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Lock,
  MousePointerClick,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  Square,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { IconButton, cn, useToast } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import type { FoundPort } from '@/features/session/live/portTipsModel'
import type { BrowserPage } from '../../../../shared/types/project-browser'
import { addressParts, addressSuggestions, type AddressKind, type AddressSuggestion } from './browserModel'

const KIND_ICON: Record<AddressKind, LucideIcon> = { secure: Lock, insecure: Globe, local: Server, file: FileText }

export interface BrowserToolbarProps {
  page: BrowserPage | undefined
  /** 面板宽（≥ 560）：「+」常驻工具栏 */
  wide: boolean
  /** 标签行在不在（在时「+」在标签行，工具栏不放） */
  tabs: boolean
  canAddPage: boolean
  busy: boolean
  demo: boolean
  ports: readonly FoundPort[]
  recent: readonly string[]
  /** 最近地址的网页标题（打开着的页面） */
  titles: ReadonlyMap<string, string>
  addressRef: RefObject<HTMLInputElement | null>
  onNavigate: (url: string) => void
  onAction: (kind: 'back' | 'forward' | 'reload' | 'hardReload' | 'stop') => void
  onTogglePick: () => void
  onNewPage: () => void
  onOpenExternal: () => void
}

export function BrowserToolbar(props: BrowserToolbarProps) {
  useI18n()
  const toast = useToast()
  const { page, busy } = props
  const [focused, setFocused] = useState(false)
  const more = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const actions: MenuAction[] = [
    {
      label: tr('projectTools.newPage'),
      icon: Plus,
      hint: 'Ctrl+T',
      disabled: !props.canAddPage,
      run: props.onNewPage,
    },
    {
      label: tr('projectTools.hardReload'),
      icon: RotateCw,
      hint: 'Ctrl+Shift+R',
      disabled: !page || props.demo,
      separator: true,
      run: () => props.onAction('hardReload'),
    },
    {
      label: tr('projectTools.copyAddress'),
      icon: Copy,
      disabled: !page,
      separator: true,
      run: () =>
        page &&
        void navigator.clipboard
          .writeText(page.remoteUrl ?? page.url)
          .then(() => toast(tr('projectTools.addressCopied'))),
    },
    {
      label: tr('projectTools.openExternal'),
      icon: ExternalLink,
      disabled: !page || props.demo,
      run: props.onOpenExternal,
    },
  ]
  return (
    <div data-browser-toolbar className="relative flex shrink-0 items-center gap-1">
      <IconButton
        icon={ArrowLeft}
        label={tr('projectTools.back')}
        title={`${tr('projectTools.back')} (Alt+←)`}
        disabled={busy || !page?.canBack}
        onClick={() => props.onAction('back')}
      />
      <IconButton
        icon={ArrowRight}
        label={tr('projectTools.forward')}
        title={`${tr('projectTools.forward')} (Alt+→)`}
        disabled={busy || !page?.canForward}
        onClick={() => props.onAction('forward')}
      />
      <IconButton
        icon={page?.loading ? Square : RefreshCw}
        label={tr(page?.loading ? 'projectTools.stopLoading' : 'projectTools.reload')}
        title={page?.loading ? tr('projectTools.stopLoading') : `${tr('projectTools.reload')} (Ctrl+R)`}
        disabled={busy || !page}
        onClick={() => props.onAction(page?.loading ? 'stop' : 'reload')}
      />
      <AddressBar {...props} focused={focused} onFocusChange={setFocused} />
      {/* 地址栏聚焦时盖住右边的按钮（变成整排宽） */}
      {!focused && (
        <>
          <IconButton
            icon={MousePointerClick}
            active={!!page?.picking}
            aria-pressed={!!page?.picking}
            label={tr(page?.picking ? 'projectTools.pickElementOff' : 'projectTools.pickElement')}
            disabled={busy || !page}
            onClick={props.onTogglePick}
          />
          <IconButton
            ref={more}
            icon={MoreHorizontal}
            label={tr('projectTools.more')}
            aria-haspopup="menu"
            aria-expanded={!!menu}
            active={!!menu}
            onClick={() => {
              const r = more.current?.getBoundingClientRect()
              if (r) setMenu(menu ? null : { x: r.right - 220, y: r.bottom + 4 })
            }}
          />
          {props.wide && !props.tabs && (
            <IconButton
              icon={Plus}
              label={tr('projectTools.newPage')}
              title={`${tr('projectTools.newPage')} (Ctrl+T)`}
              disabled={busy || !props.canAddPage}
              onClick={props.onNewPage}
            />
          )}
        </>
      )}
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={tr('projectTools.more')}
          actions={actions}
          onClose={() => {
            setMenu(null)
            more.current?.focus({ preventScroll: true })
          }}
        />
      )}
      <LoadLine loading={!!page?.loading} />
    </div>
  )
}

/** 地址栏：没聚焦时短地址（主机正常色、路径淡色），聚焦时完整地址全选、下面出下拉 */
function AddressBar({
  page,
  ports,
  recent,
  titles,
  addressRef,
  focused,
  onFocusChange,
  onNavigate,
}: BrowserToolbarProps & { focused: boolean; onFocusChange: (on: boolean) => void }) {
  const current = page ? (page.remoteUrl ?? page.url) : ''
  const [value, setValue] = useState(current)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  useEffect(() => {
    if (!focused) setValue(current)
  }, [current, focused])
  const list = open ? addressSuggestions(value, current, ports, recent, titles) : []
  const go = (url: string) => {
    if (!url.trim()) return
    setOpen(false)
    addressRef.current?.blur()
    onNavigate(url.trim())
  }
  const parts = current ? addressParts(current) : null
  const KindIcon = parts ? KIND_ICON[parts.kind] : Globe
  return (
    <div className="relative min-w-0 flex-1">
      <form
        onSubmit={e => {
          e.preventDefault()
          const chosen = list[active]
          go(chosen ? chosen.url : value)
        }}
        className={cn(
          'relative flex h-8 min-w-0 items-center gap-1.5 rounded-md border bg-surface px-2.5',
          focused ? 'border-accent' : 'border-line',
        )}
      >
        <span
          className="flex shrink-0 text-fg-muted"
          title={parts ? tr(`projectTools.address.${parts.kind}`) : undefined}
        >
          <KindIcon size={13} strokeWidth={1.75} />
        </span>
        <input
          ref={addressRef}
          data-browser-address
          aria-label={tr('projectTools.enterUrl')}
          aria-expanded={open && list.length > 0}
          aria-controls="browser-address-list"
          aria-activedescendant={active >= 0 ? `browser-address-${active}` : undefined}
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          title={focused ? undefined : current}
          value={value}
          placeholder={tr('projectTools.enterUrl')}
          onChange={e => {
            setValue(e.target.value)
            setOpen(true)
            // 回车打开输入的字；改回和当前地址一样时下拉第一条不是它，不能默认选中第一条
            setActive(-1)
          }}
          onFocus={e => {
            onFocusChange(true)
            setOpen(true)
            setActive(-1)
            e.currentTarget.select()
          }}
          onBlur={() => {
            onFocusChange(false)
            setOpen(false)
          }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              if (!list.length) return
              e.preventDefault()
              setOpen(true)
              const step = e.key === 'ArrowDown' ? 1 : -1
              // -1 是「不选」（回车打开输入框里的字），然后依次往下，到头绕回
              setActive(i => ((i + 1 + step + list.length + 1) % (list.length + 1)) - 1)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              if (open && list.length) setOpen(false)
              else {
                setValue(current)
                e.currentTarget.blur()
              }
            }
          }}
          className={cn(
            'h-full min-w-0 flex-1 bg-transparent text-list text-fg outline-none placeholder:text-fg-faint',
            // 没聚焦时输入框透明地盖在短地址上：点哪儿都是点进输入框
            !focused && parts && 'absolute inset-0 z-[1] w-full cursor-text opacity-0',
          )}
        />
        {/* 没聚焦：短地址 */}
        {!focused && parts && (
          <span
            data-browser-short-address
            title={current}
            className="flex min-w-0 flex-1 items-center text-list whitespace-nowrap"
          >
            <span className="shrink-0 text-fg">{parts.host}</span>
            <span className="min-w-0 truncate text-fg-faint">{parts.path}</span>
          </span>
        )}
      </form>
      {open && list.length > 0 && (
        <AddressList list={list} active={active} onPick={s => go(s.url)} onHover={setActive} />
      )}
    </div>
  )
}

function AddressList({
  list,
  active,
  onPick,
  onHover,
}: {
  list: AddressSuggestion[]
  active: number
  onPick: (s: AddressSuggestion) => void
  onHover: (i: number) => void
}) {
  const groups: ReactNode[] = []
  let last: AddressSuggestion['kind'] | null = null
  list.forEach((s, i) => {
    if (s.kind !== last && s.kind !== 'go')
      groups.push(
        <p key={'g' + s.kind} className="px-2 pt-1.5 pb-0.5 text-label text-fg-faint">
          {tr(s.kind === 'port' ? 'projectTools.addressPorts' : 'projectTools.addressRecent')}
        </p>,
      )
    last = s.kind
    const Icon = s.kind === 'recent' ? (s.url.startsWith('file:') ? FileText : Clock) : Zap
    const hint =
      s.kind === 'go'
        ? tr(s.port ? 'projectTools.addressOpenPort' : 'projectTools.addressOpen')
        : s.current
          ? tr('projectTools.addressViewing')
          : s.hint
    groups.push(
      <div
        key={i}
        id={`browser-address-${i}`}
        role="option"
        aria-selected={i === active}
        onMouseDown={e => {
          // 不让地址栏失焦（失焦会收起下拉）
          e.preventDefault()
          onPick(s)
        }}
        onMouseEnter={() => onHover(i)}
        className={cn(
          'flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-meta whitespace-nowrap',
          i === active || (active < 0 && s.kind === 'go') ? 'bg-hover text-fg' : 'text-fg-secondary',
        )}
      >
        <Icon size={13} className="shrink-0 text-fg-muted" />
        <span className="max-w-[60%] shrink-0 truncate font-mono text-fg">{s.label}</span>
        <span className="min-w-0 truncate text-fg-faint">{hint}</span>
        {s.kind === 'go' && <span className="ml-auto shrink-0 text-label text-fg-faint">Enter</span>}
      </div>,
    )
  })
  return (
    <div
      id="browser-address-list"
      role="listbox"
      className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border border-line-card bg-popover p-1 shadow-menu"
    >
      {groups}
      <p className="mt-1 border-t border-line-subtle px-2 pt-1.5 pb-0.5 text-label whitespace-nowrap text-fg-faint">
        {tr('projectTools.addressHint')}
      </p>
    </div>
  )
}

/** 加载进度：不是真实进度，开始走到 80% 停住，加载完走满后淡出（docs/ui/browser-v2.md §3.1） */
function LoadLine({ loading }: { loading: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'start' | 'run' | 'done'>('idle')
  useEffect(() => {
    if (loading) {
      setPhase('start')
      let inner = 0
      const frame = requestAnimationFrame(() => (inner = requestAnimationFrame(() => setPhase('run'))))
      return () => {
        cancelAnimationFrame(frame)
        cancelAnimationFrame(inner)
      }
    }
    setPhase(p => (p === 'idle' ? 'idle' : 'done'))
    const timer = window.setTimeout(() => setPhase('idle'), 450)
    return () => window.clearTimeout(timer)
  }, [loading])
  if (phase === 'idle') return null
  return (
    <span
      aria-hidden
      data-browser-load-line
      className={cn(
        'pointer-events-none absolute -bottom-1 left-0 h-0.5 rounded-full bg-accent motion-reduce:hidden',
        phase === 'start' && 'w-0',
        phase === 'run' && 'w-4/5 transition-[width] duration-[4000ms] ease-out',
        phase === 'done' && 'w-full opacity-0 transition-[width,opacity] duration-300',
      )}
    />
  )
}
