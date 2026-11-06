import type { ReactNode } from 'react'
import { ChevronDown, Folder, Monitor } from 'lucide-react'
import { composerStatus } from '@/data'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { ComposerGit } from './ComposerGit'
import { FolderMenu } from './FolderMenu'
import { useActiveWorkspace } from '@/features/editor/target'
import type { StatusBarController } from '@/features/engine'
import { useI18n } from '@/i18n/I18nProvider'
import { openMachineManager, openWorkspacePicker, useMachines } from '@/features/machines/store'

/**
 * 输入框外部左上方的机器与项目，后面是 Git（分支、改动、拉取 / 推送、提交，docs/ui/composer-git.md）；欢迎页保留项目选择入口。
 * 传入 live 时显示真实项目（欢迎页可以切换 / 添加项目）；不传时是演示数据。git 是这个输入框所在的工作区，没有就不显示 Git
 */
export function ComposerStatusBar({
  live,
  extra,
  git,
}: {
  live?: StatusBarController
  extra?: ReactNode
  git?: WorkspaceRef | null
}) {
  const { text } = useI18n()
  const machines = useMachines(),
    machine = machines.machines.find(m => m.id === machines.currentId)
  const machineName = live ? (machine?.id === 'local' ? text('本机') : machine?.name) : text(composerStatus.machine)
  return (
    <div data-composer-workspace className="flex min-w-0 items-center gap-x-3 px-3 pt-1.5 pb-2 text-meta text-fg-faint">
      <button
        type="button"
        onClick={() => openMachineManager()}
        title={machineName}
        aria-label={machineName}
        className="inline-flex min-w-0 shrink-0 items-center gap-1.5 hover:text-fg"
      >
        <Monitor size={13} strokeWidth={1.5} className="shrink-0" />
        <span data-composer-machine-label className="truncate">
          {machineName}
        </span>
      </button>
      {live ? <ProjectPicker live={live} target={git ?? null} /> : <DemoFolder />}
      {(git ?? (!live && composerStatus.branch !== null ? DEMO_TARGET : null)) && (
        <span data-composer-git className="-ml-2 inline-flex min-w-0 items-center gap-x-1">
          <ComposerGit target={git ?? DEMO_TARGET} />
        </span>
      )}
      {extra && <span className="ml-auto flex shrink-0 items-center">{extra}</span>}
    </div>
  )
}

const DEMO_TARGET: WorkspaceRef = { projectId: 'demo' }

/** 演示模式：当前标签所在的演示项目，点开同一个文件夹菜单 */
function DemoFolder() {
  const workspace = useActiveWorkspace()
  if (!workspace.name) return null
  return <FolderMenu name={workspace.name} path={workspace.path} target={workspace.ref} />
}

/**
 * All project entry points share the same directory / Git worktree picker.
 * 已经开始的会话绑定在创建时的工作区，不能在这里换（issue #11；在这里选别的工作区并不会挪会话，
 * 而是另开一个会话，容易误会）：点开是文件夹菜单（FolderMenu），换文件夹都是明说的「开新对话」。
 */
function ProjectPicker({ live, target }: { live: StatusBarController; target: WorkspaceRef | null }) {
  const { text } = useI18n()
  const { project } = live
  if (!live.canPickProject)
    return <FolderMenu name={project?.name ?? text('选择项目文件夹')} path={project?.path ?? ''} target={target} />
  return (
    <button
      type="button"
      onClick={() => openWorkspacePicker()}
      title={project?.path}
      aria-label={text('切换工作区')}
      className="inline-flex min-w-0 items-center gap-1 rounded px-1 hover:bg-hover hover:text-fg"
    >
      <Folder size={13} className="shrink-0" />
      <span className="truncate">{project?.name ?? text('选择项目文件夹')}</span>
      <ChevronDown size={12} className="shrink-0" />
    </button>
  )
}
