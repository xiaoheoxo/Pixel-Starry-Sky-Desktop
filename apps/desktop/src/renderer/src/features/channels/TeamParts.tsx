// 团队界面的小零件：角色名、带在线点的头像（docs/ui/channels-phase-c.md §3）
import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '../../i18n/core'
import { Avatar, cn, type SelectOption } from '@/ui'
import type { TeamRole } from '../../../../shared/types/channels'
import type { Presence } from './teamModel'

const ROLE_KEY: Record<TeamRole, TranslationKey> = {
  owner: 'team.role.owner',
  member: 'team.role.member',
  observer: 'team.role.observer',
}

export const roleLabel = (role: TeamRole): string => tr(ROLE_KEY[role])

/** 邀请 / 改角色时可选的角色（所有者只有一个，不能选） */
export function roleOptions(): SelectOption<Exclude<TeamRole, 'owner'>>[] {
  return [
    { value: 'member', label: roleLabel('member') },
    { value: 'observer', label: roleLabel('observer') },
  ]
}

/** 在线是主色小圆点；不在线不画点（也可以用 offlineDot 画灰点） */
export function PresenceDot({ online, className }: { online: boolean; className?: string }) {
  useI18n()
  return (
    <span
      aria-hidden
      className={cn('size-2 shrink-0 rounded-full', online ? 'bg-accent' : 'border border-line-strong', className)}
    />
  )
}

/** 圆形首字头像，右下角叠在线点 */
export function PresenceAvatar({
  name,
  online,
  state,
  size = 24,
  className,
}: {
  name: string
  online?: boolean
  /** 四种在线状态（docs/multica-learn.md §2）：给了就按它画，忙是橙点、刚失联是空心橙点 */
  state?: Presence['kind']
  size?: number
  className?: string
}) {
  useI18n()
  const kind = state ?? (online === undefined ? null : online ? 'online' : 'offline')
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <Avatar name={name} size={size} />
      {kind && (
        <span
          aria-hidden
          data-presence={kind}
          className={cn(
            'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface',
            kind === 'online'
              ? 'bg-accent'
              : kind === 'busy'
                ? 'bg-warn'
                : kind === 'lost'
                  ? 'border-2 border-warn bg-surface'
                  : 'bg-fg-faint',
          )}
        />
      )}
    </span>
  )
}
