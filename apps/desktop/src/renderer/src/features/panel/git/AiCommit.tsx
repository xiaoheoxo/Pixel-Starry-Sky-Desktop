// AI 写提交信息（docs/ui/ai-commit-codex-warnings-history.md §2、docs/ui/ai-commit-channels.md §3）：提交信息输入框右上角的
// 按钮和换通道的小箭头（菜单里选的只用这一次）、生成后的那一行（AI 写的 · 通道 · 费用 · 撤销）和出错时的说法。
// 只在点按钮时发请求；写好直接填进输入框，不自动提交
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Sparkles, Square } from 'lucide-react'
import type { AiChannelRequest, AiCommitRequest, AiProblem, AiSource } from '../../../../../shared/types/ai'
import type { GitCommitScope } from '../../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { cn, Popover, Spinner } from '@/ui'
import { getLocale, tr, translateMessage } from '@/i18n/core'
import { useAccount } from '@/features/account'
import { getPlatformState, refreshPlatform } from '@/features/account/platform'
import { ENGINES } from '@pixelsky/protocol'
import { channelStateText } from '@/features/model-channels/channelLabels'
import { openAuthDialog } from '@/features/model-channels/authDialogStore'
import { useSettings } from '@/features/settings/SettingsProvider'
import {
  COMMIT_CHANNEL,
  commitCodexModel,
  commitGroups,
  commitProvider,
  effectiveSource,
  estimateUsd,
  fallbackSource,
  useAiCommitSettings,
  type AiCommitModel,
} from '@/features/settings/aiCommit'
import { CommitChannelIcon } from '@/features/settings/models/AiCommitSettings'
import { useCommitChannels } from '@/features/settings/models/useCommitChannels'
import { formatCost } from '@/features/usage/format'

type Note =
  | {
      kind: 'done'
      /** 填进去之前输入框里的字（撤销用） */
      previous: string
      written: string
      source: AiSource
      /** 两条授权通道显示的模型名 */
      model: string
      cost: number | null
      charged: boolean
      partial: number
    }
  | {
      kind: 'error'
      problem: AiProblem
      detail: string
      model: string
      source: AiSource
      scope: GitCommitScope
      /** 订阅额度用完、没装、没授权时「这次改用 X」 */
      instead: AiSource | null
    }

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 换一条通道能解决的问题 */
const SWITCHABLE: readonly AiProblem[] = ['usageLimit', 'notInstalled', 'notAuthorized']

/** 按选的通道拼请求的通道部分（AI 写提交信息、优化提示词共用）；还没法发时给出原因 */
export async function channelRequest(
  using: AiSource,
  model: AiCommitModel,
  channels: ReturnType<typeof useCommitChannels>,
): Promise<
  | { request: Omit<AiChannelRequest, 'requestId'>; multiplier: number; priceRef: string | null }
  | { problem: AiProblem; detail: string }
> {
  if (using === 'platform') {
    let platform = getPlatformState('claude')
    if (!platform.email) return { problem: 'signedOut', detail: '' }
    if (!platform.loaded) {
      await refreshPlatform()
      platform = getPlatformState('claude')
    }
    const groups = commitGroups(platform.groups, model.model, model.groupId, platform.groupId)
    if (!groups.length) return { problem: 'model', detail: '' }
    const multiplier = platform.groups.find(g => g.id === groups[0])?.rate_multiplier ?? 1
    return { request: { source: 'platform', groups, providerId: null, model: model.model }, multiplier, priceRef: null }
  }
  if (using === 'claude' || using === 'codex' || using === 'antigravity') {
    // 模型留空：跟随引擎自己的设置（Antigravity 总是跟随）
    const engineModel =
      using === 'claude'
        ? model.claudeModel
        : using === 'codex'
          ? commitCodexModel(model.codexModel, channels.codexModels)
          : null
    return {
      request: { source: using, groups: [], providerId: null, model: engineModel ?? '' },
      multiplier: 1,
      priceRef: null,
    }
  }
  const chosen = commitProvider(channels.providers, model)
  if (!chosen) return { problem: 'provider', detail: 'missing' }
  if (!chosen.provider.keyHint) return { problem: 'provider', detail: 'noKey' }
  return {
    request: { source: 'custom', groups: [], providerId: chosen.provider.id, model: chosen.model },
    multiplier: chosen.provider.costMultiplier ?? 1,
    priceRef: chosen.provider.models.find(m => m.id === chosen.model)?.priceRef ?? null,
  }
}

/** 输入框留给右上角按钮的位置 */
export const AI_COMMIT_PAD = 'pr-12'

