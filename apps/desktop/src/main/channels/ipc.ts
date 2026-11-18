// 协作频道 Phase B（docs/ui/channels-phase-b.md §10–§11）：把 core/channels 的 Channels 接到 IPC。
// 引擎调用走 ctx.engineCall（和窗口同一层路由，含 SSH 机器）；会话事件和机器变化从 EventBus.taps 收。
import { join } from 'node:path'
import { hostname, userInfo } from 'node:os'
import { app, shell } from 'electron'
import { dataRoot } from '../app/data-dir'
import { exec, git } from '../core/project-tools/common'
import { describeError, logger } from '@pixelsky/engine'
import type { HostEvent } from '@pixelsky/protocol'
import * as ipc from '../ipc/guard'
import type { AppContext } from '../app/context'
import { windowLocale } from '../app/ui-language'
import { machineOf } from '../machines/identity'
import { bridgeToken, wsTargets, onAccountChange, signedInEmail, teamsFetch } from '../account/account'
import { TeamApi } from '../core/channels/team/api'
import { loadDeviceId } from '../core/channels/team/device'
import { TeamRealtime, teamsWsUrl, type SocketLike } from '../core/channels/team/realtime'
import { openWs } from '../account/ws-open'
import { TeamSync } from '../core/channels/team/sync'
import { ChannelStore } from '../core/channels/store'
import { Channels, type MachineLite } from '../core/channels/service'
import { channelToolsServer } from './channel-mcp'
import { initRunners } from './runner'
import { fitImage } from '../image/fit'
import { cancelCloudImage, startCloudImage } from '../image/job'
import { cloudImageArgs } from '../core/image/cloud-image'
import { randomUUID } from 'node:crypto'
import type { CheckRun } from '../../shared/types/checks'
import type { GitCompareResult, GitResult, GitStatus, ProjectCopy } from '../../shared/types/project-tools'
import type { ChannelAlertAction } from '../../shared/channels/alerts'
import type {
  AgentInput,
  AgentPolicy,
  ChannelInput,
  JoinSessionInput,
  ChannelTaskAction,
  ChannelQueueAction,
  NeedMark,
  PostInput,
  TeamInboxPatch,
  TeamRole,
} from '../../shared/types/channels'

const str = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`${what}不正确`)
  return value
}
const ACTIONS = new Set<ChannelTaskAction>([
  'cancel',
  'stop',
  'retry',
  'continue',
  'unlimit',
  'fix',
  'reassign',
  'merge',
  'pr',
  'resolve',
  'copyNow',
])
const QUEUE_ACTIONS = new Set<ChannelQueueAction>(['up', 'down', 'first'])
const ALERT_ACTIONS = new Set<ChannelAlertAction>(['hold', 'continue', 'open', 'stop', 'reassign', 'cancel', 'dismiss'])
const INVITE_ROLES = new Set<Exclude<TeamRole, 'owner'>>(['member', 'observer'])
const POLICIES = new Set<AgentPolicy>(['owner', 'approve', 'listed', 'team'])
/** 「指定的人直接派」最多指定几个人（和云端 MaxAllow 一致） */
const ALLOW_MAX = 50
const role = (value: unknown): Exclude<TeamRole, 'owner'> => {
  if (!INVITE_ROLES.has(value as Exclude<TeamRole, 'owner'>)) throw new Error('角色不正确')
  return value as Exclude<TeamRole, 'owner'>
}

/**
 * 团队功能（协作频道 Phase C）：2026-10-18 关过一阵（docs/ui/channels-local-ai.md §1），2026-11-17 重新打开（docs/multica-learn.md §13）。
 * 设 PIXELSKY_TEAMS=0 关掉（排查问题用）；云端没开团队接口时（TEAMS_ENABLED 关着，团队接口 404）同步当作「云端没部署」，报不可用、界面藏起团队入口
 */
