// 设置 › 模型与额度 › AI 写提交信息（docs/ui/ai-commit-codex-warnings-history.md §2.3）：显示按钮、用哪里的模型、
// 云端的模型和线路（自动时默认线路优先）、自定义 API 的接口和模型、语言、写法、额外要求
import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Segmented, Select } from '@/ui'
import { useUnmountFlush } from '@/ui/useUnmountFlush'
import { formatMultiplier, groupsForModel, platformModels, usePlatform } from '@/features/account/platform'
import { useProviders } from '@/features/account/providers'
import {
  AI_COMMIT_DEFAULT_MODEL,
  commitProvider,
  INSTRUCTIONS_LIMIT,
  setAiCommitModel,
  setAiCommitWriting,
  useAiCommitSettings,
} from '../aiCommit'
import { SettingRow, Toggle } from '../SettingRow'
import type { AiCommitLanguage, AiCommitStyle, AiSource } from '../../../../../shared/types/ai'

const AUTO = 'auto'

export function AiCommitSettings() {
  useI18n()
  const { writing, model } = useAiCommitSettings()
  const platform = usePlatform('claude')
  const providers = useProviders().providers.filter(p => p.models.length)
  const chosen = commitProvider(providers, model)
  const models = platformModels(platform.groups)
  // 模型列表里没有默认的 Opus 5.5（没登录、线路还没读到）时也列出来，不让选择框空着
  const modelOptions = [...new Set([model.model, ...models])]
  const routes = groupsForModel(platform.groups, model.model)
  // 额外要求：边打边存会频繁写 localStorage，离开输入框再存
  const [instructions, setInstructions] = useState(writing.instructions)
  useEffect(() => setInstructions(writing.instructions), [writing.instructions])
  const saveInstructions = (): void => {
    unsaved.current = false
    if (instructions !== writing.instructions) setAiCommitWriting({ instructions })
  }
  const unsaved = useUnmountFlush(saveInstructions)

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
      <SettingRow title={tr('aiCommit.settings.source')} description={tr('aiCommit.settings.sourceHint')}>
        <Segmented<AiSource>
          label={tr('aiCommit.settings.source')}
          value={model.source}
          onChange={source => setAiCommitModel({ source })}
          options={[
            { value: 'platform', label: tr('aiCommit.settings.platform') },
            { value: 'custom', label: tr('aiCommit.settings.custom') },
          ]}
        />
        {model.source === 'platform' ? (
          <div className="mt-3 flex max-w-xl flex-wrap gap-2">
            <Select
              label={tr('aiCommit.settings.model')}
              mono
              className="min-w-52 flex-1"
              value={model.model}
              onChange={v => setAiCommitModel({ model: v, groupId: null })}
              options={modelOptions.map(m => ({
                value: m,
                label: m === AI_COMMIT_DEFAULT_MODEL ? `${m} · Opus 5.5` : m,
              }))}
            />
            <Select
              label={tr('aiCommit.settings.route')}
              className="min-w-52 flex-1"
              disabled={!platform.email}
              value={model.groupId ?? AUTO}
              placeholder={tr('aiCommit.settings.signInFirst')}
              onChange={v => setAiCommitModel({ groupId: v === AUTO ? null : v })}
              options={[
                { value: AUTO, label: tr('aiCommit.settings.routeAuto') },
                ...routes.map(g => ({ value: g.id, label: `${g.name} · ${formatMultiplier(g.rate_multiplier)}` })),
              ]}
            />
          </div>
        ) : chosen ? (
          <div className="mt-3 flex max-w-xl flex-wrap gap-2">
            <Select
              label={tr('aiCommit.settings.endpoint')}
              className="min-w-52 flex-1"
              value={chosen.provider.id}
              onChange={id => setAiCommitModel({ providerId: id, providerModel: null })}
              options={providers.map(p => ({ value: p.id, label: p.name }))}
            />
            <Select
              label={tr('aiCommit.settings.model')}
              mono
              className="min-w-52 flex-1"
              value={chosen.model}
              onChange={m => setAiCommitModel({ providerId: chosen.provider.id, providerModel: m })}
              options={chosen.provider.models.map(m => ({ value: m.id, label: m.id }))}
            />
          </div>
        ) : (
          <p className="mt-3 text-meta text-fg-faint">{tr('aiCommit.settings.noEndpoint')}</p>
        )}
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
