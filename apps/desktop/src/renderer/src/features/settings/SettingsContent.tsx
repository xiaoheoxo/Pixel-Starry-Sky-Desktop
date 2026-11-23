import { ENGINES } from '@pixelsky/protocol'
import { Button, IconButton, Segmented, cn } from '@/ui'
import { tr } from '../../i18n/core'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Bot,
  ChartColumn,
  CodeXml,
  Cpu,
  FolderOpen,
  HardDrive,
  Info,
  Keyboard,
  MessageCircle,
  MessageSquareText,
  MessagesSquare,
  Monitor,
  Moon,
  Network,
  Palette,
  Puzzle,
  Route,
  ScrollText,
  Search,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  SquareArrowOutUpRight,
  Sun,
  TerminalSquare,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useTheme, type MotionPreference, type ThemePreference } from '@/features/appearance/ThemeProvider'
import { useEngineState } from '@/features/engine'
import { openAccountsPage, useAccountsPage } from '@/features/model-channels/accountsStore'
import { AboutSection } from './AboutSection'
import { AccountSection } from '../account/settings/AccountSection'
import { FontSettings } from './FontSettings'
import { takeSettingsRow } from './settingsJump'
import { scrollInPane } from '@/ui/scrollInPane'
import { runMainAction } from './windowBridge'
import { AccentSettings } from './AccentSettings'
import { PaletteSettings } from './PaletteSettings'
import { MinimalModeSettings, WorkbenchFrameSettings } from './MinimalModeSettings'
import { ModeTransitionSettings } from './ModeTransitionSettings'
import { WallpaperSettings } from './WallpaperSettings'
import { GlassSettings } from './GlassSettings'
import type { PaneFocusMotion } from '@/features/appearance/paneFocusMotion'
import { UsageSection } from '../usage/settings/UsageSection'
import { ModelsSection } from './models/ModelsSection'
import { EnginesSection } from './engines/EnginesSection'
import { openEngineDetail, useEngineDetail } from './engines/nav'
import { openExtTab } from '@/features/extstore/nav'
import { EditorSection } from '../editor/settings/EditorSection'
import { ExtensionsSection } from './extensions/ExtensionsSection'
import { FileIconThemeSettings } from './FileIconThemeSettings'
import { EditorThemeSettings } from './EditorThemeSettings'
import { searchSettings, type SearchEntry } from './searchIndex'
import { SectionTitle, SettingGroup, SettingRow, SettingsPaneProvider } from './SettingRow'
import { useI18n } from '@/i18n/I18nProvider'
import { TerminalSection } from './TerminalSection'
import { SidebarSettings } from './SidebarSettings'
import { NotificationsSection } from './NotificationsSection'
import { ShortcutsSettings } from './ShortcutsSettings'
import { LogsSection } from '../logs/LogsSection'
import { FeedbackSection } from '../feedback/FeedbackSection'
import { useFeedbackUnread } from '../feedback/store'
import { MobileSection } from '../mobile/settings/MobileSection'
import { ImSection } from '../im/ImSection'
import { GeneralSection } from './GeneralSection'
import { ChatSection } from './ChatSection'
import { AssistSection } from './AssistSection'
import { ProjectsSection } from './projects/ProjectsSection'
import { StorageSection } from '../storage/StorageSection'
import { DataLocationRow } from '../storage/DataLocationRow'
import { SubagentsSection } from './SubagentsSection'
import { AgentsSection } from './AgentsSection'
import { leaveSettings, UnsavedLeaveDialog } from './unsavedEdits'
import type { SectionId } from './sectionId'

export type { SectionId } from './sectionId'

