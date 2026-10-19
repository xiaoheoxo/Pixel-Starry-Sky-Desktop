import { openMachineManager } from '@/features/machines/store'
import { Button } from '@/ui'
import { tr } from '../../i18n/core'
import { useEffect, useRef, useState } from 'react'
import {
  Bell,
  ChartColumn,
  CodeXml,
  Cpu,
  FolderOpen,
  Info,
  Keyboard,
  MessageSquareText,
  Monitor,
  ScrollText,
  Smartphone,
  Moon,
  Network,
  Palette,
  Puzzle,
  Route,
  Search,
  Sun,
  TerminalSquare,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { CountBadge, IconButton, Segmented, cn } from '@/ui'
import { useTheme, type MotionPreference, type ThemePreference } from '@/features/appearance/ThemeProvider'
import { AboutSection } from './AboutSection'
import { AccountSection } from '../account/settings/AccountSection'
import { FontSettings } from './FontSettings'
import { ReplyStatsSettings } from './ReplyStatsSettings'
import { ComposerStyleSettings } from './ComposerStyleSettings'
import { QuotaDisplaySettings } from './QuotaDisplaySettings'
import { takeSettingsRow } from './settingsJump'
import { AccentSettings } from './AccentSettings'
import { PaletteSettings } from './PaletteSettings'
import { MinimalModeSettings } from './MinimalModeSettings'
import { CloseActionSettings } from './CloseActionSettings'
import { TurnRailSettings } from './TurnRailSettings'
import { LongConversationSettings } from './LongConversationSettings'
import { StopBackgroundAgentsSettings } from './StopBackgroundAgentsSettings'
import { SubagentViewSettings } from './SubagentViewSettings'
import { ModeTransitionSettings } from './ModeTransitionSettings'
import { GitOpenStyleSettings } from './GitOpenStyleSettings'
import { MessageActionsSettings } from './MessageActionsSettings'
import { FullAccessStripSettings } from './FullAccessStripSettings'
import { CacheMissSettings } from './CacheMissSettings'
import { WallpaperSettings } from './WallpaperSettings'
import type { PaneFocusMotion } from '@/features/appearance/paneFocusMotion'
import { UsageSection } from '../usage/settings/UsageSection'
import { ModelsSection } from './models/ModelsSection'
import { EnginesSection } from './engines/EnginesSection'
import { openEngineDetail } from './engines/nav'
import { openExtTab } from '@/features/extstore/nav'
import { EditorSection } from '../editor/settings/EditorSection'
import { ExtensionsSection } from './extensions/ExtensionsSection'
import { FileIconThemeSettings } from './FileIconThemeSettings'
import { EditorThemeSettings } from './EditorThemeSettings'
import { searchSettings, type SearchEntry } from './searchIndex'
import { OPEN_SESSION_EVENT } from '@/features/engine'
import { GroupTitle, SectionTitle, SettingRow } from './SettingRow'
import { useI18n } from '@/i18n/I18nProvider'
import { LOCALE_OPTIONS, type Locale } from '../../../../shared/i18n/messages'
import { TerminalSection } from './TerminalSection'
import { SidebarSettings } from './SidebarSettings'
import { NotificationsSection } from './NotificationsSection'
import { ShortcutsSettings } from './ShortcutsSettings'
import { LogsSection } from '../logs/LogsSection'
import { FeedbackSection } from '../feedback/FeedbackSection'
import { useFeedbackUnread } from '../feedback/store'
import { MobileSection } from '../mobile/settings/MobileSection'
import { ProjectsSection } from './projects/ProjectsSection'
import { SubagentsSection } from './SubagentsSection'

export type SectionId =
  | 'account'
  | 'models'
  /** 像素星空引擎的子智能体走哪个站点（docs/ui/subagent-routing.md） */
  | 'subagents'
  | 'engines'
  | 'usage'
  | 'appearance'
  | 'shortcuts'
  | 'about'
  | 'editor'
  | 'projects'
  | 'extensions'
  /** 旧名：以前的「插件配置」，现在是扩展页的 AI 引擎分组；老入口（输入框里的链接）仍用它 */
  | 'plugins'
  | 'terminal'
  | 'machines'
  | 'notifications'
  | 'logs'
  | 'feedback'
  | 'mobile'

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
      return tr('terminal.settings')
    },
    get nav() {
      return tr('settings.SettingsDialog.nav.terminal')
    },
    icon: TerminalSquare,
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

