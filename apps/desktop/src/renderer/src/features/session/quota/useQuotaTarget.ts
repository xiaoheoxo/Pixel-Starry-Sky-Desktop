import { useMemo } from 'react'
import type { QuotaProvider } from '@pixelsky/protocol'
import { useAccount } from '@/features/account/useAccount'
import { machineOf, useMachines } from '@/features/machines/store'
import { AUTH_ENGINE, isAuthChannel, type ChannelId } from '@/features/model-channels/channelModel'
import { useChannelEngines } from '@/features/model-channels/loginStore'
import { useQuotaDisplay } from '@/features/settings/quotaDisplay'
import { platformQuota } from './platformQuota'
import { quotaTarget } from './quotaModel'

/**
 * 这个通道（和对话）该不该有额度按钮 / 菜单简写，以及额度属于哪个账号。按钮和模型通道菜单里的简写共用，出现条件一致。
 * sessionId 为 null（还没开始的对话、模型通道菜单）按输入框当前选的机器。
 */
export function useQuotaTarget(
  channel: ChannelId | null,
  sessionId: string | null,
): { provider: QuotaProvider | null; accountKey: string | null } {
  const display = useQuotaDisplay()
  const machines = useMachines()
  const engines = useChannelEngines()
  const account = useAccount()
  const platformWindows = useMemo(() => platformQuota(account.account)?.windows.length ?? 0, [account.account])
  // 没开对话前按输入框当前选的机器，已开始的对话按对话所在的机器（§5.2）
  const machine = sessionId ? machineOf(sessionId) : machines.currentId
  // 引擎列表是当前选中机器的：对话在别的机器上（本机对话、选中了远程机器）时，列表不是它那台的，
  // 不能拿来判断 Claude / Codex 是否可用、登录方式和账号；平台账号不看引擎列表，照旧
  const enginesOfMachine = machine === machines.currentId ? engines : []
  const provider = quotaTarget({
    enabled: display.enabled,
    machine,
    channel,
    engines: enginesOfMachine,
    platformSignedIn: account.status === 'signed-in',
    platformWindows,
  })
  const accountKey =
    channel && isAuthChannel(channel)
      ? (enginesOfMachine.find(e => e.id === AUTH_ENGINE[channel])?.account?.email ?? null)
      : null
  return { provider, accountKey }
}
