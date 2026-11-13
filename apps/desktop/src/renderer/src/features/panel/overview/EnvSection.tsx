// 概况 › 环境：这个会话跑在哪、用什么跑。默认一排胶囊（机器和副本、分支和同步、模型、权限），「详细」是一张标签列（目录、分支、副本、引擎、
// 权限、会话 ID）。总是有内容，所以概况不会空着
import { useEffect, useState, type ReactNode } from 'react'
import { Bot, ChevronRight, Folder, FolderOpen, GitBranch, Monitor, Shield } from 'lucide-react'
import { ENGINES, isChatProject, type SessionRecord } from '@pixelsky/protocol'
import { cn, CopyButton, IconButton, useToast } from '@/ui'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { PERMISSION_INFO } from '@/features/engine'
import { effortLabel, selfModelLabel } from '@/features/engine/labels'
import { revealPath } from '@/features/files/reveal'
import { machineOf, useMachines } from '@/features/machines/store'
import type { ProjectCopy } from '../../../../../shared/types/project-tools'
import { SyncButton } from '@/features/session/ComposerGit'
import { ago } from '../git/gitModel'
import { useGitStatus } from '../git/summary'
import { openRightTab } from '../workspaceStore'
import { useSessionRecord } from './overviewData'
import type { SectionProps } from './OverviewPanel'
import { tagClass, Pill, Section, Tag } from './Section'

export function EnvSection({ sessionId, active }: SectionProps) {
  useI18n()
  const record = useSessionRecord(sessionId, active)
  const machines = useMachines()
  if (!record) return null
  const machineId = machineOf(sessionId)
  const machine =
    machineId === 'local' ? tr('machines.local') : (machines.machines.find(m => m.id === machineId)?.name ?? machineId)
  return (
    <Section
      id="env"
      icon={Monitor}
      title={tr('workspace.sandbox')}
      summary={`${machine} · ${ENGINES[record.engine].name}`}
    >
      {/* 放在子组件里：折叠时不读 Git 和副本 */}
      <EnvBody key={sessionId} sessionId={sessionId} record={record} machine={machine} local={machineId === 'local'} />
    </Section>
  )
}

const OP = { size: 22, iconSize: 13 } as const
/** 环境胶囊比一般标签高一点，底色是格子色 */
const CHIP = 'h-6 bg-ov-tile px-[9px] text-meta'

