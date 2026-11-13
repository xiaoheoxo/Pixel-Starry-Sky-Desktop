// 概况 › 改动：大数字「9 个文件 +128 −34」和增删方块、「提交…」常驻；按全部 / 这一轮 / 已暂存 / 冲突筛；每个文件一行
// （状态字母、文件名和目录分开、改名前的名字、这一轮改的小点、增删），冲突排最前；正在变基 / 合并时顶上一条橙色提示。
// 同步在环境的分支胶囊上，这里不重复
import { useState } from 'react'
import { FileDiff, TriangleAlert } from 'lucide-react'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '@/i18n/core'
import { useTurnChanges } from '@/features/coding/ai/useTurnChanges'
import { CommitButton, openChanges } from '@/features/session/ComposerGit'
import type { GitCode, GitStatus } from '../../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { reviewTurn } from '../artifacts/focus'
import { requestGitFile } from '../git/GitPanel'
import { splitPath } from '../git/gitModel'
import { useGitStatus } from '../git/summary'
import { openRightTab } from '../workspaceStore'
import { changeRows, type ChangeRow } from './overviewModel'
import type { SectionProps } from './OverviewPanel'
import { FilterChips, pillClass, Section, SectionLink, SECTION_LINKS } from './Section'

/** 默认列几个文件 */
const FIRST_FILES = 4

type Filter = 'all' | 'turn' | 'staged' | 'conflicted'

const CODE_TONE: Partial<Record<GitCode, string>> = {
  A: 'bg-success/14 text-success',
  '?': 'bg-success/14 text-success',
  D: 'bg-danger/15 text-danger',
  U: 'bg-danger/15 text-danger',
  R: 'bg-accent-soft text-accent-fg',
}

export function ChangesSection({ sessionId, active }: SectionProps) {
  useI18n()
  const target = active ? { sessionId } : null
  const status = useGitStatus(target)
  // 按文件算：同一个文件又暂存又没暂存只算一个，和下面筛选的「全部」一致
  const count = status?.repo ? changeRows(status, null, Infinity).rows.length : 0
  if (!target || !status || !count) return null
  const conflicts = status.conflicted.length
  return (
    <Section
      id="changes"
      icon={FileDiff}
      title={tr('overview.changes')}
      count={count}
      summary={
        conflicts ? tr('overview.changesConflicts', { count: conflicts }) : `${count} ${tr('overview.filesUnit')}`
      }
      tone={conflicts ? 'bad' : undefined}
    >
      {/* 放在子组件里：useTurnChanges 流式输出时每来一个字都重算，折叠着不用算 */}
      <ChangesBody sessionId={sessionId} target={target} status={status} count={count} />
    </Section>
  )
}

/** 五格增删方块：绿的格数按增加的占比 */
export function DiffBlocks({ added, removed }: { added: number; removed: number }) {
  const green = Math.round((added / (added + removed || 1)) * 5)
  return (
    <span aria-hidden className="inline-flex gap-0.5 self-center">
      {[0, 1, 2, 3, 4].map(i => (
        <i key={i} className={cn('size-[7px] rounded-[2px]', i < green ? 'bg-success' : 'bg-danger')} />
      ))}
    </span>
  )
}

