// 概况 › 环境：这个会话跑在哪、用什么跑。总是有内容，所以概况不会空着
import { useEffect, useState, type ReactNode } from 'react'
import { FolderOpen, Monitor } from 'lucide-react'
import { ENGINES, isChatProject, type SessionRecord } from '@pixelsky/protocol'
import { CopyButton, IconButton, useToast } from '@/ui'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { PERMISSION_INFO } from '@/features/engine'
import { effortLabel, selfModelLabel } from '@/features/engine/labels'
import { revealPath } from '@/features/files/reveal'
import { machineOf, useMachines } from '@/features/machines/store'
import type { ProjectCopy } from '../../../../../shared/types/project-tools'
import { useGitStatus } from '../git/summary'
import { openRightTab } from '../workspaceStore'
import { useSessionRecord } from './overviewData'
import type { SectionProps } from './OverviewPanel'
import { Section, SectionAction } from './Section'

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
      {/* 放在子组件里：默认折叠时不读 Git 和副本 */}
      <EnvBody key={sessionId} sessionId={sessionId} record={record} machine={machine} local={machineId === 'local'} />
    </Section>
  )
}

function Row({ label, children, extra }: { label: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex min-h-[26px] items-center gap-[7px] text-fg-secondary">
      <span className="w-[5.5em] shrink-0 text-meta text-fg-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {extra}
    </div>
  )
}

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
  const ref = { sessionId }
  const git = useGitStatus(ref)
  const copy = useCurrentCopy(record)
  const shortId = sessionId.length > 12 ? `${sessionId.slice(0, 4)}…${sessionId.slice(-4)}` : sessionId
  const engine = [
    ENGINES[record.engine].name,
    selfModelLabel(record.engine, record.model),
    record.effort && effortLabel(record.effort),
  ]
  return (
    <>
      <Row label={tr('machines.group')}>{machine}</Row>
      <Row
        label={tr('channels.members.dir')}
        extra={
          <>
            <CopyButton text={record.cwd} label={tr('machines.folder.copyPath')} iconOnly />
            {local && (
              <IconButton
                icon={FolderOpen}
                label={tr('project.reveal')}
                size={24}
                iconSize={13}
                onClick={() => void revealPath(ref, '', toast)}
              />
            )}
          </>
        }
      >
        <span title={record.cwd} className="font-mono text-meta">
          {record.cwd}
        </span>
      </Row>
      {git?.repo && git.branch && (
        <Row label={tr('projectTools.branch')}>
          <span className="font-mono text-meta">{git.branch}</span>
          {(git.ahead > 0 || git.behind > 0) && (
            <span className="ml-1.5 text-meta text-fg-muted tabular-nums">
              {[git.ahead > 0 && `↑${git.ahead}`, git.behind > 0 && `↓${git.behind}`].filter(Boolean).join(' ')}
            </span>
          )}
        </Row>
      )}
      {copy && (
        <Row label={tr('coding.right.view.copies')}>
          <span className="font-mono text-meta">{copy.name}</span>
        </Row>
      )}
      <Row label={tr('session.ModelSourceMenu.engine')}>{engine.filter(Boolean).join(' · ')}</Row>
      <Row label={tr('settings.engines.EngineDetail.permissions')}>{PERMISSION_INFO[record.permissionMode].label}</Row>
      <Row
        label={tr('settings.usage.RecordsTable.conversation')}
        extra={<CopyButton text={sessionId} label={tr('coding.right.chat.copyId')} iconOnly />}
      >
        <span title={sessionId} className="font-mono text-meta">
          {shortId}
        </span>
      </Row>
      <div className="mt-1.5">
        <SectionAction onClick={() => openRightTab('sandbox')}>{tr('overview.envCheck')}</SectionAction>
      </div>
    </>
  )
}

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
