// 内置浏览器的一排工具栏（docs/ui/browser-v2.md §3.1、§3.2）：
// ← → ⟳ ｜ 地址栏（短地址、下拉、缩放） ｜（宽时）截图 ｜ 选元素 ｜ ⚠ n ｜ ⋯ ｜（宽时）+
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Camera,
  Clock,
  Code,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Layers,
  Lock,
  MousePointerClick,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Square,
  SquareTerminal,
  Trash2,
  Zap,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react'
import { IconButton, cn, useToast } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import type { FoundPort } from '@/features/session/live/portTipsModel'
import type { BrowserPage } from '../../../../shared/types/project-browser'
import { addressParts, addressSuggestions, type AddressKind, type AddressSuggestion } from './browserModel'
import { isWebPage, zoomPercent } from './browserTools'
import { DEVICE_ICON, THEME_ICON, currentPreview, deviceActions, deviceName, themeActions } from './browserPreviewMenu'
import type { BrowserPreview } from '../../../../shared/types/project-browser'

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
  // ---- 第二批（docs/ui/browser-v2.md §3.2）----
  /** 工具栏「⚠」上的数（错误 + 失败请求，开了显示警告再加警告） */
  issueCount: number
  consoleOpen: boolean
  onToggleConsole: () => void
  /** fromMenu：从菜单点的（菜单关掉、网页放回去之后再截） */
  onCapture: (full: boolean, fromMenu: boolean) => void
  onFind: () => void
  onZoom: (move: 'in' | 'out' | 'reset') => void
  onDevtools: () => void
  onClearSiteData: () => void
  // ---- 第三批（docs/ui/browser-v2.md §3.3）----
  /** 这个工作区的设备尺寸、网页主题 */
  preview: BrowserPreview | undefined
  onPreview: (next: BrowserPreview) => void
}

type MenuKind = 'more' | 'capture' | 'device'

