// 设置 › 模型与额度 › AI 写提交信息（docs/ui/ai-commit-codex-warnings-history.md §2.3、docs/ui/ai-commit-channels.md §2）：
// 显示按钮、用哪条通道（四条通道列表，选中的展开模型 / 线路 / 接口；没设置好的放在「还没设置」下面）、语言、写法、额外要求
import { useEffect, useState, type ReactNode } from 'react'
import { Plug } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Button, cn, EngineIcon, Segmented, Select, Spinner } from '@/ui'
import { useUnmountFlush } from '@/ui/useUnmountFlush'
import { useAccount } from '@/features/account'
import { formatMultiplier, groupsForModel, platformModels, refreshPlatform } from '@/features/account/platform'
import { channelFix, channelFixLabel, channelStateText } from '@/features/model-channels/channelLabels'
import type { ChannelState } from '@/features/model-channels/channelModel'
import { openAuthDialog } from '@/features/model-channels/authDialogStore'
import { useSettings } from '../SettingsProvider'
import {
  AI_COMMIT_CLAUDE_MODEL,
  AI_COMMIT_DEFAULT_MODEL,
  CODEX_SMALL,
  COMMIT_CHANNEL,
  commitCodexModel,
  commitProvider,
  effectiveSource,
  INSTRUCTIONS_LIMIT,
  setAiCommitModel,
  setAiCommitWriting,
  useAiCommitSettings,
  type AiCommitModel,
} from '../aiCommit'
import { SettingRow, Toggle } from '../SettingRow'
import { useCommitChannels } from './useCommitChannels'
import type { AiCommitLanguage, AiCommitStyle, AiSource } from '../../../../../shared/types/ai'

const AUTO = 'auto'
/** 选择框里的「跟随引擎的设置」（模型存成 null） */
const FOLLOW = 'follow'

/** 通道的图标：像素星空用像素星空的标志，两条授权通道用引擎图标，自定义接口用插头 */
export function CommitChannelIcon({ source, size = 14 }: { source: AiSource; size?: number }) {
  if (source === 'custom') return <Plug size={size} strokeWidth={1.5} className="text-fg-muted" />
  return <EngineIcon engine={source === 'platform' ? 'pixel' : source} size={size} className="opacity-80" />
}

export function AiCommitSettings() {
  useI18n()
  const { writing, model } = useAiCommitSettings()
  const channels = useCommitChannels()
  const selected = effectiveSource(model, channels.ctx)
  // 额外要求：边打边存会频繁写 localStorage，离开输入框再存
  const [instructions, setInstructions] = useState(writing.instructions)
  useEffect(() => setInstructions(writing.instructions), [writing.instructions])
  const saveInstructions = (): void => {
    unsaved.current = false
    if (instructions !== writing.instructions) setAiCommitWriting({ instructions })
  }
  const unsaved = useUnmountFlush(saveInstructions)
  const row = (c: { source: AiSource; state: ChannelState }) => (
    <ChannelRow
      key={c.source}
      source={c.source}
      state={c.state}
      model={model}
      selected={selected === c.source}
      auto={model.source === null}
      channels={channels}
    />
  )

  return (
    <div>
      <SettingRow
        title={tr('aiCommit.settings.enabled')}
        description={tr('aiCommit.settings.enabledHint')}
        control={
          <Toggle
            label={tr('aiCommit.settings.enabled')}
            checked={writing.enabled}
            onChange={enabled => setAiCommitWriting({ enabled })}
          />
        }
      />
      <SettingRow
        title={tr('promptOptimize.settings.enabled')}
        description={tr('promptOptimize.settings.enabledHint')}
        control={
          <Toggle
            label={tr('promptOptimize.settings.enabled')}
            checked={writing.promptButton}
            onChange={promptButton => setAiCommitWriting({ promptButton })}
          />
        }
      />
      <SettingRow title={tr('aiCommit.settings.source')} description={tr('aiCommit.settings.sourceHint')}>
        <div
          role="radiogroup"
          aria-label={tr('aiCommit.settings.source')}
          className="max-w-xl overflow-hidden rounded-lg border border-line"
        >
          {channels.channels.ready.map(row)}
          {channels.channels.unset.length > 0 && (
            <div className="border-t border-line-subtle bg-subtle px-3 py-1.5 text-meta text-fg-faint first:border-t-0">
              {tr('aiCommit.settings.unset', { n: channels.channels.unset.length })}
            </div>
          )}
          {channels.channels.unset.map(row)}
        </div>
      </SettingRow>
      <SettingRow title={tr('aiCommit.settings.language')} description="">
        <Segmented<AiCommitLanguage>
          label={tr('aiCommit.settings.language')}
          value={writing.language}
          onChange={language => setAiCommitWriting({ language })}
          options={[
            { value: 'auto', label: tr('aiCommit.settings.languageAuto') },
            { value: 'zh', label: tr('aiCommit.settings.chinese') },
            { value: 'en', label: tr('aiCommit.settings.english') },
          ]}
        />
      </SettingRow>
      <SettingRow title={tr('aiCommit.settings.style')} description="">
        <Segmented<AiCommitStyle>
          label={tr('aiCommit.settings.style')}
          value={writing.style}
          onChange={style => setAiCommitWriting({ style })}
          options={[
            { value: 'body', label: tr('aiCommit.settings.styleBody') },
            { value: 'subject', label: tr('aiCommit.settings.styleSubject') },
          ]}
        />
      </SettingRow>
      <SettingRow title={tr('aiCommit.settings.instructions')} description="">
        <textarea
          value={instructions}
          maxLength={INSTRUCTIONS_LIMIT}
          rows={2}
          aria-label={tr('aiCommit.settings.instructions')}
          placeholder={tr('aiCommit.settings.instructionsPlaceholder')}
          onChange={e => {
            setInstructions(e.target.value)
            unsaved.current = true
          }}
          onBlur={saveInstructions}
          className="block max-h-40 min-h-14 w-full max-w-xl resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-list text-fg outline-none placeholder:text-fg-faint focus-visible:border-accent"
        />
      </SettingRow>
    </div>
  )
}