export function useAiCommit({
  target,
  demo,
  message,
  setMessage,
}: {
  target: WorkspaceRef
  demo: boolean
  message: string
  setMessage: (message: string) => void
}) {
  const { writing, model } = useAiCommitSettings()
  const channels = useCommitChannels()
  const source = effectiveSource(model, channels.ctx)
  const [running, setRunning] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const live = useRef(true)
  const current = useRef(message)
  current.current = message
  useEffect(
    () => () => {
      live.current = false
    },
    [],
  )
  // 改了 AI 写的字：「撤销」和费用那一行就不再显示
  useEffect(() => {
    if (note?.kind === 'done' && message !== note.written) setNote(null)
  }, [message, note])

  const start = async (scope: GitCommitScope, override?: AiSource): Promise<void> => {
    if (running) return
    const using = override ?? source
    const requestId = crypto.randomUUID()
    const fail = (problem: AiProblem, detail = '', name = model.model) =>
      setNote({
        kind: 'error',
        problem,
        detail,
        model: name,
        source: using,
        scope,
        instead: SWITCHABLE.includes(problem) ? fallbackSource(using, channels.ctx) : null,
      })
    setNote(null)
    setRunning(requestId)
    try {
      if (demo) {
        await wait(600)
        if (!live.current) return
        const written = tr('aiCommit.demoMessage')
        setNote({
          kind: 'done',
          previous: current.current,
          written,
          source: using,
          model: channels.modelLabel(using, model),
          cost: null,
          charged: false,
          partial: 0,
        })
        setMessage(written)
        return
      }
      const api = window.pixelsky?.ai
      if (!api) return
      const base = {
        requestId,
        ref: target,
        scope,
        language: writing.language,
        uiLanguage: getLocale() === 'en-US' ? 'en' : 'zh',
        style: writing.style,
        instructions: writing.instructions,
      } satisfies Partial<AiCommitRequest>
      const channel = await channelRequest(using, model, channels)
      if ('problem' in channel) return fail(channel.problem, channel.detail)
      const request: AiCommitRequest = { ...base, ...channel.request }
      let multiplier = channel.multiplier
      const priceRef = channel.priceRef
      const result = await api.commitMessage(request)
      if (!live.current) return
      if (!result.ok) {
        if (result.problem !== 'cancelled') fail(result.problem, result.detail, request.model)
        return
      }
      if (result.groupId)
        multiplier = getPlatformState('claude').groups.find(g => g.id === result.groupId)?.rate_multiplier ?? multiplier
      const written = result.message
      const subscription = using === 'claude' || using === 'codex' || using === 'antigravity'
      setNote({
        kind: 'done',
        previous: current.current,
        written,
        source: using,
        // 跟随引擎设置（没指定模型）时显示引擎报的实际模型，别写成「跟随 Codex 的设置」
        model:
          subscription && request.model
            ? channels.modelLabel(using, model)
            : result.model || channels.modelLabel(using, model),
        // 授权通道（Claude / ChatGPT / Google 账号）用订阅额度，不估算费用
        cost: subscription ? null : estimateUsd(result.usage, result.model, multiplier, priceRef),
        charged: false,
        partial: result.partial,
      })
      setMessage(written)
      if (result.chargeable)
        void api
          .commitCharge(requestId)
          .then(usd => {
            if (usd === null || !live.current) return
            setNote(n => (n?.kind === 'done' && n.written === written ? { ...n, cost: usd, charged: true } : n))
          })
          .catch(() => undefined)
    } catch (e) {
      if (live.current) fail('failed', (e as Error)?.message ?? '')
    } finally {
      if (live.current) setRunning(id => (id === requestId ? null : id))
    }
  }

  return {
    enabled: writing.enabled,
    running: running !== null,
    note,
    /** 默认用的通道 */
    source,
    channels,
    model,
    /** override：菜单里选的通道，只用这一次 */
    start: (scope: GitCommitScope, override?: AiSource) => void start(scope, override),
    stop: () => {
      if (running && !demo) void window.pixelsky?.ai.cancel(running)
    },
    undo: () => {
      if (note?.kind === 'done') setMessage(note.previous)
      setNote(null)
    },
    dismiss: () => setNote(null),
  }
}

export type AiCommit = ReturnType<typeof useAiCommit>

