// 压缩上下文（docs/ui/compaction.md）：对话流里的一条分隔线。
// 进行中：胶囊上写着停在哪一步——经过本机网关（平台、自定义 API）时看得到「等待上游接通 / 模型读取对话 / 输出摘要 ↓ token / 整理上下文」，
// 下面一条步骤轨；直连官方只有「等待模型」和重试。重试、上游出错、输出停住时变琥珀色，并在下面说明原因（停住时可以中断）。
// 进度条是软进度：还没出字时来回扫，输出时按「已输出 / 平时的摘要长度」推进；直连时按以往用时估算，画成斜纹（compactionEstimate.ts）。
// 结束：「压缩前 → 压缩后」、减少的比例和用时；模型、首字、摘要 token、请求次数只在点开的详情里。
// 在页面上看着它压完时，进度条从停下的位置接着缩到压缩后的比例、数字从压缩前递减到压缩后；翻历史时直接显示结果
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { FoldVertical } from 'lucide-react'
import type { CompactionProgress } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { cn, Popover } from '@/ui'
import { useSimulatedProgress } from '@/ui/simulatedProgress'
import { isDemo } from '@/data'
import { bridge } from '@/features/engine'
import { useReducedMotion } from '@/features/appearance/ThemeProvider'
import { formatTokens } from '@/features/usage/format'
import { formatDuration } from './agentTrace'
import {
  compactionClock,
  compactionRate,
  compactionRatio,
  compactionSaved,
  compactionSoftProgress,
  compactionView,
  easeOut,
  easeTokens,
  waitingSlow,
  type CompactionItem,
  type CompactionPhase,
  type CompactionView,
} from './compaction'
import {
  expectedDuration,
  expectedFirstToken,
  expectedOutput,
  expectedRatio,
  loadSamples,
  recordSample,
} from './compactionEstimate'
import { CompactionLiveContext, type CompactionLive } from './compactionLive'
import { retryProgress } from './retryProgress'

const SHRINK_MS = 900
/** 直连时等这么久才提示「看不到输出进度」，很快压完的不用提示 */
const DIRECT_HINT_MS = 10_000

const PHASE_KEY = {
  preparing: 'session.compaction.phase.preparing',
  connecting: 'session.compaction.phase.connecting',
  reading: 'session.compaction.phase.reading',
  streaming: 'session.compaction.phase.streaming',
  finishing: 'session.compaction.phase.finishing',
  retrying: 'session.compaction.phase.retrying',
  upstreamError: 'session.compaction.phase.upstreamError',
  waiting: 'session.compaction.phase.waiting',
} as const satisfies Record<CompactionPhase, string>

const seconds = (ms: number): number => Math.max(0, Math.floor(ms / 1000))
const secondsFixed = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(1)

/** 进行中每秒刷新 */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