/** 左侧导航分组（参考 JuCode：按设置作用于什么分组）；label 为 null 的组不显示标题 */
const NAV_GROUPS: Array<{ label: string | null; ids: SectionId[] }> = [
  {
    get label() {
      return tr('settings.SettingsDialog.application')
    },
    ids: [
      'account',
      'appearance',
      'notifications',
      'editor',
      'projects',
      'extensions',
      'shortcuts',
      'machines',
      'mobile',
    ],
  },
  {
    get label() {
      return tr('session.ModelSourceMenu.model')
    },
    ids: ['models', 'subagents', 'usage'],
  },
  {
    get label() {
      return tr('session.ModelSourceMenu.engine')
    },
    ids: ['engines', 'terminal'],
  },
  { label: null, ids: ['logs', 'feedback', 'about'] },
]

const sectionLabel = (id: SectionId): string => SECTIONS.find(s => s.id === id)?.label ?? id

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const SIZE_KEY = 'pixelsky.settings-size'
const MIN_W = 640
const MIN_H = 440
/** 和窗口边缘至少留的距离 */
const MARGIN = 12

/** 限制在窗口内：最小 640 × 440，不超过窗口；位置不跑出窗口 */
function clampRect(r: Rect): Rect {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.max(Math.min(MIN_W, vw - MARGIN * 2), Math.min(r.w, vw - MARGIN * 2))
  const h = Math.max(Math.min(MIN_H, vh - MARGIN * 2), Math.min(r.h, vh - MARGIN * 2))
  const x = Math.min(Math.max(MARGIN, r.x), vw - w - MARGIN)
  const y = Math.min(Math.max(MARGIN, r.y), vh - h - MARGIN)
  return { x, y, w, h }
}

/** 打开时：沿用上次的尺寸（默认 980 × 680），在窗口里居中 */
function initialRect(): Rect {
  let w = 980
  let h = 680
  try {
    const s = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null')
    if (s && typeof s.w === 'number' && typeof s.h === 'number') {
      w = s.w
      h = s.h
    }
  } catch {
    /* 忽略 */
  }
  const r = clampRect({ x: 0, y: 0, w, h })
  return clampRect({ ...r, x: (window.innerWidth - r.w) / 2, y: (window.innerHeight - r.h) / 2 })
}

