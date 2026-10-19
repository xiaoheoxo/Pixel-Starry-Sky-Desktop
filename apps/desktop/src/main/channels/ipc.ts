// 协作频道 Phase B（docs/ui/channels-phase-b.md §10–§11）：把 core/channels 的 Channels 接到 IPC。
// 引擎调用走 ctx.engineCall（和窗口同一层路由，含 SSH 机器）；会话事件和机器变化从 EventBus.taps 收。
import { join } from 'node:path'
import { hostname, userInfo } from 'node:os'
import { app } from 'electron'
import { describeError, logger } from '@pixelsky/engine'
import type { HostEvent } from '@pixelsky/protocol'
import * as ipc from '../ipc/guard'
import type { AppContext } from '../app/context'
import { windowLocale } from '../app/ui-language'
import { machineOf } from '../machines/identity'
import { baseUrl, bridgeToken, onAccountChange, signedInEmail, teamsFetch } from '../account/account'
import { TeamApi } from '../core/channels/team/api'
import { loadDeviceId } from '../core/channels/team/device'
import { TeamRealtime } from '../core/channels/team/realtime'
import { TeamSync } from '../core/channels/team/sync'
import { ChannelStore } from '../core/channels/store'
import { Channels, type MachineLite } from '../core/channels/service'
import type {
  AgentInput,
  AgentPolicy,
  ChannelInput,
  ChannelTaskAction,
  PostInput,
  TeamRole,
} from '../../shared/types/channels'

const str = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`${what}不正确`)
  return value
}
const ACTIONS = new Set<ChannelTaskAction>(['cancel', 'stop', 'retry'])
const INVITE_ROLES = new Set<Exclude<TeamRole, 'owner'>>(['member', 'observer'])
const POLICIES = new Set<AgentPolicy>(['approve', 'team'])
const role = (value: unknown): Exclude<TeamRole, 'owner'> => {
  if (!INVITE_ROLES.has(value as Exclude<TeamRole, 'owner'>)) throw new Error('角色不正确')
  return value as Exclude<TeamRole, 'owner'>
}

/** 团队实时通道的地址：登录服务的同一个地址（https → wss） */
/**
 * 团队功能（协作频道 Phase C）2026-10-18 起默认关闭，频道只做本机多 AI 协作（docs/ui/channels-local-ai.md §1）。
 * 代码、测试和云端接口都留着，开发时设 PIXELSKY_TEAMS=1 打开
 */
export function teamsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PIXELSKY_TEAMS === '1'
}

export function teamsWsUrl(base: string): string {
  return base.replace(/^http/, 'ws').replace(/\/+$/, '') + '/v1/teams/ws'
}

function selfName(): string {
  try {
    return userInfo().username || 'Me'
  } catch {
    return 'Me'
  }
}