type Channels = ReturnType<typeof useCommitChannels>

/** 通道列表的一行：单选圈、图标、名字和状态、右边的费用或修复按钮；选中的展开模型 */
function ChannelRow({
  source,
  state,
  model,
  selected,
  auto,
  channels,
}: {
  source: AiSource
  state: ChannelState
  model: AiCommitModel
  selected: boolean
  auto: boolean
  channels: Channels
}) {
  const account = useAccount()
  const settings = useSettings()
  const channel = COMMIT_CHANNEL[source]
  const off = state.kind !== 'ready' && state.kind !== 'loading'
  const fix = off ? channelFix(state) : null
  const runFix = (): void => {
    if (fix === 'signin') void account.login()
    else if (fix === 'retry') void refreshPlatform()
    else if (fix === 'auth' && (channel === 'claude' || channel === 'chatgpt')) openAuthDialog(channel)
    else settings.openSettings('engines')
  }
  const sub = off ? channelStateText(channel, state) : channels.modelLabel(source, model)
  return (
    <div className={cn('border-t border-line-subtle first:border-t-0', selected && !off && 'bg-selected')}>
      <div className="flex min-h-12 items-center gap-2.5 px-3 py-2">
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          disabled={off}
          onClick={() => setAiCommitModel({ source })}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default"
        >
          <span
            className={cn(
              'flex size-3.5 shrink-0 items-center justify-center rounded-full border',
              selected ? 'border-accent' : 'border-line-strong',
              off && 'opacity-50',
            )}
          >
            {selected && <span className="size-1.5 rounded-full bg-accent" />}
          </span>
          <span className={cn('flex size-5 shrink-0 items-center justify-center', off && 'opacity-50')}>
            <CommitChannelIcon source={source} />
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn('flex items-center gap-1.5 text-ui font-medium', off ? 'text-fg-muted' : 'text-fg')}>
              <span className="truncate">{channels.name(source)}</span>
              {source === 'claude' && !off && <Chip tone="accent">{tr('aiCommit.settings.recommended')}</Chip>}
              {selected && auto && !off && <Chip>{tr('aiCommit.settings.auto')}</Chip>}
              {state.kind === 'loading' && <Spinner size={11} />}
            </span>
            {sub && (
              <span
                className={cn(
                  'block truncate text-meta',
                  off ? 'text-warn' : 'text-fg-muted',
                  (source === 'platform' || source === 'custom') && !off && 'font-mono',
                )}
              >
                {sub}
              </span>
            )}
          </span>
        </button>
        {/* 添加接口就在上面的「自定义接口」里，不另给按钮 */}
        {fix && fix !== 'add-endpoint' ? (
          <Button className="h-7 px-2.5 text-meta" onClick={runFix}>
            {channelFixLabel(fix)}
          </Button>
        ) : !off ? (
          <Chip>{channels.costLabel(source)}</Chip>
        ) : null}
      </div>
      {selected && !off && <ChannelDetail source={source} model={model} channels={channels} />}
    </div>
  )
}

function Chip({ children, tone }: { children: ReactNode; tone?: 'accent' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full border px-1.5 text-meta font-normal whitespace-nowrap',
        tone === 'accent' ? 'border-accent text-accent-fg' : 'border-line text-fg-muted',
      )}
    >
      {children}
    </span>
  )
}