/** 设置对话框：左侧分类、右侧内容。Esc、点遮罩、× 关闭（docs/ui/settings.md） */
export function SettingsDialog({
  section,
  onSectionChange: setSection,
  onClose,
}: {
  /** 与入口共享当前分类，内部导航与搜索跳转也同步更新。 */
  section: SectionId
  onSectionChange: (section: SectionId) => void
  onClose: () => void
}) {
  const { text, t } = useI18n()
  const feedbackUnread = useFeedbackUnread()
  // 设置搜索（docs/ui/plan-search-panes-compact.md §1）：结果替换左侧导航，点一条跳到那一页并高亮那一行
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [jump, setJump] = useState<{ title: string; n: number } | null>(null)
  const hits = searchSettings(query, id => text(sectionLabel(id)))
  const openHit = (hit: SearchEntry): void => {
    // 本机引擎的详情页里的设置：先打开那个引擎的详情（docs/ui/engine-settings-redesign.md §3.1）
    if (hit.section === 'engines') openEngineDetail(hit.engine ?? null)
    if (hit.extTab) openExtTab(hit.extTab)
    setSection(hit.section)
    setJump(j => ({ title: hit.title, n: (j?.n ?? 0) + 1 }))
  }
  // 从别处（例如额度弹窗的「额度按钮设置」）打开设置时带来的目标行：取一次，走下面同一套滚动 + 高亮
  useEffect(() => {
    const title = takeSettingsRow()
    if (title) setJump(j => ({ title, n: (j?.n ?? 0) + 1 }))
  }, [section])
  useEffect(() => {
    if (!jump) return
    // 等新页面渲染出来再找
    const t = setTimeout(() => {
      const root = contentRef.current
      const el = [...(root?.querySelectorAll<HTMLElement>('[data-setting-title]') ?? [])].find(
        e => text(e.dataset.settingTitle ?? '') === text(jump.title),
      )
      const target = el ?? root?.querySelector<HTMLElement>('section')
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el?.animate([{ boxShadow: '0 0 0 2px var(--color-accent)' }, { boxShadow: '0 0 0 2px transparent' }], {
        duration: 1600,
        easing: 'ease-out',
      })
    }, 60)
    return () => clearTimeout(t)
  }, [jump, section])
  // 位置和尺寸（docs/ui/settings.md §10）：标题栏拖动移动、右下角拖动缩放；尺寸记在本机，位置每次打开居中
  const [rect, setRect] = useState<Rect>(() => initialRect())
  const rectRef = useRef(rect)
  rectRef.current = rect
  const dialogRef = useRef<HTMLDivElement>(null)

  // 主窗口变小时把对话框收回窗口内
  useEffect(() => {
    const onResize = () => setRect(r => clampRect(r))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /** 按下后跟随鼠标：mode=move 移动，mode=resize 改右下角 */
  const startDrag = (e: React.MouseEvent, mode: 'move' | 'resize') => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const start = { x: e.clientX, y: e.clientY, rect: rectRef.current }
    document.body.style.cursor = mode === 'move' ? 'grabbing' : 'se-resize'
    // 最后一次计算出的尺寸：松手时直接存它，不读 rectRef（松手前可能还没重新渲染，读到的是旧值）
    let last = start.rect
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      const r = start.rect
      last = clampRect(mode === 'move' ? { ...r, x: r.x + dx, y: r.y + dy } : { ...r, w: r.w + dx, h: r.h + dy })
      setRect(last)
    }
    const onUp = () => {
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (mode === 'resize') {
        try {
          localStorage.setItem(SIZE_KEY, JSON.stringify({ w: last.w, h: last.h }))
        } catch {
          /* 忽略 */
        }
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    // 焦点放在对话框本身（不显示焦点框），Tab 再进入里面的控件
    dialogRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F：聚焦设置搜索；搜索框里有字时 Esc 先清空
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (e.key !== 'Escape') return
      if (document.activeElement === searchRef.current && searchRef.current?.value) {
        setQuery('')
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="fade-in no-drag fixed inset-0 z-50 bg-scrim"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="pop-in outline-none absolute flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-popover"
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      >
        {/* 标题栏空白处按住拖动，移动设置窗口 */}
        <header
          onMouseDown={e => {
            if ((e.target as HTMLElement).closest('button')) return
            startDrag(e, 'move')
          }}
          className="flex h-12 shrink-0 cursor-grab items-center justify-between border-b border-line pr-2 pl-5 select-none active:cursor-grabbing"
        >
          <h2 id="settings-title" className="text-section font-semibold text-fg">
            {t('sidebar.SidebarFooter.settings')}
          </h2>
          <IconButton icon={X} label={text('关闭（Esc）')} onClick={onClose} />
        </header>

        {/* 右下角的调整大小手柄：拖动改变宽 / 高（记住尺寸，下次打开沿用） */}
        <div
          aria-hidden
          title={tr('settings.SettingsDialog.dragToResize')}
          onMouseDown={e => startDrag(e, 'resize')}
          className="absolute right-0 bottom-0 z-10 flex size-5 cursor-se-resize items-end justify-end p-1 text-fg-faint hover:text-fg-muted"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M9 3 3 9M9 6.5 6.5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav
            aria-label={t('sidebar.SidebarFooter.settings')}
            className="flex w-[196px] shrink-0 flex-col border-r border-line bg-sidebar p-2"
          >
            <label className="mb-2 flex h-8 shrink-0 items-center gap-2 rounded-md border border-line bg-surface px-2.5 focus-within:border-line-strong">
              <Search size={14} className="shrink-0 text-fg-muted" />
              <input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && hits[0]) openHit(hits[0])
                }}
                placeholder={tr('settings.SettingsDialog.nav.search')}
                aria-label={`${text('搜索设置')}（Ctrl+F）`}
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-faint"
              />
              {query && (
                <button
                  type="button"
                  aria-label={tr('settings.SettingsDialog.clearSearch')}
                  onClick={() => setQuery('')}
                  className="shrink-0 text-fg-faint hover:text-fg"
                >
                  <X size={13} />
                </button>
              )}
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {query.trim() ? (
                hits.length === 0 ? (
                  <p className="px-2.5 py-2 text-meta text-fg-faint">{text('没有匹配的设置')}</p>
                ) : (
                  <ul aria-label={text('搜索结果')} className="flex flex-col gap-0.5">
                    {hits.map(h => (
                      <li key={`${h.section}-${h.title}`}>
                        <button
                          type="button"
                          onClick={() => openHit(h)}
                          className={cn(
                            'press flex w-full flex-col rounded-md px-2.5 py-1.5 text-left hover:bg-hover',
                            h.section === section && jump?.title === h.title && 'bg-accent-soft',
                          )}
                        >
                          <span className="truncate text-ui text-fg">{text(h.title)}</span>
                          <span className="truncate text-label text-fg-muted">{text(sectionLabel(h.section))}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                NAV_GROUPS.map((g, gi) => (
                  <div key={gi} className={cn(gi > 0 && 'mt-2 border-t border-line-subtle pt-2')}>
                    {g.label && <div className="px-2.5 pb-1 text-label font-medium text-fg-faint">{text(g.label)}</div>}
                    {g.ids.map(id => {
                      const { label, nav, icon: Icon } = SECTIONS.find(s => s.id === id)!
                      const active = id === section || (id === 'extensions' && section === 'plugins')
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-current={active ? 'page' : undefined}
                          title={text(label)}
                          onClick={() => setSection(id)}
                          className={cn(
                            'press flex h-[34px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-ui',
                            active ? 'bg-accent-soft font-medium text-accent-fg' : 'text-fg-secondary hover:bg-hover',
                          )}
                        >
                          <Icon
                            size={16}
                            strokeWidth={1.5}
                            className={cn('shrink-0', active ? 'text-accent-fg' : 'text-fg-muted')}
                          />
                          {/* 一行放不下（别的语言、等宽字体）就省略，不折行撑破行高；悬停看全名 */}
                          <span className="min-w-0 truncate">{text(nav ?? label)}</span>
                          {id === 'feedback' && feedbackUnread > 0 && (
                            <CountBadge tone="notify" count={feedbackUnread} max={9} className="ml-auto" />
                          )}
                        </button>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </nav>

          <div
            ref={contentRef}
            className="@container min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-8 py-6 [scrollbar-gutter:stable] @max-[640px]:px-5"
          >
            {section === 'account' ? (
              <AccountSection />
            ) : section === 'editor' ? (
              <EditorSection />
            ) : section === 'projects' ? (
              <ProjectsSection />
            ) : section === 'models' ? (
              <ModelsSection />
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
                    onClose()
                    openMachineManager()
                  }}
                >
                  {t('machines.title')}
                </Button>
              </section>
            ) : section === 'mobile' ? (
              <MobileSection />
            ) : section === 'terminal' ? (
              <TerminalSection />
            ) : section === 'engines' ? (
              <EnginesSection onOpenModels={() => setSection('models')} />
            ) : section === 'usage' ? (
              <UsageSection
                onOpenSession={sessionId => {
                  // 由 App 打开对应会话（docs/ui/usage.md §3）；先关掉设置
                  window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId } }))
                  onClose()
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
              <AboutSection onOpenAccount={() => setSection('account')} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

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
  const { locale, setLocale, t, text } = useI18n()
  const motionDisabled = motion === 'off' || (motion === 'system' && systemReducedMotion)
  return (
    <section>
      <SectionTitle>{tr('settings.SettingsDialog.appearance')}</SectionTitle>
      <SettingRow
        title={tr('settings.searchIndex.theme')}
        description={tr('settings.SettingsDialog.whenFollowingSystemTheme')}
      >
        <Segmented
          label={text('主题')}
          options={THEME_OPTIONS.map(option => ({ ...option, label: text(option.label) }))}
          value={preference}
          onChange={setPreference}
        />
      </SettingRow>
      <PaletteSettings />
      <AccentSettings />
      <MinimalModeSettings />
      <FileIconThemeSettings />
      <EditorThemeSettings />
      <SettingRow
        title={tr('settings.SettingsDialog.interfaceLanguage')}
        description={tr('settings.SettingsDialog.chooseLanguageUsedBy')}
      >
        <Segmented
          label={t('settings.SettingsDialog.interfaceLanguage')}
          options={LOCALE_OPTIONS}
          value={locale}
          onChange={value => setLocale(value as Locale)}
        />
      </SettingRow>
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
      >
        <Segmented
          label={text('动画')}
          options={MOTION_OPTIONS.map(option => ({ ...option, label: text(option.label) }))}
          value={motion}
          onChange={setMotion}
        />
      </SettingRow>

      <SettingRow
        title={tr('settings.searchIndex.paneSwitching')}
        description={tr('settings.SettingsDialog.highlightBrieflyLightsUp')}
        hint={
          motionDisabled
            ? tr('settings.SettingsDialog.motionIsDisabledPane')
            : tr('settings.SettingsDialog.onlyAffectsFocusChanges')
        }
      >
        <Segmented
          label={text('切换窗格时')}
          options={PANE_FOCUS_OPTIONS.map(option => ({ ...option, label: text(option.label) }))}
          value={paneFocusMotion}
          onChange={setPaneFocusMotion}
          disabled={motionDisabled}
        />
      </SettingRow>
      <ModeTransitionSettings />
      <GitOpenStyleSettings />
      <CloseActionSettings />

      <SidebarSettings />

      <GroupTitle>{tr('settings.engines.EngineDetail.conversation')}</GroupTitle>
      <ComposerStyleSettings />
      <QuotaDisplaySettings />
      <ReplyStatsSettings />
      <TurnRailSettings />
      <LongConversationSettings />
      <SubagentViewSettings />
      <StopBackgroundAgentsSettings />
      <MessageActionsSettings />
      <FullAccessStripSettings />
      <CacheMissSettings />

      <GroupTitle>{tr('settings.SettingsDialog.fonts')}</GroupTitle>
      <FontSettings />

      <GroupTitle>{tr('settings.searchIndex.wallpaper')}</GroupTitle>
      <WallpaperSettings />
    </section>
  )
}