export async function initChannels(ctx: AppContext): Promise<void> {
  const log = logger('channels')
  const dir = join(app.getPath('userData'), 'channels')
  const store = new ChannelStore(dir)
  await store.init()
  const deviceId = await loadDeviceId(dir)
  // 团队同步（Phase C）：登录后启动，退出登录清空。团队功能默认关着（teamsEnabled），关着时不创建、不连云端
  const team = teamsEnabled()
    ? new TeamSync({
        api: new TeamApi(teamsFetch),
        realtime: handlers =>
          new TeamRealtime({ url: teamsWsUrl(baseUrl()), token: force => bridgeToken(force), ...handlers }),
        log: (message, error) => log.warn(message, error ? { error: describeError(error) } : undefined),
      })
    : null
  const machines = (): MachineLite[] =>
    ctx.machines
      ? ctx.machines.state().machines.map(m => ({
          id: m.id,
          name: m.name,
          connected: m.status === 'local' || m.status === 'connected',
        }))
      : [{ id: 'local', name: '', connected: true }]
  const channels = new Channels({
    store,
    call: (channel, args) => {
      if (!ctx.engineCall) return Promise.reject(new Error('项目尚未加载'))
      return ctx.engineCall(channel, args, 'channels')
    },
    emit: (channel, value) => ctx.events.broadcast(channel, value),
    machines,
    projects: () => ctx.machines?.projects() ?? ctx.engine?.projects() ?? [],
    sessions: () => ctx.machines?.sessions() ?? ctx.engine?.sessions() ?? [],
    machineOf,
    selfName,
    locale: () => windowLocale(),
    log: (message, error) => log.warn(message, error ? { error: describeError(error) } : undefined),
    team: team ?? undefined,
    deviceId,
    machineName: () => hostname() || '这台电脑',
  })
  ctx.events.taps.add((channel, args) => {
    try {
      if (channel === 'engine:event') channels.hostEvent(args[0] as HostEvent)
      else if (channel === 'machines:changed') channels.machinesChanged()
    } catch (error) {
      log.warn('频道处理事件失败', { error: describeError(error) })
    }
  })
  ctx.lifecycle.onShutdown(() => {
    team?.stop()
    return channels.dispose()
  })

  // 登录了就连团队，退出登录（或换账号）就断开并清空；窗口回到前台补一次
  if (team) {
    let teamEmail: string | null = null
    const applyAccount = (): void => {
      const email = signedInEmail()
      if (email === teamEmail) return
      teamEmail = email
      team.stop()
      if (email) team.start()
    }
    onAccountChange(applyAccount)
    applyAccount()
  }
  app.on('browser-window-focus', () => channels.focus())

  ipc.handle('channels:state', () => channels.state())
  ipc.handle('channels:messages', (_e, id, before, beforeId) =>
    channels.page(
      str(id, '频道'),
      typeof before === 'number' ? before : null,
      typeof beforeId === 'string' ? beforeId : null,
    ),
  )
  ipc.handle('channels:create', (_e, input) => channels.create(input as ChannelInput))
  ipc.handle('channels:update', (_e, id, patch) =>
    channels.update(str(id, '频道'), (patch ?? {}) as Parameters<Channels['update']>[1]),
  )
  ipc.handle('channels:delete', (_e, id) => channels.delete(str(id, '频道')))
  ipc.handle('channels:post', (_e, id, input) => channels.post(str(id, '频道'), input as PostInput))
  ipc.handle('channels:attachments', (_e, id, messageId) =>
    channels.attachments(str(id, '频道'), str(messageId, '消息')),
  )
  ipc.handle('channels:markRead', (_e, id) => channels.markRead(str(id, '频道')))
  ipc.handle('channels:pin', (_e, id, messageId, pinned) =>
    channels.pin(str(id, '频道'), str(messageId, '消息'), pinned === true),
  )
  ipc.handle('channels:search', (_e, text, opts) => {
    const o = (opts ?? {}) as { limit?: unknown; projectId?: unknown }
    return channels.search(typeof text === 'string' ? text : '', {
      limit: typeof o.limit === 'number' ? o.limit : undefined,
      projectId: typeof o.projectId === 'string' && o.projectId ? o.projectId : null,
    })
  })
  ipc.handle('channels:saveMember', (_e, channelId, input) =>
    channels.saveMember(typeof channelId === 'string' && channelId ? channelId : null, input as AgentInput),
  )
  ipc.handle('channels:addMember', (_e, channelId, memberId) =>
    channels.addMember(str(channelId, '频道'), str(memberId, '成员')),
  )
  ipc.handle('channels:removeMember', (_e, channelId, memberId) =>
    channels.removeMember(str(channelId, '频道'), str(memberId, '成员')),
  )
  ipc.handle('channels:deleteMember', (_e, memberId) => channels.deleteMember(str(memberId, '成员')))
  ipc.handle('channels:task', (_e, taskId, action) => {
    if (!ACTIONS.has(action as ChannelTaskAction)) throw new Error('不支持的操作')
    return channels.taskAction(str(taskId, '任务'), action as ChannelTaskAction)
  })

  ipc.handle('channels:approveTask', (_e, taskId, approve) =>
    channels.approveTask(str(taskId, '任务'), approve === true),
  )
  ipc.handle('channels:agentPolicy', (_e, channelId, memberId, policy) => {
    if (!POLICIES.has(policy as AgentPolicy)) throw new Error('不支持的派活规则')
    return channels.setAgentPolicy(str(channelId, '频道'), str(memberId, '成员'), policy as AgentPolicy)
  })
  ipc.handle('teams:create', (_e, name) => channels.createTeam(typeof name === 'string' ? name : ''))
  ipc.handle('teams:update', (_e, teamId, patch) =>
    channels.updateTeam(str(teamId, '团队'), (patch ?? {}) as { name: string }),
  )
  ipc.handle('teams:delete', (_e, teamId) => channels.deleteTeam(str(teamId, '团队')))
  ipc.handle('teams:rename', (_e, teamId, name) =>
    channels.renameSelf(str(teamId, '团队'), typeof name === 'string' ? name : ''),
  )
  ipc.handle('teams:invite', (_e, teamId, email, r) =>
    channels.invite(str(teamId, '团队'), typeof email === 'string' ? email : '', role(r)),
  )
  ipc.handle('teams:revokeInvite', (_e, teamId, inviteId) =>
    channels.revokeInvite(str(teamId, '团队'), str(inviteId, '邀请')),
  )
  ipc.handle('teams:respond', (_e, inviteId, accept) => channels.respondInvite(str(inviteId, '邀请'), accept === true))
  ipc.handle('teams:setRole', (_e, teamId, userId, r) =>
    channels.setRole(str(teamId, '团队'), str(userId, '成员'), role(r)),
  )
  ipc.handle('teams:removeMember', (_e, teamId, userId) =>
    channels.removeTeamMember(str(teamId, '团队'), str(userId, '成员')),
  )
  ipc.handle('teams:refresh', () => channels.refreshTeams())

  // 启动时对账：上次退出时还没做完的活
  void channels.reconcile().catch(error => log.warn('频道任务对账失败', { error: describeError(error) }))
}
