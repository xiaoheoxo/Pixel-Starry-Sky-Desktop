// 概况 › PR：这个会话的 PR。状态圆标（开放绿、草稿灰、已合并强调色、已关闭红）、「#128」加粗跟标题，第二行分支和仓库，
// 一排标签：状态、检查、冲突、增删；有冲突时「让它修」是主按钮。数据和侧栏悬停卡同一份，主进程只查本机会话，远程机器上自然没有
import { useEffect, useState } from 'react'
import {
  Archive,
  Check,
  ChevronDown,
  CircleDashed,
  Copy,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  RefreshCw,
  X,
} from 'lucide-react'
import { cn, IconButton, useToast } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage, type TranslationKey } from '@/i18n/core'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { bridge, useEngineState } from '@/features/engine'
import { cleanIpcError } from '@/features/account/useStore'
import { isDemo } from '@/data'
import { sendFix } from '@/features/checks/SessionCheckBar'
import { copyPrLink, openUrl, PrFacts } from '@/features/sidebar/PrCard'
import { PR_STATE, visiblePrs } from '@/features/sidebar/sessionStatusModel'
import { useSessionStatus } from '@/features/sidebar/useSessionStatus'
import {
  prChecksRequest,
  prConflictRequest,
  type PrCheck,
  type PrMergeMethod,
  type PrMergeOptions,
  type SessionPr,
} from '../../../../../shared/types/session-status'
import { DiffBlocks } from './ChangesSection'
import { canMergePr, prCiKey, prConflictKey, prHeadline } from './overviewModel'
import type { SectionProps } from './OverviewPanel'
import { Pill, Section, Tag, type TagTone } from './Section'

const STATE_TONE: Record<SessionPr['state'], TagTone> = {
  open: 'ok',
  draft: 'default',
  merged: 'accent',
  closed: 'bad',
}
const ICON_TONE: Record<SessionPr['state'], string> = {
  open: 'bg-success/14 text-success',
  draft: 'bg-ov-chip text-fg-muted',
  merged: 'bg-accent-soft text-accent-fg',
  closed: 'bg-danger/15 text-danger',
}

export function PrSection({ sessionId, active }: SectionProps) {
  useI18n()
  const { prs, gh } = useSessionStatus()
  const list = active ? visiblePrs(prs[sessionId]) : []
  if (!list.length) return null
  const first = list[0]!
  const headline = prHeadline(first)
  const summary = [
    `#${first.number}`,
    list.length > 1 ? tr('overview.prCount', { count: list.length }) : null,
    headline?.text,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Section
      id="pr"
      icon={GitPullRequest}
      title={tr('overview.pr')}
      count={list.length > 1 ? list.length : undefined}
      summary={summary}
      tone={headline?.bad ? 'bad' : undefined}
    >
      {list.map(pr => (
        <PrCard key={pr.url} pr={pr} gh={gh} sessionId={sessionId} />
      ))}
    </Section>
  )
}

const CHECK_ICON: Record<PrCheck['state'], { icon: typeof Check; tone: string; label: TranslationKey }> = {
  fail: { icon: X, tone: 'text-danger', label: 'overview.prCheckFailed' },
  pending: { icon: RefreshCw, tone: 'text-warn', label: 'overview.prCheckPending' },
  pass: { icon: Check, tone: 'text-success', label: 'overview.prCheckPassed' },
}

