import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { MessageSquare, Plus } from 'lucide-react'
import { useState } from 'react'
import { Button, useComingSoon } from '@/ui'
import type { AgentMember } from '@/data/types'
import { channelsLive } from './store'
import { ChannelDialog } from './ChannelDialogs'
import { AgentsDialog } from '@/features/settings/AgentsSection'

/** 没有频道时的整页空状态（docs/ui/channels.md §8） */
export function ChannelsEmpty({ agents }: { agents: readonly AgentMember[] }) {
  useI18n()
  const comingSoon = useComingSoon()
  const [creating, setCreating] = useState(false)
  const [managing, setManaging] = useState(false)
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-subtle">
        <MessageSquare size={20} strokeWidth={1.5} className="text-fg-muted" />
      </span>
      <h2 className="mt-4 text-section font-semibold text-fg">{tr('channels.empty.title')}</h2>
      <p className="mt-2 max-w-[480px] text-list text-balance text-fg-muted">{tr('channels.empty.body')}</p>
      <p className="mt-1 max-w-[480px] text-meta text-balance text-fg-faint">{tr('channels.empty.later')}</p>
      <Button
        variant="primary"
        icon={Plus}
        className="mt-5"
        onClick={() => (channelsLive ? setCreating(true) : comingSoon(tr('channels.new')))}
      >
        {tr('channels.new')}
      </Button>
      {/* 频道删光了，AI 成员可能还在：这里也能管理（没有频道时不显示频道列表） */}
      {channelsLive && agents.length > 0 && (
        <Button variant="ghost" className="mt-2" data-manage-agents onClick={() => setManaging(true)}>
          {tr('settingsAgents.manage')}
        </Button>
      )}
      {managing && <AgentsDialog onClose={() => setManaging(false)} />}
      {creating && <ChannelDialog channel={null} agents={agents} onClose={() => setCreating(false)} />}
    </div>
  )
}
