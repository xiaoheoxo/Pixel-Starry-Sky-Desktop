// 设置 › AI 辅助（docs/ui/ai-commit-channels.md §2、docs/ui/settings-reorg.md §3）：
// 共用的通道（一个下拉，下面是模型 / 线路 / 接口；通道的状态和修复在「模型通道」）、提交信息的按钮 / 语言 / 写法 / 额外要求、优化提示词的按钮
import { useEffect, useState, type ReactNode } from 'react'
import { Plug } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Button, EngineIcon, Segmented, Select } from '@/ui'
import { useUnmountFlush } from '@/ui/useUnmountFlush'
import { formatMultiplier, groupsForModel, platformModels } from '@/features/account/platform'
import { channelStateText } from '@/features/model-channels/channelLabels'
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
import { GroupTitle, SettingRow, Toggle } from '../SettingRow'
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
  const { ready, unset } = channels.channels
  const settings = useSettings()

  return (
    <div>
      <GroupTitle>{tr('settingsAssist.channel')}</GroupTitle>
      <SettingRow
        title={tr('aiCommit.settings.source')}
        description={`${tr('settingsAssist.channelHint')}${tr('aiCommit.settings.sourceHint')}`}
      >
        {ready.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-meta text-warn">{tr('settingsAssist.noChannel')}</p>
            <Button className="h-7 px-2.5 text-meta" onClick={() => settings.openSettings('models')}>
              {tr('settingsAssist.openChannels')}
            </Button>
          </div>
        ) : (
          <div className="max-w-xl rounded-lg border border-line">
            <div className="p-3">
              <Select<AiSource>
                label={tr('aiCommit.settings.source')}
                className="w-full"
                // 没选过时不当成选中：显示「X · 自动选的」，点任何一项（包括同一项）都会存下来
                value={model.source ?? ('' as AiSource)}
                placeholder={`${channels.name(selected)} · ${tr('aiCommit.settings.auto')}`}
                onChange={source => setAiCommitModel({ source })}
                options={[
                  ...ready.map(c => ({
                    value: c.source,
                    label: channels.name(c.source),
                    hint: channels.costLabel(c.source),
                  })),
                  // 没设置好的也列出来，说明为什么不能选；去「模型通道」里设置
                  ...unset.map(c => ({
                    value: c.source,
                    label: channels.name(c.source),
                    description: channelStateText(COMMIT_CHANNEL[c.source], c.state) ?? undefined,
                    disabled: true,
                  })),
                ]}
              />
            </div>
            {ready.some(c => c.source === selected) && (
              <ChannelDetail source={selected} model={model} channels={channels} />
            )}
          </div>
        )}
      </SettingRow>

      <GroupTitle>{tr('settingsAssist.commit')}</GroupTitle>
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

      <GroupTitle>{tr('settingsAssist.prompt')}</GroupTitle>
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
    </div>
  )
}

type Channels = ReturnType<typeof useCommitChannels>

/** 选中的通道展开的部分：模型 / 线路 / 接口，下面一行说怎么算钱 */
function ChannelDetail({ source, model, channels }: { source: AiSource; model: AiCommitModel; channels: Channels }) {
  const wrap = (children: ReactNode, facts?: string) => (
    <div className="px-3 pb-3">
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
  // Google 账号（Antigravity）：模型总是跟随它自己的设置，没有可选的
  if (source === 'antigravity')
    return wrap(
      <span className="text-meta text-fg-secondary">{tr('aiCommit.settings.followAgy')}</span>,
      tr('aiCommit.settings.subscriptionFacts', { engine: 'Antigravity' }),
    )
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