function EnvBody({
  sessionId,
  record,
  machine,
  local,
}: {
  sessionId: string
  record: SessionRecord
  machine: string
  local: boolean
}) {
  useI18n()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const ref = { sessionId }
  const git = useGitStatus(ref)
  const copy = useCurrentCopy(record)
  const shortId = sessionId.length > 12 ? `${sessionId.slice(0, 4)}…${sessionId.slice(-4)}` : sessionId
  const model = [selfModelLabel(record.engine, record.model), record.effort && effortLabel(record.effort)]
    .filter(Boolean)
    .join(' · ')
  const permission = PERMISSION_INFO[record.permissionMode]
  const branch = git?.repo ? git.branch : null
  return (
    <>
      <div className="flex flex-wrap gap-[5px] py-0.5">
        <Tag icon={Monitor} className={CHIP}>
          {copy ? `${machine} · ${copy.name}` : machine}
        </Tag>
        {branch && git && (
          <span className={cn(tagClass(), CHIP, 'pr-1')}>
            <GitBranch size={12} strokeWidth={1.8} className="shrink-0 text-fg-muted" />
            <span title={branch} className="max-w-[12rem] truncate font-mono text-label">
              {branch}
            </span>
            {/* 同步只在这：「改动」里不重复 */}
            <SyncButton
              target={ref}
              status={git}
              chip="press -my-px inline-flex h-5 items-center rounded-full px-1.5 text-label text-accent-fg hover:bg-ov-chip"
            />
          </span>
        )}
        {model && (
          <Tag icon={Bot} className={CHIP}>
            {model}
          </Tag>
        )}
        <Tag icon={Shield} title={permission.hint} className={CHIP}>
          {permission.label}
        </Tag>
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="press -mx-1.5 flex min-h-7 w-[calc(100%+12px)] items-center gap-[9px] rounded-full px-1.5 text-left text-fg-secondary hover:bg-hover"
      >
        <Folder size={15} strokeWidth={1.6} className="shrink-0 text-fg-muted" />
        <span className="flex min-w-0 flex-1 items-center gap-1 text-fg-muted">
          {tr('overview.details')}
          <ChevronRight
            size={13}
            strokeWidth={1.6}
            className={cn(
              'shrink-0 text-fg-faint transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
        </span>
        {!open && (
          <span title={record.cwd} className="max-w-[60%] min-w-0 truncate font-mono text-label text-fg-faint">
            {record.cwd}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-0.5 mb-1.5">
          <div className="grid grid-cols-[max-content_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-px">
            <Key>{tr('channels.members.dir')}</Key>
            <Value mono title={record.cwd}>
              {record.cwd}
            </Value>
            <Ops>
              <CopyButton text={record.cwd} label={tr('machines.folder.copyPath')} iconOnly />
              {local && (
                <IconButton
                  icon={FolderOpen}
                  label={tr('project.reveal')}
                  {...OP}
                  onClick={() => void revealPath(ref, '', toast)}
                />
              )}
            </Ops>
            {branch && git && (
              <>
                <Key>{tr('projectTools.branch')}</Key>
                <Value>
                  <span className="font-mono">{branch}</span>{' '}
                  <small className="text-label text-fg-faint">
                    {[
                      git.upstream && `→ ${git.upstream}`,
                      git.head?.slice(0, 7),
                      git.fetchedAt && tr('overview.fetchedAgo', { time: ago(git.fetchedAt) }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </Value>
                <Ops>
                  <CopyButton text={branch} label={tr('projectTools.branch')} iconOnly />
                </Ops>
              </>
            )}
            {copy && (
              <>
                <Key>{tr('coding.right.view.copies')}</Key>
                <Value>
                  {copy.name}{' '}
                  <small className="text-label text-fg-faint">
                    · {tr('overview.copyBase', { branch: copy.baseBranch })}
                    {copy.dirty && ` · ${tr('overview.copyDirty')}`}
                  </small>
                </Value>
                <span />
              </>
            )}
            <Key>{tr('session.ModelSourceMenu.engine')}</Key>
            <Value>{[ENGINES[record.engine].name, model].filter(Boolean).join(' · ')}</Value>
            <span />
            <Key>{tr('overview.permission')}</Key>
            <Value title={permission.hint}>
              {permission.label} <small className="text-label text-fg-faint">· {permission.hint}</small>
            </Value>
            <span />
            <Key>{tr('settings.usage.RecordsTable.conversation')}</Key>
            <Value mono title={sessionId}>
              {shortId}
            </Value>
            <Ops>
              <CopyButton text={sessionId} label={tr('coding.right.chat.copyId')} iconOnly />
            </Ops>
          </div>
          <div className="pt-1">
            <Pill onClick={() => openRightTab('sandbox')}>{tr('overview.envCheck')}</Pill>
          </div>
        </div>
      )}
    </>
  )
}

const Key = ({ children }: { children: ReactNode }) => (
  <span className="self-start pt-1 text-label text-fg-faint">{children}</span>
)

function Value({ children, mono, title }: { children: ReactNode; mono?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'min-w-0 py-1 text-meta leading-[1.4] [overflow-wrap:anywhere] text-fg-secondary',
        mono && 'font-mono',
      )}
    >
      {children}
    </span>
  )
}

const Ops = ({ children }: { children: ReactNode }) => <span className="flex gap-0.5 self-start">{children}</span>

/** 这个会话的目录是项目的哪个副本；不是副本、读不到都是 null（读不到就不显示这一行，不报错） */
function useCurrentCopy(record: SessionRecord): ProjectCopy | null {
  const { projectId, cwd } = record
  const [copies, setCopies] = useState<ProjectCopy[]>(() => (isDemo ? demo().projectTools.copies : []))
  useEffect(() => {
    if (isDemo || !window.pixelsky || isChatProject(projectId)) return
    window.pixelsky.projectTools
      .copies(projectId)
      .then(setCopies)
      .catch(() => {})
  }, [projectId])
  return copies.find(c => c.path === cwd) ?? null
}