/** label 用在页面标题和搜索结果；nav 是左侧导航里的短名（英文放不下时才给），没有就用 label */
const SECTIONS: Array<{ id: SectionId; label: string; nav?: string; icon: LucideIcon }> = [
  {
    id: 'machines',
    get label() {
      return tr('machines.title')
    },
    get nav() {
      return tr('settings.SettingsDialog.nav.machines')
    },
    icon: Monitor,
  },
  {
    id: 'mobile',
    get label() {
      return tr('mobile.title')
    },
    icon: Smartphone,
  },
  {
    id: 'im',
    get label() {
      return tr('im.title')
    },
    icon: MessagesSquare,
  },
  {
    id: 'extensions',
    get label() {
      return tr('extensions.title')
    },
    icon: Puzzle,
  },
  {
    id: 'plugins',
    get label() {
      return tr('extensions.title')
    },
    icon: Puzzle,
  },
  {
    id: 'terminal',
    get label() {
      return tr('settingsNav.terminal')
    },
    get nav() {
      return tr('settingsNav.terminal')
    },
    icon: TerminalSquare,
  },
  {
    id: 'general',
    get label() {
      return tr('settingsNav.general')
    },
    icon: SlidersHorizontal,
  },
  {
    id: 'chat',
    get label() {
      return tr('settingsNav.chat')
    },
    icon: MessageCircle,
  },
  {
    id: 'assist',
    get label() {
      return tr('settingsNav.assist')
    },
    icon: Sparkles,
  },
  {
    id: 'account',
    get label() {
      return tr('settings.AboutSection.account')
    },
    icon: UserRound,
  },
  {
    id: 'appearance',
    get label() {
      return tr('settings.SettingsDialog.appearance')
    },
    icon: Palette,
  },
  {
    id: 'notifications',
    get label() {
      return tr('notifications.title')
    },
    icon: Bell,
  },
  {
    id: 'shortcuts',
    get label() {
      return tr('settings.searchIndex.shortcuts')
    },
    icon: Keyboard,
  },
  {
    id: 'editor',
    get label() {
      return tr('settings.editor.EditorSection.editor')
    },
    icon: CodeXml,
  },
  {
    id: 'projects',
    get label() {
      return tr('projects.title')
    },
    icon: FolderOpen,
  },
  {
    id: 'storage',
    get label() {
      return tr('storage.title')
    },
    icon: HardDrive,
  },
  {
    id: 'models',
    get label() {
      return tr('modelChannels.title')
    },
    get nav() {
      return tr('modelChannels.title')
    },
    icon: Route,
  },
  {
    id: 'subagents',
    get label() {
      return tr('subagentRoute.title')
    },
    icon: Network,
  },
  {
    id: 'agents',
    get label() {
      return tr('agentsSettings.title')
    },
    icon: Bot,
  },
  {
    id: 'usage',
    get label() {
      return tr('nav.TopNav.usage')
    },
    icon: ChartColumn,
  },
  {
    id: 'engines',
    get label() {
      return tr('settings.engines.EnginesSection.localEngines')
    },
    icon: Cpu,
  },
  {
    id: 'logs',
    get label() {
      return tr('logs.title')
    },
    icon: ScrollText,
  },
  {
    id: 'feedback',
    get label() {
      return tr('feedback.title')
    },
    icon: MessageSquareText,
  },
  {
    id: 'about',
    get label() {
      return tr('settings.searchIndex.about')
    },
    icon: Info,
  },
]

/** 左侧主导航 5 个分组（18 项）；低频三项「日志 / 反馈 / 关于」固定在左栏底栏，默认高度一屏零滚动 */
const MAIN_NAV_GROUPS: Array<{ label: string; ids: SectionId[] }> = [
  {
    get label() {
      return tr('settingsNav.group.account')
    },
    ids: ['account', 'usage'],
  },
  {
    get label() {
      return tr('settings.SettingsDialog.application')
    },
    ids: ['general', 'appearance', 'chat', 'notifications', 'shortcuts'],
  },
  {
    get label() {
      return tr('settingsNav.group.workspace')
    },
    ids: ['projects', 'editor', 'terminal', 'storage'],
  },
  {
    get label() {
      return tr('settingsNav.group.ai')
    },
    ids: ['models', 'engines', 'subagents', 'assist'],
  },
  {
    get label() {
      return tr('settingsNav.group.connect')
    },
    ids: ['extensions', 'mobile', 'im'],
  },
]