/** 选中的通道展开的部分：模型 / 线路 / 接口，下面一行说怎么算钱 */
function ChannelDetail({ source, model, channels }: { source: AiSource; model: AiCommitModel; channels: Channels }) {
  const wrap = (children: ReactNode, facts?: string) => (
    <div className="px-3 pb-3 pl-[3.25rem]">
      <div className="flex flex-wrap gap-2">{children}</div>
      {facts && <p className="mt-1.5 text-meta text-fg-faint">{facts}</p>}
    </div>
  )
  if (source === 'platform') {
    const platform = channels.platform
    // 模型列表里没有默认的 Opus 5.5（没登录、线路还没读到）时也列出来，不让选择框空着
    const modelOptions = [...new Set([model.model, ...platformModels(platform.groups)])]
    const routes = groupsForModel(platform.groups, model.model)
    return wrap(
      <>
        <Select
          label={tr('aiCommit.settings.model')}
          mono
          className="min-w-44 flex-1"
          value={model.model}
          onChange={v => setAiCommitModel({ model: v, groupId: null })}
          options={modelOptions.map(m => ({
            value: m,
            label: m === AI_COMMIT_DEFAULT_MODEL ? `${m} · Opus 5.5` : m,
          }))}
        />
        <Select
          label={tr('aiCommit.settings.route')}
          className="min-w-44 flex-1"
          disabled={!platform.email}
          value={model.groupId ?? AUTO}
          placeholder={tr('aiCommit.settings.signInFirst')}
          onChange={v => setAiCommitModel({ groupId: v === AUTO ? null : v })}
          options={[
            { value: AUTO, label: tr('aiCommit.settings.routeAuto') },
            ...routes.map(g => ({ value: g.id, label: `${g.name} · ${formatMultiplier(g.rate_multiplier)}` })),
          ]}
        />
      </>,
      tr('aiCommit.settings.platformFacts'),
    )
  }
  if (source === 'claude')
    return wrap(
      <Select
        label={tr('aiCommit.settings.model')}
        className="min-w-44 flex-1"
        value={model.claudeModel ?? FOLLOW}
        onChange={v => setAiCommitModel({ claudeModel: v === FOLLOW ? null : v })}
        options={[
          { value: AI_COMMIT_CLAUDE_MODEL, label: tr('aiCommit.settings.haiku') },
          { value: 'sonnet', label: 'Sonnet' },
          { value: 'opus', label: 'Opus' },
          // 选过、但不在上面的别名（旧版本存的完整模型名）也列出来，不让选择框空着
          ...(model.claudeModel && !['haiku', 'sonnet', 'opus'].includes(model.claudeModel)
            ? [{ value: model.claudeModel, label: model.claudeModel }]
            : []),
          { value: FOLLOW, label: tr('aiCommit.settings.followClaude') },
        ]}
      />,
      tr('aiCommit.settings.subscriptionFacts', { engine: 'Claude Code' }),
    )
  if (source === 'codex') {
    const small = commitCodexModel(CODEX_SMALL, channels.codexModels)
    const listed = channels.codexModels ?? []
    const stored = model.codexModel
    return wrap(
      <Select
        label={tr('aiCommit.settings.model')}
        className="min-w-44 flex-1"
        value={stored ?? FOLLOW}
        onChange={v => setAiCommitModel({ codexModel: v === FOLLOW ? null : v })}
        options={[
          {
            value: CODEX_SMALL,
            label: small
              ? tr('aiCommit.settings.codexSmall', { model: small })
              : tr('aiCommit.settings.codexSmallNone'),
          },
          ...listed.map(m => ({ value: m.id, label: m.label })),
          // 选过、但目录里已经没有的模型也列出来，不让选择框空着
          ...(stored && stored !== CODEX_SMALL && !listed.some(m => m.id === stored)
            ? [{ value: stored, label: stored }]
            : []),
          { value: FOLLOW, label: tr('aiCommit.settings.followCodex') },
        ]}
      />,
      tr('aiCommit.settings.subscriptionFacts', { engine: 'Codex' }),
    )
  }
  const chosen = commitProvider(channels.providers, model)
  if (!chosen) return null
  return wrap(
    <>
      <Select
        label={tr('aiCommit.settings.endpoint')}
        className="min-w-44 flex-1"
        value={chosen.provider.id}
        onChange={id => setAiCommitModel({ providerId: id, providerModel: null })}
        options={channels.providers.map(p => ({ value: p.id, label: p.name }))}
      />
      <Select
        label={tr('aiCommit.settings.model')}
        mono
        className="min-w-44 flex-1"
        value={chosen.model}
        onChange={m => setAiCommitModel({ providerId: chosen.provider.id, providerModel: m })}
        options={chosen.provider.models.map(m => ({ value: m.id, label: m.id }))}
      />
    </>,
  )
}
