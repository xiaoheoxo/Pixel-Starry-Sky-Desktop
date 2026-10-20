// 「打开方式」（GitHub #12，docs/ui/open-with.md）：顶栏的分体按钮。左边直接用默认程序打开当前工作区，
// 右边的 ▾ 列出本机装了的编辑器、文件资源管理器和终端，标出默认的，可以改默认。图标位置里能挪走或隐藏。
import { useEffect, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Settings,
  SquareArrowOutUpRight,
  SquareTerminal,
} from 'lucide-react'
import { cn, Popover, useToast } from '@/ui'
import { isDemo } from '@/data'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { useSettings } from '@/features/settings/SettingsProvider'
import { machineOf } from '@/features/machines/store'
import type { SidebarPlacement } from '@/features/appearance/sidebar'
import type { EditorItem, EditorState, OpenTool } from '../../../../shared/types/workspace'
import { EditorIcon, editorLabel } from './EditorIcon'
import { refreshEditors, setEditors, useEditors } from './store'
import { useActiveWorkspace } from './target'
import { useToolbarState } from '@/features/layout/ToolbarContext'

type Choice = { kind: 'editor'; item: EditorItem } | { kind: 'tool'; tool: OpenTool }

const choiceId = (c: Choice): string => (c.kind === 'editor' ? c.item.id : c.tool.id)
/** 程序名：文件管理器和系统终端按界面语言显示，其余用程序自己的名字 */
export const toolName = (tool: OpenTool): string => {
  const platform = window.pixelsky?.platform
  if (tool.id === 'explorer')
    return tr(platform === 'darwin' ? 'openWith.finder' : platform === 'linux' ? 'openWith.files' : 'openWith.explorer')
  if (tool.id === 'terminal' && platform === 'darwin') return tr('openWith.terminal')
  return tool.name
}
const choiceName = (c: Choice): string => (c.kind === 'editor' ? editorLabel(c.item) : toolName(c.tool))

function ChoiceIcon({ choice }: { choice: Choice | null }) {
  if (!choice) return <SquareArrowOutUpRight size={16} strokeWidth={1.5} className="shrink-0" />
  if (choice.kind === 'editor') return <EditorIcon item={choice.item} />
  return choice.tool.id === 'explorer' ? (
    <FolderOpen size={16} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
  ) : (
    <SquareTerminal size={16} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
  )
}

/** 能选的：可用的编辑器，再是文件资源管理器和终端 */
function choices(state: EditorState | null): { editors: Choice[]; tools: Choice[] } {
  return {
    editors: (state?.items ?? []).filter(e => e.available).map(item => ({ kind: 'editor' as const, item })),
    tools: (state?.tools ?? []).map(tool => ({ kind: 'tool' as const, tool })),
  }
}

/** 直接点时用哪个：选过的；没选过用默认编辑器；都没有时为 null（点开菜单） */
export function defaultChoice(state: EditorState | null): Choice | null {
  const { editors, tools } = choices(state)
  const all = [...editors, ...tools]
  return all.find(c => choiceId(c) === state?.workspaceId) ?? all.find(c => choiceId(c) === state?.defaultId) ?? null
}