export function teamsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PIXELSKY_TEAMS !== '0'
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
  const dir = join(dataRoot(), 'channels')
  const store = new ChannelStore(dir)
  await store.init()
  const deviceId = await loadDeviceId(dir)
  // 团队同步（Phase C）：登录后启动，退出登录清空。PIXELSKY_TEAMS=0 时不创建、不连云端（teamsEnabled）
  const team = teamsEnabled()
    ? new TeamSync({
        api: new TeamApi(teamsFetch),
        realtime: handlers =>
          new TeamRealtime({
            // CDN → 直连 → IP 依次试，恢复了切回去（docs/network-direct.md §10）
            targets: () => wsTargets(teamsWsUrl),
            socket: (url, protocols, target) => openWs({ ...target, url }, protocols) as unknown as SocketLike,
            log: (message, fields) => log.info(message, fields),
            token: force => bridgeToken(force),
            ...handlers,
          }),
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
  // 本机项目工具的操作（流程里的副本、主目录状态；流程只有本机成员）
  const tool =
    (name: string) =>
    async (args: unknown[]): Promise<unknown> => {
      const op = ctx.toolOps.get(name)
      if (!op) throw new Error('项目工具还没有就绪')
      return op(args)
    }
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
    channelTools: true,
    fitImage,
    defaultMode: engine => ctx.engine?.engineDefaults(engine).permissionMode,
    // 产出检查走项目工具的操作表，和窗口一样按会话路由到所在的机器（docs/ui/channels-collab-v2.md §8）
    runChecks: async (sessionId, files) => {
      const op = ctx.toolOps.get('projectTools:runChecks')
      if (!op) return null
      const args = [{ sessionId }, { files, when: 'channel' }]
      const result = ctx.machines ? ctx.machines.invoke('projectTools:runChecks', args, () => op(args)) : op(args)
      return (await result) as CheckRun | null
    },
    // 事项派出去的卡片变了：写回事项，按事项 id 路由到项目所在的机器（docs/ui/channels-collab-v2.md §9）
    syncIssue: async (issueId, input) => {
      const op = ctx.toolOps.get('projectTools:syncIssue')
      if (!op) return
      const args = [issueId, input]
      await (ctx.machines ? ctx.machines.invoke('projectTools:syncIssue', args, () => op(args)) : op(args))
    },
    // 流程里并行的步骤用 Git 副本（docs/ui/channels-pipeline.md §6.4）：流程只有本机成员，直接走本机的操作表
    // 成员、频道用量：一次读完本机 30 天的记录（engine:usageList 每页 500 条、每页都重读文件）
    usageRecords: async now =>
      ctx.engine?.usageList({ range: '30d', filter: {}, now, offset: 0, limit: Number.MAX_SAFE_INTEGER }).records ?? [],
    copies: {
      create: async (projectId, input) => {
        const copy = (await tool('projectTools:createCopy')([
          projectId,
          { existingBranch: false, ...input },
        ])) as ProjectCopy
        return { id: copy.id, branch: copy.branch, path: copy.path }
      },
      remove: async copyId => {
        await tool('projectTools:removeCopy')([copyId, false])
      },
      dirty: async (projectId, untracked) => {
        const s = (await tool('projectTools:gitStatus')([{ projectId }])) as GitStatus
        return (
          s.repo && s.staged.length + s.unstaged.length + s.conflicted.length + (untracked ? s.untracked.length : 0) > 0
        )
      },
      changed: async (projectId, branch) => {
        const r = (await tool('projectTools:gitCompare')([
          { projectId },
          { from: 'HEAD', to: branch },
        ])) as GitCompareResult
        return r.files.map(f => f.path)
      },
      commit: async (sessionId, message) => {
        const r = (await tool('projectTools:gitCommit')([{ sessionId }, { message, all: true }])) as GitResult
        // 没东西可提交（它自己提交过了）不算错
        if (!r.ok && r.failure.kind !== 'nothing') throw new Error(r.failure.detail || r.failure.kind)
      },
      // 单张任务卡合并 / 开 PR（docs/ui/channels-local-rest.md §3.1）：只有本机成员
      head: async projectId => {
        const s = (await tool('projectTools:gitStatus')([{ projectId }])) as GitStatus
        return s.repo ? { branch: s.branch, head: s.head } : null
      },
      squashMerge: (projectId, branch, message) => {
        if (!ctx.projectTools) throw new Error('项目工具还没有就绪')
        return ctx.projectTools.git.squashMerge({ projectId }, { branch, message })
      },
      deleteBranch: async (projectId, name) => {
        const r = (await tool('projectTools:gitHistoryAction')([
          { projectId },
          { kind: 'deleteBranch', name, force: true },
        ])) as GitResult
        if (!r.ok) throw new Error(r.failure.detail || r.failure.kind)
      },
      openPr: async (sessionId, input) => {
        const pushed = (await tool('projectTools:gitPush')([{ sessionId }, { publish: true }])) as GitResult
        if (!pushed.ok) throw new Error(`推送分支失败：${pushed.failure.detail || pushed.failure.kind}`)
        const remote = (await git(input.path, ['remote', 'get-url', 'origin'])).trim()
        const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1]
        if (!repo) throw new Error('origin 不是 GitHub 仓库，开不了 PR；分支已推送，请到代码托管网站上手动建')
        const args = [
          'pr',
          'create',
          '--head',
          input.branch,
          '--title',
          input.title,
          '--body',
          input.body || input.title,
        ]
        try {
          const { stdout } = await exec('gh', input.base ? [...args, '--base', input.base] : args, {
            cwd: input.path,
            windowsHide: true,
            timeout: 60_000,
          })
          const url = String(stdout).trim().split(/\r?\n/).pop() ?? ''
          return { url, number: Number(/\/pull\/(\d+)/.exec(url)?.[1]) || null }
        } catch (error) {
          // 没装 gh：打开比较页让你自己点；分支名里的 / 不能编码，GitHub 认不出
          const seg = (b: string) => b.split('/').map(encodeURIComponent).join('/')
          if ((error as { code?: unknown }).code !== 'ENOENT') throw error
          const url = `https://github.com/${repo}/compare/${seg(input.base ?? 'main')}...${seg(input.branch)}?expand=1`
          await shell.openExternal(url)
          return { url }
        }
      },
    },
  })
  // 频道工具（pixelsky_channel）：频道派活的本机会话发消息前由扩展准备挂上（docs/ui/channels-collab-v2.md §1）
  ctx.dispatchIssue = (channelId, issue) => channels.dispatchIssue(channelId, issue)
  ctx.channels = channels
  initRunners(ctx, {
    channels,
    team,
    deviceId,
    dir,
    selfName,
    locale: () => (windowLocale() === 'en-US' ? 'en-US' : 'zh-CN'),
    log: (message, error) => log.warn(message, error ? { error: describeError(error) } : undefined),
  })
  const tools = channelToolsServer(() => channels)
  ctx.channelTools = tools
  app.on('will-quit', () => tools.close())
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
  // 频道里云端生图（docs/ui/channel-image-gen.md §3.1）：生成和会话里共用 job.ts，生成完作为你发的带图消息进频道
  ipc.handle('channels:generateImage', (_e, input: unknown): { id: string } => {
    const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const channelId = str(v.channelId, '频道')
    const req = cloudImageArgs(input, 'channel')
    const account = signedInEmail()
    if (!account) throw new Error('请先登录像素星空账号')
    const estimate =
      typeof v.estimate === 'number' && Number.isFinite(v.estimate) && v.estimate >= 0 ? v.estimate : null
    const id = `chimg-${randomUUID()}`
    channels.imageStarted({
      id,
      channelId,
      threadId: typeof v.threadId === 'string' ? v.threadId : null,
      prompt: req.prompt,
      size: req.size,
      n: req.n,
    })
    void startCloudImage(id, account, req, () => {})
      .then(async ({ images, cost }) => {
        const generated = { group: req.groupName, size: req.size, n: req.n, quality: req.quality, estimate }
        const message = await channels.postGenerated(id, { images, generated })
        if (!message) return
        const usd = await cost()
        if (usd !== null) channels.generatedCost(message.channelId, message.id, usd)
      })
      // 停止时那一行已经关掉，imageFailed 不会再画出来
      .catch(error => channels.imageFailed(id, (error as Error).message || '生成失败'))
    return { id }
  })
  ipc.handle('channels:cancelImage', (_e, id: unknown) => {
    const key = str(id, '生成')
    channels.imageDismissed(key)
    cancelCloudImage(key)
  })
  ipc.handle('channels:dismissImage', (_e, id: unknown) => channels.imageDismissed(str(id, '生成')))
  ipc.handle('channels:markRead', (_e, id) => channels.markRead(str(id, '频道')))
  ipc.handle('channels:pin', (_e, id, messageId, pinned) =>
    channels.pin(str(id, '频道'), str(messageId, '消息'), pinned === true),
  )
  ipc.handle('channels:proposal', (_e, id, messageId, accept) =>
    channels.proposal(str(id, '频道'), str(messageId, '消息'), accept === true),
  )
  ipc.handle('channels:alert', (_e, id, messageId, action) => {
    if (typeof action !== 'string' || !ALERT_ACTIONS.has(action as ChannelAlertAction)) throw new Error('不支持的操作')
    return channels.alertAction(str(id, '频道'), str(messageId, '消息'), action as ChannelAlertAction)
  })
  // 参数的形状由 Channels.flowAction 逐项校验
  ipc.handle('channels:flow', (_e, id, action: unknown) => channels.flowAction(str(id, '频道'), action))
  ipc.handle('channels:markNeeds', (_e, raw: unknown, done) => {
    if (!Array.isArray(raw) || raw.length > 1000) throw new Error('参数不正确')
    const marks: NeedMark[] = (raw as unknown[]).map(item => {
      const i = (item ?? {}) as Partial<NeedMark>
      return {
        channelId: str(i.channelId, '频道'),
        key: str(i.key, '提醒'),
        sig: typeof i.sig === 'string' ? i.sig : '',
      }
    })
    return channels.markNeeds(marks, done === true)
  })
  ipc.handle('channels:dispatchIssue', (_e, id, issue) => channels.dispatchIssue(str(id, '频道'), issue))
  // 事项唤醒（docs/multica-learn.md §11.6）：参数由 Channels.wakeup 逐项校验（团队频道转给云端）
  ipc.handle('channels:wakeup', (_e, id, op: unknown) => channels.wakeup(str(id, '频道'), op))
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
  // 把已有会话加入频道 / 退出频道（docs/ui/import-collab.md 第 5 项②）
  ipc.handle('channels:joinSession', (_e, input) => channels.joinSession((input ?? {}) as JoinSessionInput))
  ipc.handle('channels:leaveSession', (_e, sessionId, channelId) =>
    channels.leaveSession(str(sessionId, '会话'), str(channelId, '频道')),
  )
  ipc.handle('channels:task', (_e, taskId, action, memberId) => {
    if (!ACTIONS.has(action as ChannelTaskAction)) throw new Error('不支持的操作')
    return channels.taskAction(
      str(taskId, '任务'),
      action as ChannelTaskAction,
      action === 'reassign' ? str(memberId, '成员') : undefined,
    )
  })

  ipc.handle('channels:queueControl', (_e, taskId, action) => {
    if (!QUEUE_ACTIONS.has(action as ChannelQueueAction)) throw new Error('不支持的操作')
    return channels.queueControl(str(taskId, '任务'), action as ChannelQueueAction)
  })

  ipc.handle('channels:approveTask', (_e, taskId, approve) =>
    channels.approveTask(str(taskId, '任务'), approve === true),
  )
  // 队友派来的活的限制：主进程按 cleanTeammate 整理，不认识的字段丢掉
  ipc.handle('channels:teammate', (_e, rules) => channels.setTeammate(rules))
  // 收件箱改一行（docs/multica-learn.md §11.5）：只认这四个字段
  ipc.handle('channels:inbox', (_e, teamId, key, raw) => {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const flag = (v: unknown): boolean | undefined => {
      if (v === undefined) return undefined
      if (typeof v !== 'boolean') throw new Error('参数不对')
      return v
    }
    const snooze = p.snoozeUntil
    if (snooze !== undefined && snooze !== null && (typeof snooze !== 'number' || !Number.isFinite(snooze)))
      throw new Error('参数不对')
    const patch: TeamInboxPatch = {}
    const read = flag(p.read),
      archived = flag(p.archived),
      muted = flag(p.muted)
    if (read !== undefined) patch.read = read
    if (archived !== undefined) patch.archived = archived
    if (muted !== undefined) patch.muted = muted
    if (snooze !== undefined) patch.snoozeUntil = snooze as number | null
    return channels.patchInbox(str(teamId, '团队'), str(key, '通知'), patch)
  })
  ipc.handle('channels:agentPolicy', (_e, channelId, memberId, policy, raw) => {
    if (!POLICIES.has(policy as AgentPolicy)) throw new Error('不支持的派活规则')
    const allow: unknown = raw
    if (
      allow !== undefined &&
      (!Array.isArray(allow) || allow.length > ALLOW_MAX || allow.some(x => typeof x !== 'string' || !x))
    )
      throw new Error('指定的人不对')
    return channels.setAgentPolicy(
      str(channelId, '频道'),
      str(memberId, '成员'),
      policy as AgentPolicy,
      allow as string[] | undefined,
    )
  })
  ipc.handle('teams:create', (_e, name) => channels.createTeam(typeof name === 'string' ? name : ''))
  ipc.handle('teams:update', (_e, teamId, patch) =>
    channels.updateTeam(str(teamId, '团队'), (patch ?? {}) as { name?: string; queueGraceHours?: number }),
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
