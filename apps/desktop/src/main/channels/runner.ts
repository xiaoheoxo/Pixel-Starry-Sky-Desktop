// 执行机的桌面一侧（docs/multica-learn.md §9、§11.7）：机器页「设为执行机 / 停用」、成员「团队活由谁接」、
// 连上机器时核对版本和推配置。执行机装在 SSH / WSL 机器上（helper 的 runner:* 方法），这里记着哪台机器装的是哪台执行机
// （channels/runners.json），配置只由装它的这台桌面推。
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import * as ipc from '../ipc/guard'
import type { AppContext } from '../app/context'
import { baseUrl } from '../account/account'
import { machineOf } from '../machines/identity'
import type { Channels } from '../core/channels/service'
import { TeamError, isRunnerId, type TeamRunnerData } from '../core/channels/team/api'
import type { TeamSync } from '../core/channels/team/sync'
import type { RunnerState } from '../runner/install'
import type { RunnerConfig, RunnerView } from '../../shared/types/runner'
import { runnerConfig } from '../runner/config'

type RunnerMap = Record<string, { runnerId: string }>
type RemoteState = RunnerState & { helper: string | null }

const isMachineId = (v: unknown): v is string => typeof v === 'string' && !!v && v !== 'local' && v.length <= 200

export function initRunners(
  ctx: AppContext,
  deps: {
    channels: Channels
    team: TeamSync | null
    deviceId: string
    dir: string
    selfName: () => string
    locale: () => RunnerConfig['locale']
    log: (message: string, error?: unknown) => void
  },
): void {
  const { channels } = deps
  const api = () => {
    if (!deps.team) throw new Error('团队功能暂不可用')
    return deps.team.api
  }
  const file = join(deps.dir, 'runners.json')
  let map: RunnerMap = {}
  const loaded = readFile(file, 'utf8')
    .then(text => {
      const raw = JSON.parse(text) as unknown
      if (raw && typeof raw === 'object')
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          const id = (v as { runnerId?: unknown } | null)?.runnerId
          if (isMachineId(k) && typeof id === 'string' && isRunnerId(id)) map[k] = { runnerId: id }
        }
    })
    .catch(() => {})
  const save = async (): Promise<void> => {
    await writeFile(file + '.tmp', JSON.stringify(map))
    await rename(file + '.tmp', file)
  }
  /** 连上机器时读到的状态、最近一次出错 */
  const states = new Map<string, RemoteState | null>()
  const errors = new Map<string, string>()
  const pushed = new Map<string, string>()
  const busy = new Set<string>()

  const machines = () => {
    if (!ctx.machines) throw new Error('机器还没有就绪')
    return ctx.machines
  }
  const machineInfo = (id: string) => ctx.machines?.state().machines.find(m => m.id === id) ?? null
  const connected = (id: string): boolean => machineInfo(id)?.status === 'connected'
  const remote = <T>(id: string, method: string, args: unknown[] = []): Promise<T> =>
    machines().call<T>(id, method, args)

  const configFor = (machineId: string, runnerId: string): RunnerConfig => {
    const projects = ctx.machines?.projects() ?? []
    return runnerConfig({
      installer: deps.deviceId,
      locale: deps.locale(),
      selfName: deps.selfName(),
      members: channels.runnerMembers(runnerId).filter(m => m.machineId === machineId),
      teammate: channels.teammateRules(),
      projectPath: id => {
        const p = projects.find(x => x.id === id)
        return p && machineOf(p.id) === machineId ? p.path : null
      },
    })
  }

  /** 推配置：只在这台桌面装的、连着的、内容变了时推 */
  const push = async (machineId: string, force = false): Promise<void> => {
    const entry = map[machineId]
    if (!entry || !connected(machineId)) return
    const s = states.get(machineId)
    if (s && s.installer && s.installer !== deps.deviceId) return
    const config = configFor(machineId, entry.runnerId)
    const text = JSON.stringify(config)
    if (!force && pushed.get(machineId) === text) return
    await remote(machineId, 'runner:configure', [config])
    pushed.set(machineId, text)
  }

  /** 连上机器：读状态，版本落后就升级，再推一次配置 */
  const sync = async (machineId: string): Promise<void> => {
    if (!map[machineId] || !connected(machineId)) return
    try {
      const s = await remote<RemoteState>(machineId, 'runner:state')
      states.set(machineId, s)
      errors.delete(machineId)
      const mine = !s.installer || s.installer === deps.deviceId
      if (s.installed && mine && s.helper && s.version && s.helper !== s.version)
        await remote(machineId, 'runner:upgrade')
      if (s.installed) await push(machineId, true)
    } catch (e) {
      errors.set(machineId, e instanceof Error ? e.message : String(e))
    }
  }

  const view = async (): Promise<RunnerView[]> => {
    await loaded
    let cloud: TeamRunnerData[] | null = null
    try {
      cloud = await api().runners()
    } catch {
      cloud = null
    }
    const list = ctx.machines?.state().machines ?? []
    return list
      .filter(m => m.id !== 'local' && (m.platform === 'linux' || map[m.id]))
      .map((m): RunnerView => {
        const runnerId = map[m.id]?.runnerId ?? null
        const c = runnerId ? cloud?.find(r => r.id === runnerId) : undefined
        const s = m.status === 'connected' ? states.get(m.id) : undefined
        return {
          machineId: m.id,
          runnerId,
          online: !!c?.online,
          version: c?.version ?? s?.version ?? null,
          local: s
            ? {
                installed: s.installed,
                auth: s.status?.auth ?? null,
                running: s.status?.running ?? 0,
                queued: s.status?.queued ?? 0,
                linger: s.linger,
                mine: !s.installer || s.installer === deps.deviceId,
              }
            : null,
          members: runnerId ? channels.runnerMembers(runnerId).map(x => x.id) : [],
          installable: m.status === 'connected' && m.platform === 'linux',
          error: errors.get(m.id) ?? null,
        }
      })
  }

  const install = async (machineId: unknown): Promise<{ runnerId: string; linger: boolean }> => {
    if (!isMachineId(machineId)) throw new Error('机器不存在')
    await loaded
    const info = machineInfo(machineId)
    if (!info || info.status !== 'connected') throw new Error('先连上这台机器')
    if (info.platform !== 'linux') throw new Error('执行机第一版只支持 Linux')
    if (busy.has(machineId)) throw new Error('正在处理，请稍候')
    busy.add(machineId)
    try {
      // 重新装同一台：沿用原来的执行机（云端换新令牌，旧的作废），绑它的成员不用重绑
      const pairing = await api().runnerPairing(info.name, map[machineId]?.runnerId)
      const result = await remote<{ runnerId: string; linger: boolean }>(machineId, 'runner:install', [
        { code: pairing.code, base: baseUrl() },
      ])
      if (!isRunnerId(result?.runnerId)) throw new Error('执行机返回的数据异常')
      map = { ...map, [machineId]: { runnerId: result.runnerId } }
      await save()
      errors.delete(machineId)
      pushed.delete(machineId)
      await sync(machineId)
      return { runnerId: result.runnerId, linger: !!result.linger }
    } catch (e) {
      errors.set(machineId, e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      busy.delete(machineId)
    }
  }

  const remove = async (machineId: unknown): Promise<void> => {
    if (!isMachineId(machineId)) throw new Error('机器不存在')
    await loaded
    const entry = map[machineId]
    if (!entry) return
    if (busy.has(machineId)) throw new Error('正在处理，请稍候')
    busy.add(machineId)
    try {
      // 先把绑它的成员改回这台桌面接，再停用（云端停用时也会把它们改回谁都接）
      for (const m of channels.runnerMembers(entry.runnerId)) await channels.bindRunner(m.id, null)
      await api()
        .removeRunner(entry.runnerId)
        .catch((e: unknown) => {
          if (!(e instanceof TeamError && e.code === 'NOT_FOUND')) throw e
        })
      if (connected(machineId)) await remote(machineId, 'runner:remove')
      // await 之后：期间可能重新装过（换了执行机），只删还是这一台的
      if (map[machineId]?.runnerId === entry.runnerId) {
        const { [machineId]: _gone, ...rest } = map
        map = rest
        await save()
      }
      states.delete(machineId)
      pushed.delete(machineId)
      errors.delete(machineId)
    } finally {
      busy.delete(machineId)
    }
  }

  /** 成员「团队活由谁接」：这台机器上的执行机（on），或这台桌面 */
  const bind = async (memberId: unknown, on: unknown): Promise<void> => {
    if (typeof memberId !== 'string') throw new Error('成员不存在')
    await loaded
    const member = channels.memberConfig(memberId)
    if (!member) throw new Error('成员不存在')
    const runnerId = map[member.machineId]?.runnerId ?? null
    if (on === true && !runnerId) throw new Error('成员所在的机器还没设为执行机')
    await channels.bindRunner(memberId, on === true ? runnerId : null)
    const machineId = member.machineId
    if (map[machineId]) await push(machineId).catch(e => deps.log('推执行机配置失败', e))
  }

  // 机器连上时核对一次；成员设置变了（channels:changed）过一会儿推一次，内容没变不推
  const seen = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  ctx.events.taps.add(channel => {
    if (channel === 'machines:changed') {
      for (const m of ctx.machines?.state().machines ?? []) {
        const on = m.status === 'connected'
        if (on && !seen.has(m.id)) {
          seen.add(m.id)
          void loaded.then(() => sync(m.id))
        } else if (!on && seen.has(m.id)) {
          seen.delete(m.id)
          states.delete(m.id)
          pushed.delete(m.id)
        }
      }
    } else if (channel === 'channels:changed') {
      timer ??= setTimeout(() => {
        timer = null
        for (const id of Object.keys(map)) void push(id).catch(e => deps.log('推执行机配置失败', e))
      }, 3000)
    }
  })

  ipc.handle('channels:runners', () => view())
  ipc.handle('channels:runnerInstall', (_e, machineId) => install(machineId))
  ipc.handle('channels:runnerRemove', (_e, machineId) => remove(machineId))
  ipc.handle('channels:bindRunner', (_e, memberId, on) => bind(memberId, on))
}
