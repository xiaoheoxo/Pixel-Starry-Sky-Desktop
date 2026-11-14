// AI 写提交信息的四条通道（docs/ui/ai-commit-channels.md）：设置页和提交栏共用的状态、名字、模型、费用说法
import type { AiSource } from '../../../../../shared/types/ai'
import type { ProviderView } from '../../../../../shared/types/providers'
import { tr } from '@/i18n/core'
import { usePlatform } from '@/features/account/platform'
import { useProviders } from '@/features/account/providers'
import { useEngineCatalog } from '@/features/engine/catalog'
import { selfModelLabel } from '@/features/engine/labels'
import { useMachines } from '@/features/machines/store'
import { channelShort } from '@/features/model-channels/channelLabels'
import { useChannelEngines } from '@/features/model-channels/loginStore'
import {
  COMMIT_CHANNEL,
  commitChannels,
  commitCodexModel,
  commitProvider,
  type AiCommitModel,
  type CommitChannelContext,
} from '../aiCommit'

export function useCommitChannels() {
  const platform = usePlatform('claude')
  const providers: ProviderView[] = useProviders().providers.filter(p => p.models.length)
  const engines = useChannelEngines()
  const remote = useMachines().currentId !== 'local'
  // Claude 授权只用别名（haiku / sonnet / opus），不读它的模型目录（读一次要启动 Claude Code）
  const codexModels = useEngineCatalog('codex')?.models
  const ctx: CommitChannelContext = { platform, engines, providers, remote }

  /** 通道的短名：像素星空 / Claude 授权 / ChatGPT 授权 / 自定义接口 */
  const name = (source: AiSource): string => channelShort(COMMIT_CHANNEL[source])

  /** 这条通道现在会用的模型（显示用）；自定义接口带上接口名 */
  const modelLabel = (source: AiSource, m: AiCommitModel): string => {
    switch (source) {
      case 'platform':
        return m.model
      case 'claude':
        return m.claudeModel === null ? tr('aiCommit.settings.followClaude') : selfModelLabel('claude', m.claudeModel)
      case 'codex': {
        const model = commitCodexModel(m.codexModel, codexModels)
        return model === null ? tr('aiCommit.settings.followCodex') : selfModelLabel('codex', model, codexModels)
      }
      case 'antigravity':
        return tr('aiCommit.settings.followAgy')
      case 'custom': {
        const chosen = commitProvider(providers, m)
        return chosen ? `${chosen.provider.name} · ${chosen.model}` : ''
      }
    }
  }

  /** 这条通道怎么算钱 */
  const costLabel = (source: AiSource): string =>
    tr(
      source === 'platform'
        ? 'aiCommit.channel.balance'
        : source === 'custom'
          ? 'aiCommit.channel.byEndpoint'
          : 'aiCommit.channel.subscription',
    )

  return {
    ctx,
    platform,
    providers,
    codexModels,
    channels: commitChannels(ctx),
    name,
    modelLabel,
    costLabel,
  }
}