/** 每项检查：图标（形状 + 颜色）、名字，点了在浏览器打开详情 */
function ChecksList({ checks }: { checks: PrCheck[] }) {
  const toast = useToast()
  return (
    <ul data-overview-pr-checks className="mt-1.5 ml-8 space-y-0.5">
      {checks.map((c, i) => {
        const look = CHECK_ICON[c.state]
        const Icon = look.icon
        return (
          <li key={c.name + i} className="flex min-w-0 items-center gap-1.5 text-meta">
            <Icon size={12} strokeWidth={2} className={cn('shrink-0', look.tone)} aria-label={tr(look.label)} />
            {c.url ? (
              <button
                type="button"
                title={c.url}
                onClick={() => void openUrl(c.url, toast)}
                className="min-w-0 truncate text-left text-fg-secondary hover:text-fg hover:underline"
              >
                {c.name}
              </button>
            ) : (
              <span className="min-w-0 truncate text-fg-secondary">{c.name}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

const METHOD_LABEL: Record<PrMergeMethod, TranslationKey> = {
  merge: 'overview.prMethodMerge',
  squash: 'overview.prMethodSquash',
  rebase: 'overview.prMethodRebase',
}

/** 合并确认框：合并方式只列仓库允许的，默认第一项；默认勾上删除远端分支 */
function MergeDialog({ pr, sessionId, onClose }: { pr: SessionPr; sessionId: string; onClose: () => void }) {
  const toast = useToast()
  const [options, setOptions] = useState<PrMergeOptions | null>(null)
  const [method, setMethod] = useState<PrMergeMethod>('merge')
  const [deleteBranch, setDeleteBranch] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const api = window.pixelsky?.sessionStatus
    if (isDemo || !api) {
      setOptions({ methods: ['merge', 'squash', 'rebase'], deleteBranch: true })
      return
    }
    let gone = false
    void api.mergeOptions(pr.url).then(
      o => {
        if (gone) return
        setOptions(o)
        setMethod(o.methods[0] ?? 'merge')
        setDeleteBranch(o.deleteBranch)
      },
      (e: Error) => !gone && setError(translateMessage(e.message)),
    )
    return () => {
      gone = true
    }
  }, [pr.url])
  const confirm = async (): Promise<void> => {
    const api = window.pixelsky?.sessionStatus
    if (isDemo || !api) return onClose()
    setBusy(true)
    setError(null)
    try {
      await api.mergePr(sessionId, pr.url, method, deleteBranch)
      toast(tr('overview.prMerged', { number: pr.number }))
      onClose()
    } catch (e) {
      setError(tr('overview.prMergeFailed', { error: translateMessage(cleanIpcError(e, String(e))) }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog
      title={tr('overview.prMergeTitle', { number: pr.number })}
      description={
        <div className="space-y-3">
          <p className="truncate" title={pr.title}>
            {pr.title}
          </p>
          <p className="font-mono text-meta text-fg-muted">
            {tr('overview.prMergeBody', { head: pr.head, base: pr.base })}
          </p>
          {options && (
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-meta text-fg-muted">{tr('overview.prMergeMethod')}</legend>
              {options.methods.map(m => (
                <label key={m} className="flex cursor-pointer items-center gap-2 text-ui text-fg">
                  <input
                    type="radio"
                    name="pr-merge-method"
                    checked={method === m}
                    onChange={() => setMethod(m)}
                    className="accent-accent"
                  />
                  {tr(METHOD_LABEL[m])}
                </label>
              ))}
            </fieldset>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-ui text-fg">
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={e => setDeleteBranch(e.target.checked)}
              className="accent-accent"
            />
            <span className="min-w-0 truncate">{tr('overview.prDeleteBranch', { head: pr.head })}</span>
          </label>
        </div>
      }
      confirmLabel={tr('overview.prMerge')}
      cancelLabel={tr('session.cancel')}
      busy={busy}
      error={error}
      confirmDisabled={!options}
      warn
      onConfirm={() => void confirm()}
      onCancel={onClose}
    />
  )
}

function PrCard({ pr, gh, sessionId }: { pr: SessionPr; gh: string; sessionId: string }) {
  const toast = useToast()
  const [showChecks, setShowChecks] = useState(false)
  const [merging, setMerging] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const summary = useEngineState(s => s.sessions.find(x => x.record.id === sessionId) ?? null)
  const open = pr.state === 'open' || pr.state === 'draft'
  const conflict = pr.state === 'open' && pr.conflict
  const checks = pr.checks ?? []
  const failing = open && pr.ci === 'fail'
  const canMerge = canMergePr(pr, isDemo ? 'ready' : gh)
  // 合并后提示归档（Q4：不自动归档）；还在跑、已经归档的不提示
  const canArchive =
    pr.state === 'merged' &&
    (isDemo || (!!summary && summary.state === 'idle' && !summary.record.archivedAt && !!bridge))
  const archive = async (): Promise<void> => {
    if (isDemo || !bridge) return toast(tr('overview.prArchived'))
    setArchiving(true)
    try {
      await bridge.archiveSession(sessionId, true, false)
      toast(tr('overview.prArchived'))
    } catch (e) {
      toast(translateMessage(cleanIpcError(e, String(e))))
    } finally {
      setArchiving(false)
    }
  }
  return (
    <div data-overview-pr={pr.number} className="[&+&]:mt-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('grid size-6 shrink-0 place-items-center rounded-full', ICON_TONE[pr.state])}>
          <GitPullRequest size={13} strokeWidth={1.6} />
        </span>
        <span title={pr.title} className="min-w-0 flex-1 truncate text-fg">
          <b className="mr-1 font-semibold">#{pr.number}</b>
          {pr.title}
        </span>
      </div>
      <div
        title={`${pr.head} → ${pr.base} · ${pr.repo}`}
        className="truncate pt-0.5 pl-8 font-mono text-label text-fg-faint"
      >
        {pr.head} → {pr.base} · {pr.repo}
      </div>
      <div className="flex flex-wrap items-center gap-[5px] pt-1.5 pl-8">
        {pr.unknown ? (
          <span className="text-meta">
            <PrFacts pr={pr} gh={gh} />
          </span>
        ) : (
          <>
            <Tag tone={STATE_TONE[pr.state]}>{tr(PR_STATE[pr.state])}</Tag>
            {pr.state === 'open' &&
              (pr.ci === 'pass' ? (
                <Tag tone="ok" icon={Check}>
                  {tr('sidebar.status.pr.ciPass')}
                </Tag>
              ) : pr.ci === 'pending' ? (
                <Tag tone="warn" icon={RefreshCw}>
                  {tr('sidebar.status.pr.ciPending')}
                </Tag>
              ) : pr.ci === 'fail' ? (
                <Tag tone="bad" icon={X}>
                  {pr.ciFailed > 0
                    ? tr('sidebar.status.pr.ciFail', { count: pr.ciFailed })
                    : tr('sidebar.status.pr.ciFailAny')}
                </Tag>
              ) : (
                <Tag icon={CircleDashed}>{tr('overview.prNoChecks')}</Tag>
              ))}
            {conflict && (
              <Tag tone="bad" icon={X}>
                {tr('sidebar.status.pr.conflict')}
              </Tag>
            )}
            <span className="ml-0.5 text-label tabular-nums">
              <span className="text-success">+{pr.additions}</span> <span className="text-danger">−{pr.deletions}</span>
            </span>
            <DiffBlocks added={pr.additions} removed={pr.deletions} />
            {open && checks.length > 0 && (
              <button
                type="button"
                data-overview-pr-checks-toggle
                aria-expanded={showChecks}
                onClick={() => setShowChecks(v => !v)}
                className="inline-flex items-center gap-0.5 rounded px-1 text-label text-fg-muted hover:bg-hover hover:text-fg"
              >
                {tr('overview.prChecksShow')}
                <ChevronDown size={12} className={cn('transition-transform', showChecks && 'rotate-180')} />
              </button>
            )}
          </>
        )}
      </div>
      {showChecks && open && checks.length > 0 && <ChecksList checks={checks} />}
      <div className="flex flex-wrap items-center gap-1.5 pt-2 pl-8">
        {conflict && (
          <Pill tone="primary" onClick={() => void sendFix(sessionId, prConflictRequest(pr), prConflictKey(pr), toast)}>
            {tr('checks.fix')}
          </Pill>
        )}
        {failing && (
          <Pill
            tone={conflict ? undefined : 'primary'}
            onClick={() => void sendFix(sessionId, prChecksRequest(pr), prCiKey(pr), toast)}
          >
            {tr('overview.prFixChecks')}
          </Pill>
        )}
        {canMerge && (
          <Pill tone="primary" onClick={() => setMerging(true)}>
            <GitMerge size={13} strokeWidth={1.6} />
            {tr('overview.prMerge')}
          </Pill>
        )}
        {canArchive && (
          <Pill tone="primary" disabled={archiving} onClick={() => void archive()}>
            <Archive size={13} strokeWidth={1.6} />
            {tr('overview.prArchive')}
          </Pill>
        )}
        <Pill onClick={() => void openUrl(pr.url, toast)}>
          <ExternalLink size={13} strokeWidth={1.6} />
          {tr('sidebar.status.openPr')}
        </Pill>
        <IconButton
          icon={Copy}
          label={tr('sidebar.status.copyLink')}
          size={22}
          iconSize={13}
          onClick={() => copyPrLink(pr.url, toast)}
        />
      </div>
      {merging && <MergeDialog pr={pr} sessionId={sessionId} onClose={() => setMerging(false)} />}
    </div>
  )
}