/** 输入框右上角：星光按钮（生成中是转圈，悬停变成停止）和换通道的小箭头 */
export function AiCommitButton({ ai, disabled, scope }: { ai: AiCommit; disabled: boolean; scope: GitCommitScope }) {
  const [menu, setMenu] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const via = `${ai.channels.name(ai.source)} · ${ai.channels.modelLabel(ai.source, ai.model)}`
  const label = ai.running ? tr('aiCommit.stopHint') : tr('aiCommit.buttonVia', { via })
  return (
    <div ref={anchor} className="absolute top-1 right-1 flex items-center">
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={!ai.running && disabled}
        onClick={() => (ai.running ? ai.stop() : ai.start(scope))}
        className={cn(
          'group/ai press inline-flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-accent-fg disabled:pointer-events-none disabled:opacity-40',
          ai.running && 'text-accent-fg',
        )}
      >
        {ai.running ? (
          <>
            <Spinner size={13} className="group-hover/ai:hidden" />
            <Square size={11} strokeWidth={2} className="hidden fill-current group-hover/ai:block" />
          </>
        ) : (
          <Sparkles size={14} strokeWidth={1.5} />
        )}
      </button>
      <button
        type="button"
        aria-label={tr('aiCommit.menu.open')}
        title={tr('aiCommit.menu.open')}
        aria-haspopup="menu"
        aria-expanded={menu}
        disabled={ai.running || disabled}
        onClick={() => setMenu(v => !v)}
        className="press inline-flex h-6 w-4 items-center justify-center rounded-md text-fg-faint hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronDown size={12} strokeWidth={1.75} />
      </button>
      <Popover
        open={menu}
        onClose={() => setMenu(false)}
        anchor={anchor}
        side="bottom"
        align="end"
        role="menu"
        aria-label={tr('aiCommit.menu.title')}
        className="w-72 p-1"
      >
        <AiCommitMenu
          ai={ai}
          onPick={s => {
            setMenu(false)
            ai.start(scope, s)
          }}
        />
      </Popover>
    </div>
  )
}