export function BrowserToolbar(props: BrowserToolbarProps) {
  useI18n()
  const toast = useToast()
  const { page, busy } = props
  const [focused, setFocused] = useState(false)
  const more = useRef<HTMLButtonElement>(null),
    camera = useRef<HTMLButtonElement>(null),
    deviceButton = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; kind: MenuKind } | null>(null)
  const openMenu = (kind: MenuKind, button: HTMLButtonElement | null, width: number) => {
    const r = button?.getBoundingClientRect()
    if (r) setMenu(menu?.kind === kind ? null : { x: r.right - width, y: r.bottom + 4, kind })
  }
  // 截图、查找对整页打不开的错误页没意义；开发者工具、清数据只对网页（不是本地文件）
  const live = !!page && page.failed === undefined && !props.demo
  const web = live && isWebPage(page)
  const captures: MenuAction[] = [
    {
      label: tr('projectTools.captureVisible'),
      icon: Camera,
      hint: tr('projectTools.captureHint'),
      disabled: !live || busy,
      run: () => props.onCapture(false, true),
    },
    {
      label: tr('projectTools.captureFull'),
      icon: Layers,
      disabled: !live || busy,
      run: () => props.onCapture(true, true),
    },
  ]
  const zoom = zoomPercent(page?.zoom)
  const preview = currentPreview(props.preview),
    devices = deviceActions(props.preview, props.onPreview)
  const actions: MenuAction[] = [
    {
      label: tr('projectTools.newPage'),
      icon: Plus,
      hint: 'Ctrl+T',
      disabled: !props.canAddPage,
      run: props.onNewPage,
    },
    // 窄面板时截图在这里，宽时在工具栏
    ...(props.wide ? [] : captures),
    // 窄面板时设备尺寸也在这里（宽时工具栏有按钮）
    ...(props.wide
      ? []
      : [
          {
            label: tr('projectTools.device'),
            icon: DEVICE_ICON[preview.device],
            hint: deviceName(preview.device),
            disabled: !page,
            children: devices,
          },
        ]),
    {
      label: tr('projectTools.find'),
      icon: Search,
      hint: 'Ctrl+F',
      disabled: !page || page.failed !== undefined,
      separator: true,
      run: props.onFind,
    },
    {
      label: tr('projectTools.zoom'),
      icon: ZoomIn,
      hint: zoom,
      disabled: !page || page.failed !== undefined,
      children: [
        { label: tr('projectTools.zoomIn'), hint: 'Ctrl+=', run: () => props.onZoom('in') },
        { label: tr('projectTools.zoomOut'), hint: 'Ctrl+-', run: () => props.onZoom('out') },
        {
          label: tr('projectTools.zoomReset'),
          hint: 'Ctrl+0',
          disabled: !page?.zoom,
          run: () => props.onZoom('reset'),
        },
      ],
    },
    {
      label: tr('projectTools.pageTheme'),
      icon: THEME_ICON[preview.theme ?? 'system'],
      hint: tr(`projectTools.pageTheme.${preview.theme ?? 'system'}`),
      title: tr('projectTools.pageThemeHint'),
      disabled: !page,
      children: themeActions(preview, props.onPreview),
    },
    {
      label: tr('projectTools.console'),
      icon: SquareTerminal,
      checked: props.consoleOpen,
      hint: props.issueCount ? String(props.issueCount) : undefined,
      disabled: !page,
      run: props.onToggleConsole,
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
      label: tr('projectTools.clearSiteData'),
      icon: Trash2,
      disabled: !web || busy,
      run: props.onClearSiteData,
    },
    {
      label: tr('projectTools.devtools'),
      icon: Code,
      hint: 'F12',
      disabled: !page || props.demo,
      run: props.onDevtools,
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
          {/* 设备尺寸（docs/ui/browser-v2.md §3.3）：宽时常驻，窄时在 ⋯ 里 */}
          {props.wide && (
            <button
              ref={deviceButton}
              type="button"
              data-browser-device
              aria-haspopup="menu"
              aria-expanded={menu?.kind === 'device'}
              title={tr('projectTools.device')}
              disabled={!page}
              onClick={() => openMenu('device', deviceButton.current, 220)}
              className={cn(
                'press no-drag inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-label whitespace-nowrap text-fg-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
                (menu?.kind === 'device' || preview.device !== 'responsive') && 'bg-selected text-fg',
              )}
            >
              {(() => {
                const Icon = DEVICE_ICON[preview.device]
                return <Icon size={14} strokeWidth={1.5} />
              })()}
              {deviceName(preview.device)}
              <ChevronDown size={12} className="text-fg-faint" />
            </button>
          )}
          {props.wide && (
            <IconButton
              ref={camera}
              icon={Camera}
              label={tr('projectTools.capture')}
              aria-haspopup="menu"
              aria-expanded={menu?.kind === 'capture'}
              active={menu?.kind === 'capture'}
              disabled={busy || !live}
              onClick={() => openMenu('capture', camera.current, 220)}
            />
          )}
          <IconButton
            icon={MousePointerClick}
            active={!!page?.picking}
            aria-pressed={!!page?.picking}
            label={tr(page?.picking ? 'projectTools.pickElementOff' : 'projectTools.pickElement')}
            disabled={busy || !page}
            onClick={props.onTogglePick}
          />
          {/* 有错误或抽屉开着时才出来（docs/ui/browser-v2.md §3.2）；没有错误时是灰的 */}
          {page && (props.issueCount > 0 || props.consoleOpen) && (
            <button
              type="button"
              data-browser-console-toggle
              aria-pressed={props.consoleOpen}
              aria-label={tr('projectTools.consoleCount', { count: props.issueCount })}
              title={tr('projectTools.consoleCount', { count: props.issueCount })}
              onClick={props.onToggleConsole}
              className={cn(
                'press no-drag inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-label font-medium tabular-nums',
                props.issueCount > 0
                  ? 'bg-danger/10 text-danger hover:bg-danger/15'
                  : 'bg-subtle text-fg-muted hover:bg-hover',
                props.consoleOpen && (props.issueCount > 0 ? 'ring-1 ring-danger' : 'ring-1 ring-line-strong'),
              )}
            >
              <AlertTriangle size={12} strokeWidth={2} />
              {props.issueCount}
            </button>
          )}
          <IconButton
            ref={more}
            icon={MoreHorizontal}
            label={tr('projectTools.more')}
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'more'}
            active={menu?.kind === 'more'}
            onClick={() => openMenu('more', more.current, 240)}
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
          label={tr(
            menu.kind === 'more'
              ? 'projectTools.more'
              : menu.kind === 'device'
                ? 'projectTools.device'
                : 'projectTools.capture',
          )}
          actions={menu.kind === 'more' ? actions : menu.kind === 'device' ? devices : captures}
          onClose={() => {
            const button =
              menu.kind === 'more' ? more.current : menu.kind === 'device' ? deviceButton.current : camera.current
            setMenu(null)
            button?.focus({ preventScroll: true })
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
  onZoom,
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
            className="flex min-w-0 flex-1 items-center overflow-hidden text-list whitespace-nowrap"
          >
            {/* 放不下时先省略路径，再省略主机（窄面板还有缩放标记） */}
            <span className="min-w-0 truncate text-fg">{parts.host}</span>
            <span className="min-w-0 shrink-[100] truncate text-fg-faint">{parts.path}</span>
          </span>
        )}
        {/* 网页不是 100% 时提醒一下，点了还原（docs/ui/browser-v2.md §3.2）；盖在透明输入框上面 */}
        {!focused && page?.zoom && (
          <button
            type="button"
            data-browser-zoom
            title={tr('projectTools.zoomChip', { percent: zoomPercent(page.zoom) })}
            aria-label={tr('projectTools.zoomChip', { percent: zoomPercent(page.zoom) })}
            onClick={() => onZoom('reset')}
            className="relative z-[2] -mr-1 shrink-0 rounded-sm bg-subtle px-1 text-label text-fg-secondary tabular-nums hover:bg-hover hover:text-fg"
          >
            {zoomPercent(page.zoom)}
          </button>
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