/** 刚在页面上压完：0→1 的进度，驱动数字递减；其它情况直接是 1。watched：在页面上看着它压的 */
function useShrink(item: CompactionItem, reduced: boolean): { t: number; watched: boolean } {
  // 挂上时还在压缩：说明用户看着它压完。压缩后的大小可能晚一点才到（下一次请求补上），到了再播
  const watched = useRef(item.status === 'running')
  const [t, setT] = useState(0)
  const animate = watched.current && item.status === 'completed' && item.postTokens !== null && !reduced
  useEffect(() => {
    if (item.status === 'running') {
      watched.current = true
      return
    }
    if (!animate) return
    const start = performance.now()
    let frame = requestAnimationFrame(function step(time) {
      const next = Math.min(1, (time - start) / SHRINK_MS)
      setT(next)
      if (next < 1) frame = requestAnimationFrame(step)
      else watched.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [item.status, animate])
  return { t: animate ? t : 1, watched: watched.current }
}

type StepState = 'done' | 'active' | 'warn' | 'todo'

/** 步骤轨：发出请求 → 模型响应 → 输出摘要 → 完成（只有经过网关的会话） */
function compactionSteps(
  view: CompactionView,
  p: CompactionProgress | null,
  now: number,
): { label: string; state: StepState; meta: string }[] {
  const { phase } = view
  const failed = phase === 'retrying' || phase === 'upstreamError'
  const request =
    phase === 'preparing'
      ? { state: 'active' as const, meta: tr('session.compaction.step.preparing') }
      : { state: 'done' as const, meta: p && p.requests > 1 ? tr('session.compaction.attempt', { n: p.requests }) : '' }
  let response: { state: StepState; meta: string } = { state: 'todo', meta: '' }
  if (phase === 'connecting')
    response = {
      state: 'active',
      meta: tr('session.compaction.step.connecting', { s: seconds(view.waitingMs ?? 0) }),
    }
  else if (phase === 'reading')
    response = {
      state: 'active',
      meta: tr('session.compaction.step.reading', { s: seconds(now - (p?.connectedAt ?? now)) }),
    }
  else if (failed && !p?.firstTokenAt)
    response = { state: 'warn', meta: p?.status ? `HTTP ${p.status}` : tr('session.compaction.step.failed') }
  else if (p?.firstTokenAt)
    response = {
      state: 'done',
      meta: tr('session.compaction.step.firstToken', { s: secondsFixed(p.firstTokenAt - p.requestAt) }),
    }
  let summary: { state: StepState; meta: string } = { state: 'todo', meta: '' }
  const out = formatTokens(p?.outputTokens ?? 0)
  if (phase === 'streaming') {
    const rate = p ? compactionRate(p) : null
    summary =
      view.stalledMs !== null
        ? { state: 'warn', meta: tr('session.compaction.step.noContent', { s: seconds(view.stalledMs) }) }
        : {
            state: 'active',
            meta: rate === null ? out : tr('session.compaction.step.rate', { n: out, rate }),
          }
  } else if (phase === 'finishing') summary = { state: 'done', meta: tr('session.compaction.step.tokens', { n: out }) }
  else if (failed && p?.firstTokenAt) summary = { state: 'warn', meta: p.status ? `HTTP ${p.status}` : out }
  const done: { state: StepState; meta: string } =
    phase === 'finishing'
      ? { state: 'active', meta: tr('session.compaction.step.rebuilding') }
      : { state: 'todo', meta: '' }
  return [
    { label: tr('session.compaction.step.request'), ...request },
    { label: tr('session.compaction.step.response'), ...response },
    { label: tr('session.compaction.step.summary'), ...summary },
    { label: tr('session.compaction.step.done'), ...done },
  ]
}

function StepTrack({ steps }: { steps: ReturnType<typeof compactionSteps> }) {
  return (
    <div className="flex items-start text-label text-fg-faint">
      {steps.map((step, i) => (
        <div key={i} className="flex items-start">
          {i > 0 && (
            <span className={cn('mt-[7px] h-px w-6 bg-line', step.state !== 'todo' && 'bg-accent/50')} aria-hidden />
          )}
          <div data-step={step.state} className="flex min-w-20 flex-col items-center gap-px">
            <span
              className={cn(
                'inline-flex items-center gap-1.5',
                step.state === 'done' && 'text-fg-secondary',
                step.state === 'active' && 'font-medium text-fg',
                step.state === 'warn' && 'text-warn',
              )}
            >
              <span
                className={cn(
                  'size-[7px] shrink-0 rounded-full border-[1.5px] border-fg-faint',
                  step.state === 'done' && 'border-accent bg-accent',
                  step.state === 'active' && 'compaction-step-active border-accent bg-accent',
                  step.state === 'warn' && 'border-warn bg-warn',
                )}
              />
              {step.label}
            </span>
            <span
              className={cn(
                'whitespace-nowrap tabular-nums',
                step.state === 'active' && 'text-accent-fg',
                step.state === 'warn' && 'text-warn',
              )}
            >
              {step.meta || ' '}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="text-fg-faint">{label}</span>
      <span className="min-w-0 break-words text-fg-secondary">{children}</span>
    </>
  )
}

/** 点开胶囊的详情：进行中看网关报来的进度，结束后看汇总 */
function CompactionDetails({
  item,
  progress: p,
  live,
  now,
}: {
  item: CompactionItem
  progress: CompactionProgress | null
  live: CompactionLive | null
  now: number
}) {
  const running = item.status === 'running'
  const model = running ? (p?.model ?? null) : (item.model ?? null)
  const requestedModel = running ? (p?.requestedModel ?? null) : null
  const requests = running ? (p?.requests ?? null) : (item.requests ?? null)
  const firstTokenMs = running ? (p?.firstTokenAt ? p.firstTokenAt - p.requestAt : null) : (item.firstTokenMs ?? null)
  const output = running ? (p && p.outputTokens > 0 ? p.outputTokens : null) : (item.outputTokens ?? null)
  const rate = running && p ? compactionRate(p) : null
  const size = [
    item.preTokens !== null ? tr('session.compaction.before', { n: item.preTokens.toLocaleString() }) : null,
    item.postTokens !== null ? tr('session.compaction.after', { n: item.postTokens.toLocaleString() }) : null,
  ].filter(Boolean)
  const note =
    running && !p
      ? tr(live?.gateway ? 'session.compaction.detail.waitingGateway' : 'session.compaction.detail.noGateway')
      : null
  return (
    <div className="flex flex-col gap-2 text-meta">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {model && (
          <DetailRow label={tr('session.compaction.detail.model')}>
            <span className="font-mono">{model}</span>
            {requestedModel && requestedModel !== model && (
              <span className="block text-label text-fg-faint">
                {tr('session.compaction.detail.compactModel', { model: requestedModel })}
              </span>
            )}
          </DetailRow>
        )}
        {requests !== null && (
          <DetailRow label={tr('session.compaction.detail.requests')}>
            {tr('session.compaction.detail.requestsN', { n: requests })}
          </DetailRow>
        )}
        {running && p?.connectedAt && (
          <DetailRow label={tr('session.compaction.detail.connected')}>
            {p.status !== null ? `HTTP ${p.status} · ` : ''}
            {tr('session.compaction.detail.after', { s: secondsFixed(p.connectedAt - p.requestAt) })}
          </DetailRow>
        )}
        {firstTokenMs !== null && (
          <DetailRow label={tr('session.compaction.detail.firstToken')}>
            {tr('session.compaction.detail.after', { s: secondsFixed(firstTokenMs) })}
          </DetailRow>
        )}
        {output !== null && (
          <DetailRow label={tr('session.compaction.detail.output')}>
            <span className="tabular-nums">{output.toLocaleString()} tokens</span>
            {running && p && !p.outputExact && (
              <span className="text-fg-faint"> · {tr('session.compaction.detail.estimated')}</span>
            )}
          </DetailRow>
        )}
        {rate !== null && (
          <DetailRow label={tr('session.compaction.detail.rate')}>
            <span className="tabular-nums">{rate} tok/s</span>
          </DetailRow>
        )}
        {running && p?.lastByteAt && !p.done && (
          <DetailRow label={tr('session.compaction.detail.lastData')}>
            {tr('session.compaction.detail.secondsAgo', { s: secondsFixed(now - p.lastByteAt) })}
          </DetailRow>
        )}
        {running && p?.error && (
          <DetailRow label={tr('session.compaction.detail.error')}>
            <span className="text-warn">{translateMessage(p.error)}</span>
          </DetailRow>
        )}
        {size.length > 0 && (
          <DetailRow label={tr('session.compaction.detail.size')}>
            {size.map(line => (
              <span key={line} className="block tabular-nums">
                {line}
              </span>
            ))}
          </DetailRow>
        )}
        {!running && item.durationMs !== null && (
          <DetailRow label={tr('session.compaction.detail.duration')}>{formatDuration(item.durationMs)}</DetailRow>
        )}
      </div>
      {note && <p className="text-label text-fg-faint">{note}</p>}
    </div>
  )
}

export function CompactionRow({ item }: { item: CompactionItem }) {
  useI18n()
  const reduced = useReducedMotion()
  const live = useContext(CompactionLiveContext)
  const running = item.status === 'running'
  const now = useClock(running)
  const { t: progress, watched } = useShrink(item, reduced)
  const ratio = compactionRatio(item)
  const saved = compactionSaved(item)
  const pre = item.preTokens,
    post = item.postTokens
  // 样本在挂上时读一次：预计用时（直连时估进度）、压缩比例、平时的摘要长度和首字用时
  const [samples] = useState(loadSamples)
  const expected = expectedDuration(pre, samples)
  const target = expectedRatio(samples)
  const p = running && live?.progress?.itemId === item.id ? live.progress : null
  const view = running ? compactionView(p, live?.retry ?? null, !!live?.gateway, now) : null
  const phase = view?.phase ?? null
  const sim = useSimulatedProgress(item.startedAt, expected, running && phase === 'waiting', reduced)
  const widthAt = (v: number): number => 1 - (1 - target) * v
  const soft = phase ? compactionSoftProgress(phase, p?.outputTokens ?? 0, expectedOutput(samples)) : null
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const [stopping, setStopping] = useState(false)
  // 压完 / 失败那一刻进度条停在哪（看着它压的才有）：最后一次画出来的宽度，来回扫的时候算满格
  const lastWidth = useRef(1)
  useEffect(() => {
    if (isDemo || !watched || item.status !== 'completed' || pre === null || post === null || item.durationMs === null)
      return
    recordSample({
      id: item.id,
      preTokens: pre,
      durationMs: item.durationMs,
      ratio: post / pre,
      ...(item.firstTokenMs ? { firstTokenMs: item.firstTokenMs } : {}),
      ...(item.outputTokens ? { outputTokens: item.outputTokens } : {}),
    })
  }, [watched, item.status, item.id, item.durationMs, item.firstTokenMs, item.outputTokens, pre, post])
  const shownPost = pre !== null && post !== null ? easeTokens(pre, post, progress) : post

  const stalled = view?.stalledMs != null
  const trouble = phase === 'retrying' || phase === 'upstreamError' || stalled
  const title = running
    ? tr('session.compaction.running')
    : item.status === 'completed'
      ? tr(item.trigger === 'auto' ? 'session.compaction.autoDone' : 'session.compaction.done')
      : item.status === 'interrupted'
        ? tr('session.compaction.interrupted')
        : tr('session.compaction.failed')
  const failed = item.status === 'failed'
  const time = running
    ? compactionClock(now - item.startedAt)
    : item.durationMs !== null
      ? tr('session.compaction.took', { time: formatDuration(item.durationMs) })
      : null

  // 进度条：determinate 时的宽度；running 时 null 表示来回扫
  const runningWidth = phase === 'waiting' ? widthAt(sim.value) : soft !== null ? widthAt(soft) : null
  useEffect(() => {
    if (running) lastWidth.current = runningWidth ?? 1
  }, [running, runningWidth])
  const stopped = watched && !running && item.durationMs !== null ? lastWidth.current : null
  const tone = running
    ? trouble
      ? 'warn'
      : 'running'
    : failed
      ? 'failed'
      : item.status === 'interrupted'
        ? 'muted'
        : 'done'
  const meter = running || ratio !== null || stopped !== null
  const width = running
    ? runningWidth
    : ratio !== null
      ? (stopped ?? 1) - ((stopped ?? 1) - ratio) * easeOut(progress)
      : stopped

  // 胶囊上阶段后面跟的数字：输出的 token、重试倒计时、第几次请求
  let metric: ReactNode = null
  if (phase === 'streaming' || phase === 'finishing')
    metric = (
      <span className={cn('font-mono text-label font-semibold tabular-nums', stalled ? 'text-warn' : 'text-accent-fg')}>
        ↓ {p && !p.outputExact ? '~' : ''}
        {formatTokens(p?.outputTokens ?? 0)}
      </span>
    )
  else if (phase === 'retrying' && live?.retry?.retryAt && live.retry.retryAt > now)
    metric = (
      <span className="text-label text-warn tabular-nums">
        {tr('session.compaction.retryIn', { s: Math.ceil((live.retry.retryAt - now) / 1000) })}
        {live.retry.scope === 'turn'
          ? retryProgress(live.retry)
          : live.retry.attempt !== null && ` ·${retryProgress(live.retry)}`}
      </span>
    )
  else if ((phase === 'connecting' || phase === 'reading') && p && p.requests > 1)
    metric = <span className="text-label text-fg-faint">{tr('session.compaction.attempt', { n: p.requests })}</span>

  // 胶囊下面的说明
  const stop = (): void => {
    if (!bridge || !live?.turnId || stopping) return
    setStopping(true)
    void bridge
      .interruptTurn(live.sessionId, live.turnId)
      .catch(() => {})
      .finally(() => setStopping(false))
  }
  let hint: ReactNode = null
  if (view && running) {
    const reason = translateMessage(live?.retry?.reason ?? p?.error ?? '')
    if (phase === 'retrying') hint = tr('session.compaction.hint.retrying', { reason })
    else if (phase === 'upstreamError') hint = tr('session.compaction.hint.upstreamError', { reason })
    else if (stalled)
      hint = (
        <>
          {tr(view.heartbeat ? 'session.compaction.hint.stalled' : 'session.compaction.hint.stalledDead', {
            s: seconds(view.stalledMs ?? 0),
          })}
          {live?.turnId && bridge && (
            <button
              type="button"
              disabled={stopping}
              onClick={stop}
              className="ml-2 rounded-md border border-danger/35 bg-surface px-2 text-label leading-5 text-danger hover:bg-danger/[0.06] disabled:opacity-60"
            >
              {tr(stopping ? 'session.compaction.interrupting' : 'session.compaction.interrupt')}
            </button>
          )}
        </>
      )
    else if (phase === 'waiting' && now - item.startedAt > DIRECT_HINT_MS) hint = tr('session.compaction.hint.direct')
    else if (waitingSlow(view, expectedFirstToken(samples)))
      hint =
        phase === 'connecting'
          ? tr('session.compaction.hint.slowConnecting')
          : tr('session.compaction.hint.slowReading', { s: seconds(expectedFirstToken(samples)) })
  }
  // 经过网关的才有步骤轨（有进度也说明经过了网关）
  const steps = view && (live?.gateway || p) && phase !== 'waiting' ? compactionSteps(view, p, now) : null

  return (
    <div
      data-compaction={item.status}
      data-phase={phase ?? undefined}
      role={running ? 'status' : undefined}
      className="compaction-row my-2.5 flex flex-col items-center gap-1.5 text-meta select-none"
    >
      <div className="flex w-full items-center gap-3">
        <span className="h-px min-w-6 flex-1 bg-linear-to-r from-transparent to-line" />
        <button
          ref={anchor}
          type="button"
          data-tone={tone}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={tr('session.compaction.details')}
          onClick={() => setOpen(v => !v)}
          className={cn(
            'compaction-pill inline-flex h-8 max-w-[92%] min-w-0 items-center gap-2 rounded-full border py-1 pr-3.5 pl-1 shadow-sm',
            tone === 'running' && 'compaction-pill-running text-fg-secondary',
            tone === 'warn' && 'border-warn/45 bg-warn/[0.06] text-fg-secondary',
            tone === 'done' && 'border-line-subtle bg-surface text-fg-secondary',
            tone === 'failed' && 'border-warn/35 bg-warn/[0.06] text-warn',
            tone === 'muted' && 'border-line-subtle bg-surface text-fg-muted',
          )}
        >
          <span
            className={cn(
              'grid size-6 shrink-0 place-items-center rounded-full',
              tone === 'running' && 'bg-accent text-accent-on',
              tone === 'warn' && 'bg-warn/15 text-warn',
              tone === 'done' && 'bg-accent-soft text-accent-fg',
              tone === 'failed' && 'bg-warn/15 text-warn',
              tone === 'muted' && 'bg-subtle text-fg-muted',
            )}
          >
            <FoldVertical size={13} strokeWidth={2} className={cn(running && 'compaction-icon')} />
          </span>
          <span className={cn('shrink-0 font-medium', tone === 'running' && 'compaction-text')}>{title}</span>
          {phase && (
            <>
              <span className="size-[3px] shrink-0 rounded-full bg-fg-faint" aria-hidden />
              <span className={cn('min-w-0 truncate', trouble ? 'font-medium text-warn' : 'text-fg-muted')}>
                {tr(stalled ? 'session.compaction.phase.stalled' : PHASE_KEY[phase])}
              </span>
              {metric}
            </>
          )}
          {pre !== null && (
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-label tabular-nums">
              <span className={shownPost !== null ? 'text-fg-faint' : 'text-fg-muted'}>{formatTokens(pre)}</span>
              {meter && (
                <span className="relative block h-1.5 w-14 overflow-hidden rounded-full bg-line">
                  {running && width === null ? (
                    <span
                      className={cn(
                        'compaction-indeterminate absolute inset-y-0 w-1/3 rounded-full',
                        trouble ? 'compaction-indeterminate-slow bg-warn' : 'bg-accent/75',
                      )}
                    />
                  ) : (
                    <span
                      className={cn(
                        'absolute inset-y-0 left-0 rounded-full',
                        running
                          ? cn(
                              'transition-[width] duration-200 ease-linear',
                              phase === 'waiting' ? 'compaction-estimate' : stalled ? 'bg-warn' : 'compaction-squeeze',
                            )
                          : item.status === 'completed'
                            ? 'bg-accent'
                            : 'bg-fg-faint/50',
                      )}
                      style={width === null ? undefined : { width: `${width * 100}%` }}
                    />
                  )}
                </span>
              )}
              {shownPost !== null && <span className="font-semibold text-fg">{formatTokens(shownPost)}</span>}
            </span>
          )}
          {saved !== null && progress === 1 && (
            <span className="compaction-saved shrink-0 rounded-full bg-success/12 px-1.5 text-label font-medium text-success tabular-nums">
              −{saved}%
            </span>
          )}
          {time && (
            <>
              <span className="h-3 w-px shrink-0 bg-line" />
              <span className="shrink-0 text-fg-faint tabular-nums">{time}</span>
              {phase === 'waiting' && sim.slow && (
                <span className="shrink-0 text-fg-faint">{tr('session.compaction.slow')}</span>
              )}
            </>
          )}
        </button>
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          anchor={anchor}
          offset={6}
          bare
          role="dialog"
          aria-label={tr('session.compaction.details')}
          className="w-80 p-3 select-text"
        >
          <CompactionDetails item={item} progress={p} live={live} now={now} />
        </Popover>
        <span className="h-px min-w-6 flex-1 bg-linear-to-l from-transparent to-line" />
      </div>
      {steps && <StepTrack steps={steps} />}
      {hint && (
        <div className={cn('max-w-[78%] text-center text-label', trouble ? 'text-warn' : 'text-fg-faint')}>{hint}</div>
      )}
      {failed && item.error && (
        <span className="max-w-[70%] truncate text-label text-fg-faint" title={item.error}>
          {translateMessage(item.error)}
        </span>
      )}
    </div>
  )
}