/** 换通道的菜单：能用的可以点（只用这一次），没设置好的灰掉写原因；最下面说改默认去设置 */
function AiCommitMenu({ ai, onPick }: { ai: AiCommit; onPick: (source: AiSource) => void }) {
  const settings = useSettings()
  const { ready, unset } = ai.channels.channels
  const item = (source: AiSource, off: string | null) => (
    <button
      key={source}
      type="button"
      role="menuitem"
      data-menu-item
      disabled={!!off}
      onClick={() => onPick(source)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <span className="flex w-3.5 shrink-0 justify-center text-accent-fg">
        {source === ai.source && <Check size={13} strokeWidth={2} />}
      </span>
      <span className="flex size-5 shrink-0 items-center justify-center">
        <CommitChannelIcon source={source} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-fg">
          {off ? ai.channels.name(source) : `${ai.channels.name(source)} · ${ai.channels.modelLabel(source, ai.model)}`}
        </span>
        <span className={cn('block truncate text-meta', off ? 'text-warn' : 'text-fg-muted')}>
          {off ?? ai.channels.costLabel(source)}
        </span>
      </span>
      {source === ai.source && (
        <span className="shrink-0 rounded-full border border-line px-1.5 text-meta text-fg-muted">
          {tr('aiCommit.menu.default')}
        </span>
      )}
    </button>
  )
  return (
    <>
      <div className="px-2 pt-1 pb-1.5 text-meta text-fg-faint">{tr('aiCommit.menu.title')}</div>
      {ready.map(c => item(c.source, null))}
      {unset.map(c => item(c.source, channelStateText(COMMIT_CHANNEL[c.source], c.state) ?? ''))}
      <div role="separator" className="my-1 border-t border-line-subtle" />
      <button
        type="button"
        data-menu-item
        onClick={() => settings.openSettings('assist')}
        className="w-full rounded-md px-2 py-1.5 text-left text-meta text-fg-muted hover:bg-hover"
      >
        {tr('aiCommit.menu.hint')}
      </button>
    </>
  )
}

const PROBLEM_TEXT: Record<
  Exclude<AiProblem, 'cancelled' | 'model' | 'provider' | 'notInstalled' | 'notAuthorized'>,
  Parameters<typeof tr>[0]
> = {
  signedOut: 'aiCommit.problem.signedOut',
  balance: 'aiCommit.problem.balance',
  route: 'aiCommit.problem.route',
  rateLimit: 'aiCommit.problem.rateLimit',
  network: 'aiCommit.problem.network',
  timeout: 'aiCommit.problem.timeout',
  empty: 'aiCommit.problem.empty',
  nothing: 'aiCommit.problem.nothing',
  failed: 'aiCommit.problem.failed',
  usageLimit: 'aiCommit.problem.usageLimit',
  tooLong: 'aiCommit.problem.tooLong',
}

const engineName = (s: AiSource): string => ENGINES[s === 'codex' || s === 'antigravity' ? s : 'claude'].name

export function problemText(
  n: Pick<Extract<Note, { kind: 'error' }>, 'problem' | 'detail' | 'model' | 'source'>,
  channelName: string,
): string {
  if (n.problem === 'provider')
    return n.detail === 'missing'
      ? tr('aiCommit.problem.noEndpoint')
      : n.detail === 'noKey'
        ? tr('aiCommit.problem.noKey')
        : translateMessage(n.detail)
  // 自定义接口说没有这个模型时，原话更准确
  if (n.problem === 'model')
    return n.detail ? translateMessage(n.detail) : tr('aiCommit.problem.noModel', { model: n.model })
  if (n.problem === 'cancelled') return ''
  if (n.problem === 'notInstalled') return tr('aiCommit.problem.notInstalled', { engine: engineName(n.source) })
  if (n.problem === 'notAuthorized') return tr('aiCommit.problem.notAuthorized', { channel: channelName })
  const text = tr(PROBLEM_TEXT[n.problem])
  // 订阅额度用完：原话里有恢复时间
  return n.detail && (n.problem === 'failed' || n.problem === 'network' || n.problem === 'usageLimit')
    ? tr('aiCommit.problemDetail', { text, detail: translateMessage(n.detail) })
    : text
}

/** 输入框下面那一行：写好了（AI 写的 · 通道 · 费用 · 撤销），或者出错的说法和按钮 */
export function AiCommitNote({ ai }: { ai: AiCommit }) {
  const account = useAccount()
  const settings = useSettings()
  const note = ai.note
  if (ai.running) return <p className="mt-1 truncate px-0.5 text-meta text-fg-muted">{tr('aiCommit.writing')}</p>
  if (!note) return null
  if (note.kind === 'done') {
    const subscription = note.source === 'claude' || note.source === 'codex' || note.source === 'antigravity'
    return (
      <p className="mt-1 flex min-w-0 items-center gap-1 px-0.5 text-meta text-fg-muted">
        <Sparkles size={12} strokeWidth={1.5} className="shrink-0 text-accent-fg" />
        <span className="min-w-0 truncate">
          {tr('aiCommit.writtenBy')}
          {subscription &&
            ` · ${ai.channels.name(note.source)} · ${note.model} · ${tr('aiCommit.channel.subscription')}`}
          {note.cost !== null &&
            ' · ' +
              tr(note.charged ? 'aiCommit.charged' : 'aiCommit.cost', {
                cost: formatCost(note.cost, note.charged ? 'platform' : 'estimate'),
              })}
          {note.partial > 0 && ' · ' + tr('aiCommit.partialFiles', { n: note.partial })}
        </span>
        <button
          type="button"
          title={tr('aiCommit.undoHint')}
          onClick={ai.undo}
          className="ml-auto shrink-0 rounded px-1 text-accent-fg hover:bg-hover"
        >
          {tr('aiCommit.undo')}
        </button>
      </p>
    )
  }
  const action = (label: string, run: () => void) => (
    <button
      key={label}
      type="button"
      onClick={() => {
        ai.dismiss()
        run()
      }}
      className="shrink-0 rounded px-1 text-accent-fg hover:bg-hover"
    >
      {label}
    </button>
  )
  const models = () => settings.openSettings('assist')
  const channel = COMMIT_CHANNEL[note.source]
  return (
    <p role="alert" className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 px-0.5 text-meta text-danger">
      <span className="min-w-0 break-words">{problemText(note, ai.channels.name(note.source))}</span>
      {note.problem === 'signedOut' && action(tr('aiCommit.signIn'), () => void account.login())}
      {note.problem === 'balance' && action(tr('aiCommit.openSettings'), () => settings.openSettings('account'))}
      {note.problem === 'notInstalled' && action(tr('aiCommit.install'), () => settings.openSettings('engines'))}
      {note.problem === 'notAuthorized' &&
        (channel === 'claude' || channel === 'chatgpt') &&
        action(tr('aiCommit.authorize'), () => openAuthDialog(channel))}
      {note.instead &&
        action(tr('aiCommit.useInstead', { channel: ai.channels.name(note.instead) }), () =>
          ai.start(note.scope, note.instead ?? undefined),
        )}
      {(note.problem === 'signedOut' ||
        note.problem === 'route' ||
        note.problem === 'model' ||
        note.problem === 'provider') &&
        // 接口没有、没 Key、Key 无效：在模型通道的自定义 API 里修；线路、模型的下拉在 AI 辅助
        action(
          tr('aiCommit.openSettings'),
          note.problem === 'provider' ? () => settings.openSettings('models') : models,
        )}
    </p>
  )
}
