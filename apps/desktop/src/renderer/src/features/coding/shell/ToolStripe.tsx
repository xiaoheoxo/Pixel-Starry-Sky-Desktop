import type { ReactNode } from 'react'
import {
  Bell,
  Boxes,
  CircleAlert,
  Files,
  GitBranch,
  Globe,
  ListChecks,
  ListTree,
  MessageSquare,
  MessagesSquare,
  Puzzle,
  Search,
  Settings,
  SquareKanban,
  SquareTerminal,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '@/i18n/core'
import { Avatar, CountBadge, Dot, IconButton, cn } from '@/ui'
import { useAccount } from '@/features/account'
import { useSettings } from '@/features/settings/SettingsProvider'
import { useFeedbackUnread } from '@/features/feedback/store'
import { useInbox } from '@/features/panel/inbox/useInbox'
import { OPEN_SETTINGS, TOGGLE_TERMINAL, withShortcut } from '@/features/layout/shortcuts'
import { setPage, showWorkbench, usePage } from '@/features/layout/page'
import { codingLayout, useCodingLayout } from '../layoutStore'
import { PROBLEMS_READY, useProblems } from '../problems'
import { useProjectContext } from '@/features/panel/projectContext'
import type { LeftView, RightView } from '../types'
import { useGitBadge } from '../left/git'
import { useConversationsBadge } from '../left/conversations'
import { useRunningTaskCount } from '../left/tasks'

/** 工具条按钮：32px 图标按钮，可带角标 */
function StripeButton({
  icon,
  label,
  active,
  onClick,
  badge,
  data,
}: {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
  badge?: ReactNode
  data: string
}) {
  return (
    <span className="relative inline-flex">
      <IconButton
        icon={icon}
        label={label}
        size={32}
        iconSize={18}
        active={active}
        aria-pressed={active}
        data-coding-stripe-button={data}
        onClick={onClick}
      />
      {badge ? <span className="pointer-events-none absolute -top-0.5 -right-0.5">{badge}</span> : null}
    </span>
  )
}

const LEFT_ITEMS: Array<{ view: LeftView; icon: LucideIcon; label: TranslationKey }> = [
  { view: 'files', icon: Files, label: 'coding.shell.files' },
  { view: 'outline', icon: ListTree, label: 'coding.shell.outline' },
  { view: 'search', icon: Search, label: 'coding.shell.search' },
  { view: 'git', icon: GitBranch, label: 'coding.shell.git' },
  { view: 'tasks', icon: ListChecks, label: 'coding.shell.tasks' },
  { view: 'conversations', icon: MessagesSquare, label: 'coding.shell.conversations' },
]

const RIGHT_ITEMS: Array<{ view: RightView; icon: LucideIcon; label: TranslationKey }> = [
  { view: 'chat', icon: MessageSquare, label: 'coding.shell.aiChat' },
  { view: 'browser', icon: Globe, label: 'coding.shell.browser' },
  { view: 'artifacts', icon: Boxes, label: 'coding.shell.artifacts' },
]

const stripe = 'flex w-10 shrink-0 flex-col items-center gap-1 bg-rail py-2'

function LeftStripe() {
  useI18n()
  const layout = useCodingLayout()
  const page = usePage()
  const settings = useSettings()
  const account = useAccount()
  const gitBadge = useGitBadge()
  const taskBadge = useRunningTaskCount()
  const conversationsDot = useConversationsBadge()
  const problems = useProblems(useProjectContext().ref)
  // 团队回复了反馈、还没看：设置按钮上一个数字角标（docs/ui/feedback-v2.md §4，超过 9 显示 9+）。大小、位置跟这条工具条上别的角标一致
  const feedbackUnread = useFeedbackUnread()
  const onWorkbench = page === 'workbench'
  const badgeOf = (view: LeftView): ReactNode =>
    view === 'git' && gitBadge > 0 ? (
      <CountBadge count={gitBadge} />
    ) : view === 'tasks' && taskBadge > 0 ? (
      <CountBadge count={taskBadge} />
    ) : view === 'conversations' && conversationsDot ? (
      <Dot tone="accent" size={7} />
    ) : null
  const problemCount = problems.errors + problems.warnings
  const name = account.user?.name ?? null
  return (
    <nav
      aria-label={tr('coding.shell.leftStripe')}
      data-coding-stripe="left"
      className={cn(stripe, 'border-r border-line-layout')}
    >
      {LEFT_ITEMS.map(({ view, icon, label }) => (
        <StripeButton
          key={view}
          data={view}
          icon={icon}
          label={tr(label)}
          active={onWorkbench && layout.left.open && layout.left.view === view}
          badge={badgeOf(view)}
          onClick={() => {
            showWorkbench()
            codingLayout.toggleLeft(view)
          }}
        />
      ))}
      <StripeButton
        data="board"
        icon={SquareKanban}
        label={tr('coding.shell.board')}
        active={page === 'board'}
        onClick={() => setPage(page === 'board' ? 'workbench' : 'board')}
      />
      <span className="flex-1" />
      <StripeButton
        data="terminal"
        icon={SquareTerminal}
        label={withShortcut(tr('coding.shell.terminal'), TOGGLE_TERMINAL)}
        active={onWorkbench && layout.bottom.open && layout.bottom.tab === 'terminal'}
        onClick={() => {
          showWorkbench()
          codingLayout.toggleBottom('terminal')
        }}
      />
      {PROBLEMS_READY && (
        <StripeButton
          data="problems"
          icon={CircleAlert}
          label={tr('coding.shell.problems')}
          active={onWorkbench && layout.bottom.open && layout.bottom.tab === 'problems'}
          badge={problemCount > 0 ? <CountBadge count={problemCount} /> : null}
          onClick={() => {
            showWorkbench()
            codingLayout.toggleBottom('problems')
          }}
        />
      )}
      <span aria-hidden className="my-1 h-px w-5 shrink-0 bg-line" />
      <StripeButton
        data="extensions"
        icon={Puzzle}
        label={tr('extensions.stripe')}
        active={settings.open && (settings.section === 'extensions' || settings.section === 'plugins')}
        onClick={() => settings.openSettings('extensions')}
      />
      <StripeButton
        data="settings"
        icon={Settings}
        label={withShortcut(tr('coding.shell.settings'), OPEN_SETTINGS)}
        active={
          settings.open &&
          settings.section !== 'account' &&
          settings.section !== 'extensions' &&
          settings.section !== 'plugins'
        }
        badge={feedbackUnread > 0 ? <CountBadge tone="notify" count={feedbackUnread} max={9} /> : null}
        onClick={() => settings.openSettings()}
      />
      <button
        type="button"
        aria-label={tr('coding.shell.account')}
        title={tr('coding.shell.account')}
        data-coding-stripe-button="account"
        onClick={() => settings.openSettings('account')}
        className="press no-drag flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
      >
        {name ? <Avatar name={name} size={24} /> : <UserRound size={18} strokeWidth={1.5} />}
      </button>
    </nav>
  )
}

function RightStripe() {
  useI18n()
  const layout = useCodingLayout()
  const page = usePage()
  const inbox = useInbox().length
  const onWorkbench = page === 'workbench'
  return (
    <nav
      aria-label={tr('coding.shell.rightStripe')}
      data-coding-stripe="right"
      className={cn(stripe, 'border-l border-line-layout')}
    >
      {RIGHT_ITEMS.map(({ view, icon, label }) => (
        <StripeButton
          key={view}
          data={view}
          icon={icon}
          label={tr(label)}
          active={onWorkbench && layout.right.open && layout.right.view === view}
          onClick={() => {
            showWorkbench()
            codingLayout.toggleRight(view)
          }}
        />
      ))}
      <span className="flex-1" />
      <StripeButton
        data="notifications"
        icon={Bell}
        label={tr('coding.shell.notifications')}
        active={onWorkbench && layout.right.open && layout.right.view === 'notifications'}
        badge={inbox > 0 ? <CountBadge count={inbox} /> : null}
        onClick={() => {
          showWorkbench()
          codingLayout.toggleRight('notifications')
        }}
      />
    </nav>
  )
}

/** 窗口两侧的竖直工具条：左边视图和工具，右边 AI 对话和浏览器等 */
export function ToolStripe({ side }: { side: 'left' | 'right' }) {
  return side === 'left' ? <LeftStripe /> : <RightStripe />
}