const FOOTER_NAV_IDS: readonly SectionId[] = ['logs', 'feedback', 'about']

/** 需要宽容器展示图表、多列表格、商店网格或双栏预览的页面；其余表单页限制在 680px 阅读宽度内 */
const WIDE_SECTIONS = new Set<SectionId>([
  'usage',
  'projects',
  'shortcuts',
  'subagents',
  'extensions',
  'plugins',
  'logs',
])

const APPEARANCE_ANCHORS = [
  { id: 'theme', key: 'settingsLayout.anchor.theme' },
  { id: 'wallpaper', key: 'settingsLayout.anchor.wallpaper' },
  { id: 'fonts', key: 'settingsLayout.anchor.fonts' },
  { id: 'motion', key: 'settingsLayout.anchor.motion' },
  { id: 'sidebar', key: 'settingsLayout.anchor.sidebar' },
] as const

const sectionInfo = (id: SectionId) => SECTIONS.find(s => s.id === id)!
const sectionLabel = (id: SectionId): string => sectionInfo(id)?.label ?? id

/** 高亮搜索命中子串（忽略大小写） */
function HighlightMatch({ value, query }: { value: string; query: string }) {
  const q = query.trim()
  if (!q) return <>{value}</>
  const idx = value.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return <>{value}</>
  return (
    <>
      {value.slice(0, idx)}
      <mark className="rounded-xs bg-accent-soft px-0.5 font-medium text-accent-fg">
        {value.slice(idx, idx + q.length)}
      </mark>
      {value.slice(idx + q.length)}
    </>
  )
}