/** composer：输入框上方文件夹菜单里的一行（docs/ui/machines-workspaces.md §9），列表往右边弹 */
export function OpenInButton({ placement }: { placement: SidebarPlacement | 'composer' }) {
  useI18n()
  const toast = useToast()
  const settings = useSettings()
  const state = useEditors()
  const workspace = useActiveWorkspace()
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const { closeMenu } = useToolbarState()
  // 启动后空闲时读一次（要查注册表和安装目录），点按钮时就知道默认是哪个
  useEffect(() => {
    if (state) return
    const timer = setTimeout(() => void refreshEditors().catch(() => undefined), 3000)
    return () => clearTimeout(timer)
  }, [state])
  const ref = workspace.ref
  const remote = !!ref && machineOf(ref.sessionId ?? ref.projectId) !== 'local'
  const disabledReason = !ref ? tr('openWith.noWorkspace') : remote ? tr('project.remoteUnavailable') : null
  const current = defaultChoice(state)
  const { editors, tools } = choices(state)

  const open = async (choice: Choice): Promise<void> => {
    if (!ref) return
    if (isDemo) {
      toast(tr('editor.EditorButton.demoModeCannotOpen'))
      return
    }
    setBusy(true)
    try {
      const opened = await window.pixelsky!.editor.open(ref, choiceId(choice))
      setMenu(false)
      closeMenu?.()
      // 资源管理器、终端常常开在别的位置或被挡住：说一句打开了什么（编辑器自己会到前台）
      if (choice.kind === 'tool')
        toast(tr('openWith.openedIn', { tool: choiceName(choice), name: opened.target.split(/[\\/]/).pop() ?? '' }))
    } catch (e) {
      toast(translateMessage((e as Error).message))
    } finally {
      setBusy(false)
    }
  }
  const makeDefault = async (choice: Choice): Promise<void> => {
    if (isDemo) return
    try {
      // 选编辑器时也改「默认外部编辑器」，从文件打开时一致；文件资源管理器和终端只改这个按钮
      const patch =
        choice.kind === 'editor'
          ? { workspaceId: choice.item.id, defaultId: choice.item.id }
          : { workspaceId: choice.tool.id }
      setEditors(await window.pixelsky!.editor.preferences(patch))
    } catch (e) {
      toast(translateMessage((e as Error).message))
    }
  }
  const showMenu = (): void => {
    setMenu(value => !value)
    if (!isDemo) void refreshEditors().catch(e => toast(translateMessage((e as Error).message)))
  }

  const label = disabledReason
    ? disabledReason
    : current
      ? tr('openWith.openWith', { p0: choiceName(current), p1: workspace.name })
      : tr('openWith.choose')
  // 输入框上方的菜单里是一行，列表从右边弹出
  const asRow = placement === 'composer'
  const inTrack = placement === 'header'
  const side = placement === 'composer' ? 'right' : placement === 'bottom' ? 'top' : 'bottom'
  const align = placement === 'composer' || placement === 'header' ? 'end' : 'start'

  const row = (choice: Choice) => {
    const id = choiceId(choice),
      isDefault = current && choiceId(current) === id
    return (
      <div key={id} data-open-with={id} className="group flex h-8 items-center rounded-md hover:bg-hover">
        <button
          type="button"
          data-menu-item
          disabled={busy}
          onClick={() => void open(choice)}
          title={choice.kind === 'editor' ? choice.item.path : choice.tool.path}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left text-ui text-fg disabled:opacity-50"
        >
          <ChoiceIcon choice={choice} />
          <span className="min-w-0 flex-1 truncate">{choiceName(choice)}</span>
        </button>
        {isDefault ? (
          <span data-open-with-default className="mr-2 flex shrink-0 items-center gap-1 text-meta text-accent-fg">
            <Check size={12} />
            {tr('openWith.default')}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void makeDefault(choice)}
            className="mr-1 shrink-0 rounded px-1.5 py-0.5 text-meta text-fg-muted opacity-0 group-hover:opacity-100 hover:bg-selected hover:text-fg focus-visible:opacity-100"
          >
            {tr('openWith.setDefault')}
          </button>
        )}
      </div>
    )
  }

  const trigger = asRow ? (
    <button
      type="button"
      data-menu-item
      aria-haspopup="menu"
      aria-expanded={menu}
      title={disabledReason ?? undefined}
      disabled={!!disabledReason}
      onClick={showMenu}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-fg hover:bg-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent',
        menu && 'bg-hover',
      )}
    >
      <SquareArrowOutUpRight size={15} strokeWidth={1.5} className="shrink-0 text-fg-secondary" />
      <span className="flex-1">{tr('sidebar.action.openIn')}</span>
      <ChevronRight size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
    </button>
  ) : null

  return (
    <span data-open-in className={cn('relative shrink-0 items-center', trigger ? 'flex w-full' : 'inline-flex')}>
      {trigger ?? (
        <span
          className={cn(
            'group/open inline-flex items-center rounded-md',
            // 顶栏里在细边框轨道内，和右侧面板开关一样 24px 高（docs/ui/layout-v2.md §4）
            inTrack ? 'h-6' : 'h-8',
            menu && 'bg-selected',
            !!disabledReason && 'opacity-40',
          )}
        >
          <button
            type="button"
            aria-label={label}
            title={label}
            disabled={!!disabledReason || busy}
            onClick={() => (current ? void open(current) : showMenu())}
            className={cn(
              'press no-drag inline-flex h-full items-center gap-1.5 rounded-l-md text-fg-secondary hover:bg-hover hover:text-fg disabled:hover:bg-transparent',
              inTrack ? 'pr-0.5 pl-1.5' : 'pr-1 pl-2',
            )}
          >
            {/* 顶栏里编辑器的彩色图标平时去色，鼠标移上去、键盘焦点或菜单打开时才显示原色，整排只剩黑白灰；
                文件管理器、终端和默认的「↗」本来就是单色线条图标，不动 */}
            <span
              className={cn(
                'inline-flex',
                inTrack &&
                  !menu &&
                  current?.kind === 'editor' &&
                  'opacity-75 grayscale group-focus-within/open:opacity-100 group-focus-within/open:grayscale-0 group-hover/open:opacity-100 group-hover/open:grayscale-0',
              )}
            >
              <ChoiceIcon choice={current} />
            </span>
          </button>
          <button
            type="button"
            aria-label={tr('openWith.more')}
            title={tr('openWith.more')}
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={!!disabledReason}
            onClick={showMenu}
            className={cn(
              'press no-drag inline-flex h-full items-center justify-center rounded-r-md text-fg-muted hover:bg-hover hover:text-fg disabled:hover:bg-transparent',
              inTrack ? 'w-4' : 'w-5',
            )}
          >
            <ChevronDown size={inTrack ? 12 : 13} strokeWidth={1.5} />
          </button>
        </span>
      )}
      <Popover
        open={menu}
        onClose={() => setMenu(false)}
        side={side}
        align={align}
        offset={placement === 'composer' ? 8 : 4}
        className="max-h-96 w-64 overflow-auto"
      >
        <p className="px-2 pt-1 pb-1.5 text-meta text-fg-muted">
          {tr('openWith.title', { p0: workspace.name || tr('openWith.workspace') })}
        </p>
        {editors.length > 0 && (
          <>
            <p className="px-2 pt-1 text-label font-medium text-fg-faint">{tr('openWith.editors')}</p>
            {editors.map(row)}
          </>
        )}
        {!editors.length && state && (
          <p className="px-2 py-1 text-meta text-fg-muted">{tr('editor.ExternalFileButton.noEditorDetectedSpecify')}</p>
        )}
        {tools.length > 0 && (
          <>
            <p className="px-2 pt-2 text-label font-medium text-fg-faint">{tr('openWith.tools')}</p>
            {tools.map(row)}
          </>
        )}
        {!state && <p className="px-2 py-1 text-meta text-fg-muted">{tr('openWith.detecting')}</p>}
        <div role="separator" className="my-1 border-t border-line-subtle" />
        <button
          type="button"
          data-menu-item
          onClick={() => {
            setMenu(false)
            closeMenu?.()
            settings.openSettings('editor')
          }}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-fg-secondary hover:bg-hover hover:text-fg"
        >
          <Settings size={15} strokeWidth={1.5} />
          {tr('openWith.settings')}
        </button>
      </Popover>
    </span>
  )
}
