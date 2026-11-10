import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  Ellipsis,
  Folder,
  FolderOpen,
  Folders,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  SquareArrowOutUpRight,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { normalizeProjectName, PROJECT_NAME_LIMIT } from '@pixelsky/protocol'
import { cn, useToast } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { translateMessage } from '@/i18n/core'
import { isLive, removeProject, renameProject } from '@/features/engine'
import { machineOf } from '@/features/machines/store'
import { setProjectPinned } from '@/features/appearance/sidebar'
import { paneActions } from '@/features/panes/store'
import type { Project } from '@/data'
import { ProjectFoldersDialog } from './ProjectFoldersDialog'
import { planArchive, DEFAULT_DAYS } from './archiveOld'
import { collectArchiveItems, openArchiveOld } from './archiveOldData'

/**
 * 侧栏项目行：文件夹图标（展开时是打开的文件夹）+ 名字（docs/ui/sidebar-styles.md「大文件夹」版）。点击展开 / 收起；右键、⋯ 按钮、ContextMenu 键或 Shift+F10 打开项目菜单。
 * 悬停（或键盘聚焦到这一行）时 ⋯ 右边出现「+」，在这个项目下新建会话（issue #5）；菜单里也有这一项。
 * 重命名只改显示名，移除只把项目移出列表（磁盘文件和会话记录保留）。见 docs/ui/sidebar-compact-controls.md §9。
 */