/** 设置的内容：左侧通顶分区导航 + 底栏三项固定，右侧吸顶页头 + 阅读宽度分档内容区 */
export function SettingsContent({
  section,
  onSectionChange,
  standalone,
  onClose,
  onEscape,
  onPopOut,
  onStartMove,
  onResetSize,
  jumpToken = 0,
}: {
  /** 与入口共享当前分类，内部导航与搜索跳转也同步更新。 */
  section: SectionId
  onSectionChange: (section: SectionId) => void
  /** 在独立窗口里：要主窗口做的事（管理机器、打开会话）交给主窗口，设置窗口不关 */
  standalone: boolean
  /** 浮层里：做完要主窗口做的事后关掉设置 */
  onClose: () => void
  /** Esc：搜索框里有字时先清空；没有字了再调它。独立窗口不传（Esc 不关窗口，只清空搜索） */
  onEscape?: () => void
  /** 浮层里「在独立窗口中打开」 */
  onPopOut?: () => void
  /** 浮层里按住吸顶页头或侧栏空白拖动设置窗口 */
  onStartMove?: (e: React.MouseEvent) => void
  /** 双击吸顶栏空白处恢复默认尺寸并居中 */
  onResetSize?: () => void
  /** 数字变一次，就再取一次要跳到的那一行（takeSettingsRow）：设置已经开着，又从别处要求跳到某一行 */
  jumpToken?: number
}) {
  const { text, t } = useI18n()
  const feedbackUnread = useFeedbackUnread()
  const engineDetailId = useEngineDetail()
  const liveEngines = useEngineState(s => s.engines)
  const accountsPage = useAccountsPage()
  const [activeAnchor, setActiveAnchor] = useState<string>('theme')
  const [selectedHitIdx, setSelectedHitIdx] = useState(0)
  const [scrolled, setScrolled] = useState(false)

  const setSection = (id: SectionId): void => {
    setQuery('')
    if (id === section) {
      if (id === 'engines' && engineDetailId) openEngineDetail(null)
      if (id === 'models' && accountsPage) openAccountsPage(null)
      onSectionChange(id)
      return
    }
    leaveSettings(() => onSectionChange(id))
  }

  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [jump, setJump] = useState<{ title: string; n: number } | null>(null)
  const hits = searchSettings(query, id => text(sectionLabel(id)))
  const safeHitIdx = hits.length > 0 ? Math.min(selectedHitIdx, hits.length - 1) : 0

  const openHit = (hit: SearchEntry): void => {
    const go = (): void => {
      if (hit.section === 'engines') openEngineDetail(hit.engine ?? null)
      if (hit.extTab) openExtTab(hit.extTab)
      setQuery('')
      onSectionChange(hit.section)
      setJump(j => ({ title: hit.title, n: (j?.n ?? 0) + 1 }))
    }
    if (hit.section === section) go()
    else leaveSettings(go)
  }

  useEffect(() => {
    const title = takeSettingsRow()
    if (title) setJump(j => ({ title, n: (j?.n ?? 0) + 1 }))
  }, [section, jumpToken])

  // 切换分区或进出二级页时回到顶部，并复位吸顶阴影与外观锚点
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
    setScrolled(false)
    if (section === 'appearance') setActiveAnchor('theme')
  }, [section, engineDetailId, accountsPage])

  useEffect(() => {
    if (!jump) return
    const timer = setTimeout(() => {
      const root = contentRef.current
      const el = [...(root?.querySelectorAll<HTMLElement>('[data-setting-title]') ?? [])].find(
        e => text(e.dataset.settingTitle ?? '') === text(jump.title),
      )
      const target = el ?? root?.querySelector<HTMLElement>('section')
      if (target) scrollInPane(target, 'center', { behavior: 'smooth' })
      el?.animate([{ boxShadow: '0 0 0 2px var(--color-accent)' }, { boxShadow: '0 0 0 2px transparent' }], {
        duration: 1600,
        easing: 'ease-out',
      })
    }, 60)
    return () => clearTimeout(timer)
  }, [jump, section, text])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (e.key !== 'Escape' || e.isComposing) return
      if (query.trim() && (document.activeElement === searchRef.current || !onEscape)) {
        setQuery('')
        return
      }
      if (onEscape) leaveSettings(onEscape)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onEscape, query])

  const dragBlank = (e: React.MouseEvent) => {
    if (!onStartMove) return
    if ((e.target as HTMLElement).closest('button, input, label, a, select, textarea, [role="button"]')) return
    onStartMove(e)
  }

  const resetBlank = (e: React.MouseEvent) => {
    if (!onResetSize) return
    if ((e.target as HTMLElement).closest('button, input, label, a, select, textarea, [role="button"]')) return
    onResetSize()
  }

  const engineSubTitle =
    section === 'engines' && engineDetailId
      ? (liveEngines.find(e => e.id === engineDetailId)?.name ?? ENGINES[engineDetailId]?.name ?? engineDetailId)
      : null
  const modelsSubTitle =
    section === 'models' && accountsPage
      ? tr('accounts.pageTitle', { channel: tr(`modelChannels.tab.${accountsPage}`) })
      : null
  const searching = query.trim().length > 0
  const contentWidthClass = WIDE_SECTIONS.has(section) && !searching ? 'max-w-[1160px]' : 'max-w-[920px]'

  const scrollToAppearanceAnchor = (id: string): void => {
    setActiveAnchor(id)
    const el = contentRef.current?.querySelector<HTMLElement>(`[data-appearance-group="${id}"]`)
    if (el) scrollInPane(el, 'start', { behavior: 'smooth' })
  }

  const onContentScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    setScrolled(el.scrollTop > 4)
    if (section !== 'appearance' || searching) return
    const top = el.getBoundingClientRect().top + 40
    let current = APPEARANCE_ANCHORS[0].id as string
    for (const a of APPEARANCE_ANCHORS) {
      const node = el.querySelector<HTMLElement>(`[data-appearance-group="${a.id}"]`)
      if (node && node.getBoundingClientRect().top <= top) current = a.id
    }
    setActiveAnchor(prev => (prev === current ? prev : current))
  }

  return (
    <div className="flex min-h-0 flex-1">
      <UnsavedLeaveDialog />
      <nav
        aria-label={t('sidebar.SidebarFooter.settings')}
        onMouseDown={dragBlank}
        className={cn(
          'flex w-[228px] shrink-0 flex-col bg-sidebar p-2.5 select-none',
          onStartMove && 'cursor-grab active:cursor-grabbing',
        )}
      >
        <label className="group mb-2.5 flex h-8 shrink-0 cursor-text items-center gap-2 rounded-lg border border-transparent bg-hover/70 px-2.5 transition-colors focus-within:border-accent-line focus-within:bg-surface">
          <Search size={14} className="shrink-0 text-fg-muted" />
          <input
            ref={searchRef}
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setSelectedHitIdx(0)
            }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'ArrowDown' && hits.length > 0) {
                e.preventDefault()
                setSelectedHitIdx(i => (i + 1) % hits.length)
              } else if (e.key === 'ArrowUp' && hits.length > 0) {
                e.preventDefault()
                setSelectedHitIdx(i => (i - 1 + hits.length) % hits.length)
              } else if (e.key === 'Enter' && hits[safeHitIdx]) {
                e.preventDefault()
                openHit(hits[safeHitIdx])
              }
            }}
            placeholder={tr('settings.SettingsDialog.nav.search')}
            aria-label={`${text('搜索设置')}（Ctrl+F）`}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-faint"
          />
          {query ? (
            <button
              type="button"
              aria-label={tr('settings.SettingsDialog.clearSearch')}
              onClick={() => setQuery('')}
              className="shrink-0 text-fg-faint hover:text-fg"
            >
              <X size={13} />
            </button>
          ) : (
            <kbd className="shrink-0 rounded bg-subtle px-1 font-mono text-[10px] leading-4 text-fg-faint group-focus-within:hidden">
              Ctrl+F
            </kbd>
          )}
        </label>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {MAIN_NAV_GROUPS.map((g, gi) => (
            <div key={gi} className={cn(gi > 0 && 'mt-3')}>
              <div className="px-2.5 pb-1 text-[11px] leading-4 font-medium text-fg-faint">{text(g.label)}</div>
              {g.ids.map(id => {
                const { label, nav, icon: Icon } = sectionInfo(id)
                const active = !searching && (id === section || (id === 'extensions' && section === 'plugins'))
                return (
                  <button
                    key={id}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    title={text(label)}
                    onClick={() => setSection(id)}
                    className={cn(
                      'press flex h-[29px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-ui transition-colors',
                      active ? 'bg-accent-soft font-medium text-accent-fg' : 'text-fg-secondary hover:bg-hover',
                    )}
                  >
                    <Icon
                      size={15}
                      strokeWidth={1.6}
                      className={cn('shrink-0', active ? 'text-accent-fg' : 'text-fg-muted')}
                    />
                    <span className="min-w-0 truncate">{text(nav ?? label)}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        {/* 底栏固定三格：日志 / 反馈（图标右上角未读红点，不挤压文字） / 关于 */}
        <div className="mt-2 grid shrink-0 grid-cols-3 gap-1 pt-2">
          {FOOTER_NAV_IDS.map(id => {
            const { label, nav, icon: Icon } = sectionInfo(id)
            const active = !searching && id === section
            const unread = id === 'feedback' ? feedbackUnread : 0
            return (
              <button
                key={id}
                type="button"
                aria-current={active ? 'page' : undefined}
                title={unread > 0 ? `${text(label)} (${unread})` : text(label)}
                onClick={() => setSection(id)}
                className={cn(
                  'press flex h-8 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-1 text-meta whitespace-nowrap transition-colors',
                  active ? 'bg-accent-soft font-medium text-accent-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
                )}
              >
                <span className="relative inline-flex shrink-0">
                  <Icon size={14} strokeWidth={1.6} />
                  {unread > 0 && (
                    <span
                      aria-label={String(unread)}
                      className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-notify ring-2 ring-sidebar"
                    />
                  )}
                </span>
                <span className="truncate">{text(nav ?? label)}</span>
              </button>
            )
          })}
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col bg-app">
        {/* 右侧吸顶页头：静止无边框融于底色，滚动后才浮现细线柔影；双击空白还原默认尺寸 */}
        <header
          onMouseDown={dragBlank}
          onDoubleClick={resetBlank}
          className={cn(
            'relative z-10 flex shrink-0 items-center border-b bg-app px-8 transition-[border-color,box-shadow] select-none @max-[640px]:px-5',
            standalone ? 'h-11' : 'h-12',
            scrolled ? 'border-line-layout shadow-xs' : 'border-transparent',
            onStartMove && 'cursor-grab active:cursor-grabbing',
          )}
        >
          <div
            className={cn('mx-auto flex w-full min-w-0 items-center gap-3', contentWidthClass, !standalone && 'pr-16')}
          >
            {searching ? (
              <h2 className="truncate text-section font-semibold text-fg">
                {tr('settingsLayout.searchResults', { n: hits.length })}
              </h2>
            ) : engineSubTitle ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => openEngineDetail(null)}
                  className="press -ml-2 inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-ui text-fg-muted hover:bg-hover hover:text-fg"
                >
                  <ArrowLeft size={14} />
                  {text(sectionLabel('engines'))}
                </button>
                <span className="text-fg-faint">/</span>
                <h2 className="truncate text-section font-semibold text-fg">{engineSubTitle}</h2>
              </div>
            ) : modelsSubTitle ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => openAccountsPage(null)}
                  className="press -ml-2 inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-ui text-fg-muted hover:bg-hover hover:text-fg"
                >
                  <ArrowLeft size={14} />
                  {text(sectionLabel('models'))}
                </button>
                <span className="text-fg-faint">/</span>
                <h2 className="truncate text-section font-semibold text-fg">{modelsSubTitle}</h2>
              </div>
            ) : (
              <>
                <h2 className="shrink-0 text-section font-semibold text-fg">{text(sectionLabel(section))}</h2>
                {section === 'appearance' && (
                  <div className="hidden min-w-0 items-center gap-0.5 overflow-x-auto rounded-full bg-subtle p-0.5 sm:inline-flex">
                    {APPEARANCE_ANCHORS.map(a => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => scrollToAppearanceAnchor(a.id)}
                        className={cn(
                          'cursor-pointer rounded-full px-2.5 py-0.5 text-[11.5px] whitespace-nowrap transition-colors',
                          activeAnchor === a.id
                            ? 'bg-surface font-medium text-fg shadow-xs'
                            : 'text-fg-muted hover:text-fg',
                        )}
                      >
                        {tr(a.key)}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="absolute right-2.5 flex shrink-0 items-center gap-1">
            {searching && (
              <Button className="h-7 px-2.5 text-meta" onClick={() => setQuery('')}>
                {tr('settingsLayout.clearSearch')}
              </Button>
            )}
            {!standalone && onPopOut && (
              <IconButton icon={SquareArrowOutUpRight} label={tr('settingsWindow.popOutTip')} onClick={onPopOut} />
            )}
            {!standalone && <IconButton icon={X} label={text('关闭（Esc）')} onClick={() => leaveSettings(onClose)} />}
          </div>
        </header>

        <SettingsPaneProvider>
          <div
            ref={contentRef}
            data-settings-pane=""
            onScroll={onContentScroll}
            className="@container min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-8 py-6 [scrollbar-gutter:stable] @max-[640px]:px-5"
          >
            <div className={cn('mx-auto w-full [&_[data-section-title]+p]:mt-0', contentWidthClass)}>
              {searching ? (
                <SettingGroup title={tr('settingsLayout.searchHint')}>
                  {hits.length === 0 ? (
                    <div className="px-4 py-6 text-center text-meta text-fg-muted">
                      {tr('settingsLayout.searchEmpty', { query: query.trim() })}
                    </div>
                  ) : (
                    hits.map((h, idx) => {
                      const info = sectionInfo(h.section)
                      const Icon = info?.icon ?? SlidersHorizontal
                      const itemTitle = text(h.title)
                      const catLabel = text(sectionLabel(h.section))
                      const selected = idx === safeHitIdx
                      return (
                        <button
                          key={`${h.section}-${h.title}-${h.engine ?? ''}-${h.extTab ?? ''}`}
                          type="button"
                          onMouseEnter={() => setSelectedHitIdx(idx)}
                          onClick={() => openHit(h)}
                          className={cn(
                            'relative flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left transition-colors first:[&>.search-hit-divider]:hidden',
                            selected ? 'bg-accent-soft/55' : 'hover:bg-hover',
                          )}
                        >
                          <span
                            aria-hidden
                            className="search-hit-divider pointer-events-none absolute top-0 right-5 left-5 h-px bg-line-subtle/55"
                          />
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-fg-muted">
                            <Icon size={15} strokeWidth={1.6} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-ui font-medium text-fg">
                              <HighlightMatch value={itemTitle} query={query} />
                            </span>
                            <span className="mt-0.5 block truncate text-meta text-fg-muted">
                              <HighlightMatch value={catLabel} query={query} />
                              {h.engine && ` › ${ENGINES[h.engine]?.name ?? h.engine}`}
                            </span>
                          </span>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-subtle px-2 py-0.5 text-label text-fg-secondary">
                            {catLabel}
                            <ArrowRight size={11} />
                          </span>
                        </button>
                      )
                    })
                  )}
                </SettingGroup>
              ) : section === 'account' ? (
                <AccountSection />
              ) : section === 'editor' ? (
                <EditorSection />
              ) : section === 'projects' ? (
                <ProjectsSection />
              ) : section === 'storage' ? (
                <>
                  <StorageSection
                    onOpenSession={sessionId => {
                      runMainAction({ kind: 'openSession', sessionId })
                      if (!standalone) onClose()
                    }}
                  />
                  <SettingGroup className="mt-5">
                    <DataLocationRow />
                  </SettingGroup>
                </>
              ) : section === 'general' ? (
                <GeneralSection />
              ) : section === 'chat' ? (
                <ChatSection />
              ) : section === 'assist' ? (
                <AssistSection />
              ) : section === 'models' ? (
                <ModelsSection />
              ) : section === 'agents' ? (
                <AgentsSection />
              ) : section === 'subagents' ? (
                <SubagentsSection openChannels={() => setSection('models')} />
              ) : section === 'extensions' || section === 'plugins' ? (
                <ExtensionsSection key={section} initialGroup={section === 'plugins' ? 'ai' : 'all'} />
              ) : section === 'machines' ? (
                <section>
                  <SectionTitle>{t('machines.title')}</SectionTitle>
                  <p className="mb-4 text-meta text-fg-muted">{t('machines.requirements')}</p>
                  <Button
                    onClick={() => {
                      if (!standalone) onClose()
                      runMainAction({ kind: 'manageMachines' })
                    }}
                  >
                    {t('machines.title')}
                  </Button>
                </section>
              ) : section === 'mobile' ? (
                <MobileSection />
              ) : section === 'im' ? (
                <ImSection />
              ) : section === 'terminal' ? (
                <TerminalSection />
              ) : section === 'engines' ? (
                <EnginesSection />
              ) : section === 'usage' ? (
                <UsageSection
                  onOpenSession={sessionId => {
                    runMainAction({ kind: 'openSession', sessionId })
                    if (!standalone) onClose()
                  }}
                />
              ) : section === 'notifications' ? (
                <NotificationsSection />
              ) : section === 'appearance' ? (
                <AppearanceSection />
              ) : section === 'shortcuts' ? (
                <ShortcutsSettings />
              ) : section === 'feedback' ? (
                <FeedbackSection />
              ) : section === 'logs' ? (
                <LogsSection />
              ) : (
                <AboutSection />
              )}
            </div>
          </div>
        </SettingsPaneProvider>
      </div>
    </div>
  )
}

export { isSectionId } from './sectionId'

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: LucideIcon }> = [
  {
    value: 'light',
    get label() {
      return tr('settings.SettingsDialog.light')
    },
    icon: Sun,
  },
  {
    value: 'dark',
    get label() {
      return tr('settings.SettingsDialog.dark')
    },
    icon: Moon,
  },
  {
    value: 'system',
    get label() {
      return tr('settings.SettingsDialog.system')
    },
    icon: Monitor,
  },
]

const MOTION_OPTIONS: Array<{ value: MotionPreference; label: string }> = [
  {
    value: 'on',
    get label() {
      return tr('settings.SettingsDialog.alwaysOn')
    },
  },
  {
    value: 'system',
    get label() {
      return tr('settings.SettingsDialog.system')
    },
  },
  {
    value: 'off',
    get label() {
      return tr('settings.motion.off')
    },
  },
]

const PANE_FOCUS_OPTIONS: Array<{ value: PaneFocusMotion; label: string }> = [
  {
    value: 'flash',
    get label() {
      return tr('settings.SettingsDialog.highlight')
    },
  },
  {
    value: 'slide',
    get label() {
      return tr('settings.SettingsDialog.slide')
    },
  },
  {
    value: 'none',
    get label() {
      return tr('settings.SettingsDialog.none')
    },
  },
]

function AppearanceSection() {
  useI18n()
  const { preference, setPreference, motion, setMotion, systemReducedMotion, paneFocusMotion, setPaneFocusMotion } =
    useTheme()
  const { text } = useI18n()
  const motionDisabled = motion === 'off' || (motion === 'system' && systemReducedMotion)
  return (
    <section>
      <SectionTitle>{tr('settings.SettingsDialog.appearance')}</SectionTitle>

      <SettingGroup title={tr('settingsAppearance.theme')} anchorId="theme">
        <SettingRow
          title={tr('settings.searchIndex.theme')}
          description={tr('settings.SettingsDialog.whenFollowingSystemTheme')}
          control={
            <Segmented
              label={text('主题')}
              options={THEME_OPTIONS.map(option => ({ ...option, label: text(option.label) }))}
              value={preference}
              onChange={setPreference}
            />
          }
        />
        <PaletteSettings />
        <AccentSettings />
        <FileIconThemeSettings />
        <EditorThemeSettings />
        <MinimalModeSettings />
        <WorkbenchFrameSettings />
      </SettingGroup>

      {/* 壁纸在毛玻璃前面：毛玻璃的提示写着「在上面选壁纸」 */}
      <SettingGroup title={tr('settingsAppearance.wallpaper')} anchorId="wallpaper">
        <WallpaperSettings />
        <GlassSettings />
      </SettingGroup>

      <SettingGroup title={tr('settings.SettingsDialog.fonts')} anchorId="fonts">
        <FontSettings />
      </SettingGroup>

      <SettingGroup title={tr('settingsAppearance.motion')} anchorId="motion">
        <SettingRow
          title={tr('settings.searchIndex.motion')}
          description={tr('settings.SettingsDialog.animationsForSidebarAnd')}
          hint={
            systemReducedMotion
              ? motion === 'on'
                ? tr('settings.SettingsDialog.systemAnimationsAreDisabled')
                : motion === 'system'
                  ? tr('settings.SettingsDialog.systemAnimationsAreDisabled2')
                  : undefined
              : undefined
          }
          control={
            <Segmented
              label={text('动画')}
              options={MOTION_OPTIONS.map(option => ({ ...option, label: text(option.label) }))}
              value={motion}
              onChange={setMotion}
            />
          }
        />

        <SettingRow
          title={tr('settings.searchIndex.paneSwitching')}
          description={tr('settings.SettingsDialog.highlightBrieflyLightsUp')}
          hint={
            motionDisabled
              ? tr('settings.SettingsDialog.motionIsDisabledPane')
              : tr('settings.SettingsDialog.onlyAffectsFocusChanges')
          }
          control={
            <Segmented
              label={text('切换窗格时')}
              options={PANE_FOCUS_OPTIONS.map(option => ({ ...option, label: text(option.label) }))}
              value={paneFocusMotion}
              onChange={setPaneFocusMotion}
              disabled={motionDisabled}
            />
          }
        />
        <ModeTransitionSettings />
      </SettingGroup>

      <SidebarSettings />
    </section>
  )
}
