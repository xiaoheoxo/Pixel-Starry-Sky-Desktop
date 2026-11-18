// 执行机常驻进程（docs/multica-learn.md §9、§11.7）：`helper.cjs runner run`，由 systemd 用户单元拉起。
// 引擎宿主用 createRemoteRuntime 原样起（假的 peer：平台额度一律不支持），频道服务和团队同步用 core/channels 那一套，
// 只接绑在这台执行机上的成员的团队活。不导入 electron。
import { existsSync, mkdirSync, readFileSync, renameSync, watchFile, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { HostEvent, ProjectRecord, SessionSummary } from '@pixelsky/protocol'
import { createRemoteRuntime } from '../machines/remote-runtime'
import type { TunnelPeer } from '../machines/tunnel'
import { ChannelStore } from '../core/channels/store'
import { Channels } from '../core/channels/service'
import { TeamApi, type TeamFetch } from '../core/channels/team/api'
import { TeamRealtime, teamsWsUrl } from '../core/channels/team/realtime'
import { TeamSync } from '../core/channels/team/sync'
import type { RunnerConfig, RunnerStatus } from '../../shared/types/runner'
import { readAccount, type RunnerAccount } from './account'
import { runnerAgent } from './config'
import { bundleVersion, nextScript, readConfig } from './files'

const STATUS_EVERY_MS = 15_000
/** 一台执行机同时最多跑几件活（§11.7：写死 4） */
export const RUNNER_MAX_RUNNING = 4

/** 执行机的请求：只调团队接口，带执行机令牌；运行凭证那条照桌面 teamsFetch 的规则 */
export function runnerFetch(account: RunnerAccount): TeamFetch {
  return async (method, path, body, timeoutMs = 20_000, runToken) => {
    if (!/^\/v1\/teams(\/|\?|$)/.test(path) || /\.\.|%2e/i.test(path)) throw new Error('无效的团队接口')
    let token = account.token
    if (runToken !== undefined) {
      if (!/^\/v1\/teams\/[^/?]+\/runs\//.test(path) || !runToken.startsWith('rt_')) throw new Error('无效的团队接口')
      token = runToken
    }
    return fetch(account.base + path, {
      method,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  renameSync(tmp, file)
}

/** 跑起来；返回关掉的函数。没登录时写状态后直接返回 null（systemd 过一会儿再拉起） */
export async function runDaemon(dir: string, script: string): Promise<(() => Promise<void>) | null> {
  const version = bundleVersion(script)
  const statusFile = join(dir, 'status.json')
  const account = readAccount(dir)
  let auth: RunnerStatus['auth'] = account ? 'signed-in' : 'signed-out'
  let config = readConfig(dir)
  let configAt: number | null = null
  let channels: Channels | null = null
  const writeStatus = (): void => {
    const runs = channels?.runnerLoad() ?? { running: 0, queued: 0 }
    const status: RunnerStatus = {
      version,
      auth,
      ...runs,
      configFrom: config?.installer ?? null,
      configAt,
      updatedAt: Date.now(),
    }
    try {
      writeJsonAtomic(statusFile, status)
    } catch {
      // 写不了状态不影响接活
    }
  }
  if (!account) {
    writeStatus()
    return null
  }

  const data = join(dir, 'data')
  mkdirSync(data, { recursive: true, mode: 0o700 })
  // 假的 peer：执行机没有桌面可问。平台额度、像素星空引擎都要桌面转发，一律报不支持
  let onEvent: (event: HostEvent) => void = () => {}
  const peer: TunnelPeer = {
    call: async () => {
      throw new Error('执行机上不能用平台额度，只能用这台机器上自己登录的 Claude Code / Codex')
    },
    event: (method: string, value: unknown) => {
      if (method === 'engine:event') onEvent(value as HostEvent)
    },
    handle: () => {},
  } as unknown as TunnelPeer
  const runtime = await createRemoteRuntime(peer, data, {
    // 执行机上的会话一律只用项目自己的 MCP（不带这台机器用户级的配置，也不挂像素星空的扩展）
    extensions: () => ({ key: 'runner', pluginDirs: [], pathDirs: [], strictMcp: true }),
  })
  const call = (channel: string, args: unknown[]): Promise<unknown> => runtime.call(channel, args)

  const store = new ChannelStore(join(data, 'channels'))
  await store.init()
  /** 桌面推来的成员写进执行机的成员表：项目按路径加进执行机的项目表（同一路径不会重复加） */
  const applyConfig = async (next: RunnerConfig | null): Promise<void> => {
    if (!next) return
    const members = []
    for (const m of next.members) {
      // 一个成员的项目目录在这台机器上没有：只跳过它，别的成员照常接活
      try {
        const project = (await call('engine:addProject', [m.projectPath])) as ProjectRecord
        members.push(runnerAgent(m, project.id))
      } catch (e) {
        process.stderr.write(`执行机加项目失败 ${m.projectPath} ${e instanceof Error ? e.message : String(e)}
`)
      }
    }
    // await 之后：配置可能又变了，只用最新的那份
    if (next !== config) return
    store.members = members
    const projects = (runtime.host.projects() as ProjectRecord[]).filter(p => next.teammate.projects?.includes(p.path))
    store.teammate = {
      ...next.teammate,
      projects: next.teammate.projects ? projects.map(p => p.id) : null,
    }
    await Promise.all([store.saveMembers(), store.saveTeammate()])
    configAt = Date.now()
    channels?.membersChanged()
  }
  await applyConfig(config)

  const team = new TeamSync({
    api: new TeamApi(runnerFetch(account)),
    realtime: handlers =>
      new TeamRealtime({
        url: teamsWsUrl(account.base) + '?version=' + encodeURIComponent(version),
        // 执行机令牌不会刷新：4001（被停用、重新配对过）让它停下
        token: async force => {
          if (force) {
            auth = 'revoked'
            writeStatus()
            return null
          }
          return account.token
        },
        ...handlers,
        onStatus: (status, stop) => {
          if (stop === 'seats') {
            auth = 'seats'
            writeStatus()
          }
          handlers.onStatus(status, stop)
        },
      }),
    inbox: false,
    log: (message, error) => process.stderr.write(`${message} ${error instanceof Error ? error.message : ''}\n`),
  })
  channels = new Channels({
    store,
    call,
    emit: () => {},
    machines: () => [{ id: 'local', name: account.name, connected: true }],
    projects: () => runtime.host.projects() as ProjectRecord[],
    sessions: () => runtime.host.sessions() as SessionSummary[],
    machineOf: () => 'local',
    selfName: () => config?.selfName ?? 'Runner',
    locale: () => config?.locale ?? 'zh-CN',
    log: (message, error) => process.stderr.write(`${message} ${error instanceof Error ? error.message : ''}\n`),
    team,
    deviceId: account.runnerId,
    machineName: () => account.name || hostname(),
    channelTools: false,
    unattended: true,
    maxRunning: RUNNER_MAX_RUNNING,
    copies: {
      create: async (projectId, input) => {
        const copy = (await call('projectTools:createCopy', [projectId, { existingBranch: false, ...input }])) as {
          id: string
          branch: string
          path: string
        }
        return { id: copy.id, branch: copy.branch, path: copy.path }
      },
      remove: async copyId => {
        await call('projectTools:removeCopy', [copyId, false])
      },
      dirty: async () => false,
    },
  })
  onEvent = event => channels?.hostEvent(event)
  team.start()

  // 桌面改了配置：每 2 秒看一次 config.json，变了就重读（在做的活用的是当时的配置，不受影响）
  watchFile(join(dir, 'config.json'), { interval: 2000 }, () => {
    config = readConfig(dir)
    void applyConfig(config).catch(e => process.stderr.write(`读执行机配置失败 ${String(e)}\n`))
  })
  writeStatus()
  const timer = setInterval(() => {
    writeStatus()
    // 升级（§11.7）：手上没在做的活时换上新版本退出，systemd 拉起新的；排着的活留在 runs.json 里接着排
    const next = nextScript(script)
    if (existsSync(next) && channels?.runnerLoad().running === 0) {
      renameSync(next, script)
      // 先好好关掉（运行信息写完盘）再退出
      void close().finally(() => process.exit(0))
    }
  }, STATUS_EVERY_MS)
  const close = async (): Promise<void> => {
    clearInterval(timer)
    team.stop()
    await channels?.dispose()
    await runtime.close()
  }
  return close
}