function ChangesBody({
  sessionId,
  target,
  status,
  count,
}: {
  sessionId: string
  target: WorkspaceRef
  status: GitStatus
  count: number
}) {
  useI18n()
  const turn = useTurnChanges(sessionId)
  const [filter, setFilter] = useState<Filter>('all')
  const [all, setAll] = useState(false)
  const { rows } = changeRows(status, turn, Infinity)
  const pick: Record<Filter, (r: ChangeRow) => boolean> = {
    all: () => true,
    turn: r => !!r.turn,
    staged: r => r.staged,
    conflicted: r => r.conflicted,
  }
  const options = (
    [
      { id: 'all', label: tr('overview.filterAll') },
      { id: 'turn', label: tr('overview.thisTurn'), dot: 'bg-accent' },
      { id: 'staged', label: tr('overview.filterStaged') },
      { id: 'conflicted', label: tr('overview.filterConflicted'), dot: 'bg-danger' },
    ] as const
  )
    .map(o => ({ ...o, count: rows.filter(pick[o.id]).length }))
    .filter(o => o.id === 'all' || o.count > 0)
  const shown = options.some(o => o.id === filter) ? filter : 'all'
  const list = rows.filter(pick[shown])
  const visible = all ? list : list.slice(0, FIRST_FILES)
  // git 报了增删就用整个工作区的；没报（二进制、没请求统计）时退回这一轮的
  const stats = rows.some(r => r.insertions !== null || r.deletions !== null)
  const added = stats ? rows.reduce((n, r) => n + (r.insertions ?? 0), 0) : (turn?.added ?? 0)
  const removed = stats ? rows.reduce((n, r) => n + (r.deletions ?? 0), 0) : (turn?.removed ?? 0)
  return (
    <>
      {status.operation && (
        <div className="mt-0.5 mb-1.5 flex items-center gap-2 rounded-xl bg-warn/18 py-1.5 pr-1.5 pl-2.5 text-meta text-warn-fg">
          <TriangleAlert size={14} strokeWidth={1.6} className="shrink-0" />
          <span title={tr('git.operation.hint')} className="min-w-0 flex-1">
            {tr(`git.operation.${status.operation}` as TranslationKey)}
            {status.conflicted.length > 0 &&
              ` · ${tr('overview.changesConflicts', { count: status.conflicted.length })}`}
          </span>
          <SectionLink onClick={() => openRightTab('git')}>{tr('overview.gitPanel')}</SectionLink>
        </div>
      )}
      <div className="flex min-h-[30px] items-baseline gap-1.5">
        <b className="text-[length:calc(17px*var(--font-scale,1)*var(--density,1))] font-medium tabular-nums">
          {count}
        </b>
        <span className="text-meta text-fg-muted">{tr('overview.filesUnit')}</span>
        {(added > 0 || removed > 0) && (
          <>
            {!stats && <span className="text-meta text-fg-muted">{tr('overview.thisTurn')}</span>}
            <span className="text-meta text-success tabular-nums">+{added}</span>
            <span className="text-meta text-danger tabular-nums">−{removed}</span>
            <DiffBlocks added={added} removed={removed} />
          </>
        )}
        <span className="flex-1" />
        <span className="self-center">
          <CommitButton target={target} status={status} chip={pillClass('primary')} />
        </span>
      </div>
      {options.length > 1 && (
        <FilterChips
          value={shown}
          onChange={v => {
            setFilter(v)
            setAll(false)
          }}
          options={options}
          className="mt-0.5"
        />
      )}
      {visible.map(row => (
        <FileRow key={row.path} row={row} />
      ))}
      <div className={SECTION_LINKS}>
        {list.length > FIRST_FILES && (
          <SectionLink onClick={() => setAll(!all)}>
            {all ? tr('overview.showLess') : tr('overview.moreCount', { count: list.length - FIRST_FILES })}
          </SectionLink>
        )}
        {turn && (
          <SectionLink onClick={() => reviewTurn(sessionId, turn.turnKey === 'start' ? null : turn.turnKey)}>
            {tr('session.ChangedFilesCard.review')}
          </SectionLink>
        )}
        <SectionLink onClick={openChanges}>{tr('overview.gitPanel')}</SectionLink>
      </div>
    </>
  )
}

/** 一个文件：点了在 Git 面板看差异 */
function FileRow({ row }: { row: ChangeRow }) {
  const { name, dir } = splitPath(row.label)
  const plus = row.insertions ?? row.turn?.added ?? null
  const minus = row.deletions ?? row.turn?.removed ?? null
  return (
    <button
      type="button"
      title={row.label}
      onClick={() => {
        openRightTab('git')
        requestGitFile(row.path)
      }}
      className="press -mx-1.5 flex min-h-[26px] w-[calc(100%+12px)] items-center gap-2 rounded-full px-1.5 text-left text-meta text-fg-secondary hover:bg-hover"
    >
      <span
        className={cn(
          'inline-grid size-4 shrink-0 place-items-center rounded-[5px] font-mono text-[10px] leading-none font-semibold',
          CODE_TONE[row.code] ?? 'bg-ov-chip text-fg-muted',
        )}
      >
        {row.code}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <b className="font-medium text-fg">{name}</b>
        {row.origPath && <small className="ml-[5px] text-label text-fg-faint">← {splitPath(row.origPath).name}</small>}
        {dir && <small className="ml-[5px] text-label text-fg-faint">{dir.replace(/\/$/, '')}</small>}
      </span>
      {row.turn && <i title={tr('overview.thisTurn')} className="size-1.5 shrink-0 rounded-full bg-accent" />}
      {(plus !== null || minus !== null) && (plus || minus) ? (
        <span className="shrink-0 text-label whitespace-nowrap tabular-nums">
          <span className="text-success">+{plus ?? 0}</span> <span className="text-danger">−{minus ?? 0}</span>
        </span>
      ) : null}
    </button>
  )
}