export function ProjectRow({
  project,
  open,
  onToggle,
  trailing,
  picked = false,
  groupActions = [],
  onDragStart,
  pinned = false,
}: {
  project: Project
  open: boolean
  /** 点项目行：普通点击展开 / 收起，按住 Ctrl / Shift 是多选（ProjectTree 判断） */
  onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void
  /** 右边：在跑 / 等你的数目，收起时没有状态就写对话数和最近时间 */
  trailing?: ReactNode
  /** Ctrl / Shift 选中了（准备组成分区） */
  picked?: boolean
  /** 菜单里的分区操作（新建分区、加入「X」、移出分区），docs/ui/sidebar-groups.md */
  groupActions?: { label: string; icon: LucideIcon; run: () => void }[]
  /** 拖项目进出分区 */
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void
  /** 置顶了（docs/ui/project-pin.md）：图钉代替文件夹图标 */
  pinned?: boolean
}) {
  const { t } = useI18n()
  const toast = useToast()
  const row = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null),
    [coords, setCoords] = useState<{ x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<'rename' | 'remove' | 'folders' | null>(null)
  const remote = machineOf(project.id) !== 'local'

  const close = (restore = true): void => {
    setPosition(null)
    setCoords(null)
    if (restore) button.current?.focus({ preventScroll: true })
  }
  const show = (x?: number, y?: number): void => {
    const rect = row.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({ x: x ?? rect.right - 180, y: y ?? rect.bottom + 4 })
  }
  useLayoutEffect(() => {
    if (!position || !menu.current) return
    const rect = menu.current.getBoundingClientRect()
    setCoords({
      x: Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8)),
    })
    const down = (e: PointerEvent): void => {
      if (!menu.current?.contains(e.target as Node) && !row.current?.contains(e.target as Node)) close(false)
    }
    const scroll = (e: Event): void => {
      if (!menu.current?.contains(e.target as Node)) close(false)
    }
    const resize = (): void => close(false)
    document.addEventListener('pointerdown', down)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', resize)
    }
  }, [position])
  useLayoutEffect(() => {
    if (coords)
      menu.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus({ preventScroll: true })
  }, [coords])

  const run = (action: () => void): void => {
    close(false)
    if (!isLive) {
      toast(t('project.demo'))
      return
    }
    action()
  }
  const external = (task: () => Promise<unknown>): void =>
    run(() => void task().catch(error => toast(translateMessage((error as Error).message) || t('project.retry'))))
  const newSession = (): void => {
    close(false)
    paneActions.open(null, { project: project.id })
  }
  // 菜单打开时数一次：按默认天数能归档几个（不订阅，菜单一收就不再算）
  const oldCount = position
    ? planArchive(collectArchiveItems(), { days: DEFAULT_DAYS, projectId: project.id, now: Date.now() }).pick.length
    : 0
  const item =
    'flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-ui hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent'
  const action =
    'flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-selected hover:text-fg focus-visible:ring-2 focus-visible:ring-accent'

  return (
    <div
      ref={row}
      data-project-row={project.id}
      data-picked={picked || undefined}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onContextMenu={event => {
        event.preventDefault()
        show(event.clientX, event.clientY)
      }}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          show()
        }
      }}
      className={cn(
        'group/project relative flex h-8 min-w-0 shrink-0 items-center rounded-md text-list text-fg transition-colors',
        picked ? 'bg-accent-soft ring-1 ring-accent-line ring-inset' : 'hover:bg-hover',
      )}
    >
      <button
        ref={button}
        type="button"
        title={
          project.folders?.length
            ? [project.path ?? project.name, ...project.folders.map(f => f.path)].join('\n')
            : project.name
        }
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md pl-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        {pinned ? (
          <Pin data-project-pinned size={16} strokeWidth={1.5} className="shrink-0 text-fg-secondary" />
        ) : open ? (
          <FolderOpen size={16} strokeWidth={1.5} className="shrink-0 text-fg-secondary" />
        ) : (
          <Folder size={16} strokeWidth={1.5} className="shrink-0 text-fg-secondary" />
        )}
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
      </button>
      {/* 悬停时右边放 ⋯ 和 +：这一块变宽只是项目名更早截断，行高和左边的图标、名字位置都不动 */}
      <div
        className={cn(
          'relative flex h-full min-w-6 shrink-0 items-center justify-end pr-1',
          'group-hover/project:min-w-[56px] group-focus-within/project:min-w-[56px]',
          position && 'min-w-[56px]',
        )}
      >
        <span
          className={cn(
            'flex items-center group-hover/project:invisible group-focus-within/project:invisible',
            position && 'invisible',
          )}
        >
          {trailing}
        </span>
        <div
          className={cn(
            'absolute right-1 flex items-center gap-0.5',
            position ? 'visible' : 'invisible group-hover/project:visible group-focus-within/project:visible',
          )}
        >
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={!!position}
            aria-label={t('project.actions', { name: project.name })}
            title={t('project.menu')}
            onClick={() => (position ? close() : show())}
            className={action}
          >
            <Ellipsis size={16} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            data-project-new-session
            aria-label={t('project.newSessionIn', { name: project.name })}
            title={t('project.newSessionIn', { name: project.name })}
            onClick={newSession}
            className={action}
          >
            <Plus size={16} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      {position &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={t('project.menu')}
            data-project-menu
            className="pop-in no-drag fixed z-[70] min-w-44 rounded-lg border border-line-card bg-popover p-1 text-fg shadow-menu"
            style={{
              left: coords?.x ?? position.x,
              top: coords?.y ?? position.y,
              visibility: coords ? 'visible' : 'hidden',
            }}
            onKeyDown={event => {
              const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)')],
                i = items.indexOf(document.activeElement as HTMLButtonElement)
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                close()
              }
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                items[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (i + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
                ]?.focus({ preventScroll: true })
              }
              if (event.key === 'Tab') {
                event.preventDefault()
                close()
              }
            }}
          >
            <button role="menuitem" onClick={newSession} className={item}>
              <Plus size={15} strokeWidth={1.5} />
              {t('project.newSession')}
            </button>
            <div role="separator" className="my-1 border-t border-line-subtle" />
            {groupActions.map(action => (
              <button
                key={action.label}
                role="menuitem"
                onClick={() => {
                  close(false)
                  action.run()
                }}
                className={item}
              >
                <action.icon size={15} strokeWidth={1.5} />
                <span className="min-w-0 truncate">{action.label}</span>
              </button>
            ))}
            {groupActions.length > 0 && <div role="separator" className="my-1 border-t border-line-subtle" />}
            <button
              role="menuitem"
              data-project-pin
              onClick={() => {
                close()
                setProjectPinned(project.id, !pinned)
              }}
              className={item}
            >
              {pinned ? <PinOff size={15} strokeWidth={1.5} /> : <Pin size={15} strokeWidth={1.5} />}
              {t(pinned ? 'session.unpin' : 'session.pin')}
            </button>
            <button role="menuitem" onClick={() => run(() => setDialog('rename'))} className={item}>
              <PencilLine size={15} strokeWidth={1.5} />
              {t('project.rename')}
            </button>
            <button
              role="menuitem"
              disabled={remote || !isLive}
              title={remote ? t('projectFolders.remote') : undefined}
              onClick={() => run(() => setDialog('folders'))}
              className={item}
            >
              <Folders size={15} strokeWidth={1.5} />
              {t('projectFolders.menu')}
            </button>
            <button
              role="menuitem"
              disabled={remote}
              title={remote ? t('project.remoteUnavailable') : undefined}
              onClick={() => external(() => window.pixelsky!.files.reveal({ projectId: project.id }))}
              className={item}
            >
              <FolderOpen size={15} strokeWidth={1.5} />
              {t('project.reveal')}
            </button>
            <button
              role="menuitem"
              disabled={remote}
              title={remote ? t('project.remoteUnavailable') : undefined}
              onClick={() => external(() => window.pixelsky!.editor.open({ projectId: project.id }))}
              className={item}
            >
              <SquareArrowOutUpRight size={15} strokeWidth={1.5} />
              {t('project.openEditor')}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                close(false)
                openArchiveOld(project.id)
              }}
              className={item}
            >
              <Archive size={15} strokeWidth={1.5} />
              {t('archiveOld.menu')}
              {oldCount > 0 && (
                <span className="ml-auto pl-3 text-meta text-fg-faint">
                  {t('archiveOld.menuHint', { count: oldCount })}
                </span>
              )}
            </button>
            <div role="separator" className="my-1 border-t border-line-subtle" />
            <button role="menuitem" onClick={() => run(() => setDialog('remove'))} className={cn(item, 'text-danger')}>
              <Trash2 size={15} strokeWidth={1.5} />
              {t('project.remove')}
            </button>
          </div>,
          document.body,
        )}
      {dialog === 'rename' && (
        <RenameProjectDialog
          name={project.name}
          onSave={name => renameProject(project.id, name)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'folders' && project.path && (
        <ProjectFoldersDialog
          project={{ id: project.id, name: project.name, path: project.path, folders: project.folders }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'remove' && (
        <RemoveProjectDialog
          name={project.name}
          onRemove={() => removeProject(project.id)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

/** 共用的提交状态：进行中禁止重复提交，失败时把宿主错误翻译后留在对话框里。 */
function useSubmit(onClose: () => void) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const submit = async (task: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await task()
      onClose()
    } catch (e) {
      setError(translateMessage((e as Error).message) || t('project.retry'))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, submit }
}

function RenameProjectDialog({
  name,
  onSave,
  onClose,
}: {
  name: string
  onSave: (name: string) => Promise<void>
  onClose: () => void
}) {
  const { t } = useI18n()
  const [value, setValue] = useState(name)
  const { busy, error, setError, submit } = useSubmit(onClose)
  const save = (): void => {
    let next: string
    try {
      next = normalizeProjectName(value)
    } catch (e) {
      setError(translateMessage((e as Error).message))
      return
    }
    if (next === name) {
      onClose()
      return
    }
    void submit(() => onSave(next))
  }
  return (
    <ConfirmDialog
      title={t('project.renameTitle')}
      focusInput
      description={
        <>
          <p>{t('project.renameDescription')}</p>
          <label className="mt-4 flex flex-col gap-2">
            <span>{t('project.name')}</span>
            <input
              data-project-name
              value={value}
              disabled={busy}
              aria-invalid={!!error}
              onChange={event => {
                setValue(event.target.value)
                setError(null)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  save()
                }
              }}
              className="w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-composer-ring"
            />
            <span className="text-right text-meta tabular-nums text-fg-muted">
              {Array.from(value).length} / {PROJECT_NAME_LIMIT}
            </span>
          </label>
        </>
      }
      busy={busy}
      error={error}
      confirmLabel={t(busy ? 'project.busy' : 'project.save')}
      cancelLabel={t('project.cancel')}
      onConfirm={save}
      onCancel={onClose}
    />
  )
}

function RemoveProjectDialog({
  name,
  onRemove,
  onClose,
}: {
  name: string
  onRemove: () => Promise<void>
  onClose: () => void
}) {
  const { t } = useI18n()
  const { busy, error, submit } = useSubmit(onClose)
  return (
    <ConfirmDialog
      title={t('project.removeTitle', { name })}
      description={<p>{t('project.removeDescription')}</p>}
      busy={busy}
      error={error}
      danger
      confirmLabel={t(busy ? 'project.busy' : 'project.removeConfirm')}
      cancelLabel={t('project.cancel')}
      onConfirm={() => void submit(onRemove)}
      onCancel={onClose}
    />
  )
}
