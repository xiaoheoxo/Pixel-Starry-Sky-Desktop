import { app, clipboard, dialog, safeStorage } from 'electron'
import { join, isAbsolute, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostname, homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import type { EngineHost } from '@pixelsky/engine'
import type { HostEvent, ProjectRecord, SessionRecord, SessionSummary } from '@pixelsky/protocol'
import type { CheckItem, MachineConnection, MachineInfo, MachineInput, MachineState } from '../../shared/types/machines'
import type { WorkspaceRef, WorkspaceTarget } from '../../shared/types/workspace'
import * as ipc from '../ipc/guard'
import { platformCharges } from '../platform/billing'
import { checkProvider, validateQueuedInput } from '../platform/platform'
import { MODEL_SETTINGS_ENV, compactWindows } from '../platform/compact-window'
import type { AppContext } from '../app/context'
import type { ProviderStore } from '../core/providers/store'
import type { EventBus, PushChannel } from '../app/events'
import { FingerprintRequired, SshConnection } from './ssh'
import type { RemoteLink } from './link'
import { WslConnection, WslNotReady, probeWsl, wslExe } from './wsl'
import { listWsl, visibleDistros } from './wslList'
import { checkNodePath, mergeWsl, parseWslRecords, persistableRecords } from './wslMachines'
import type { WslEntry, WslRecord } from './wslMachines'
import type { RpcHandler } from './rpc'
import { machineOf, remoteIds, remoteArguments, remoteMethod } from './identity'
import { resolveRoute } from './routing'
import { addProjectPath } from '../core/engine/ops'

interface StoredMachine extends Omit<MachineInput, 'password' | 'passphrase'> {
  id: string
  secret?: string
  fingerprint: string | null
}
interface RemoteState {
  info: MachineInfo
  connection?: RemoteLink
  pendingFingerprint?: string
  /** WSL 发行版已不在列表里（且没连接）：不在 state() 里显示 */
  hidden?: boolean
  projects: ProjectRecord[]
  sessions: SessionSummary[]
  executions: Map<string, SessionRecord>
}
function input(value: MachineInput): MachineInput {
  if (!value || !['agent', 'key', 'password'].includes(value.auth)) throw new Error('SSH_INVALID_CONFIG')
  for (const key of ['name', 'host', 'username'] as const)
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 255 || /[\r\n\0]/.test(value[key]))
      throw new Error('SSH_INVALID_CONFIG')
  if (
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    /[\s/@]/.test(value.host) ||
    /[\s@]/.test(value.username)
  )
    throw new Error('SSH_INVALID_CONFIG')
  if (value.auth === 'key' && (!value.privateKeyPath || !isAbsolute(value.privateKeyPath)))
    throw new Error('SSH_KEY_REQUIRED')
  return {
    id: value.id,
    name: value.name.trim(),
    host: value.host.trim(),
    port: value.port,
    username: value.username.trim(),
    auth: value.auth,
    privateKeyPath: value.privateKeyPath,
    password: typeof value.password === 'string' ? value.password : undefined,
    passphrase: typeof value.passphrase === 'string' ? value.passphrase : undefined,
  }
}
export class Machines {
  currentId = 'local'
  private configs: StoredMachine[] = []
  private states = new Map<string, RemoteState>()
  private memorySecrets = new Map<string, { password?: string; passphrase?: string }>()
  private busy = new Set<string>()
  private saving: Promise<void> = Promise.resolve()
  private wslRecords = new Map<string, WslRecord>()
  private file = join(app.getPath('userData'), 'machines.json')
  private wslFile = join(app.getPath('userData'), 'wsl-machines.json')
  constructor(
    private host: EngineHost,
    private environment: (record: SessionRecord) => NodeJS.ProcessEnv,
    private events: EventBus,
    private providers: () => ProviderStore | null = () => null,
  ) {}
  async init(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'))
      this.configs = Array.isArray(saved.machines)
        ? saved.machines.filter((m: StoredMachine) => /^ssh-[a-f0-9-]+$/.test(m.id)).slice(0, 50)
        : []
    } catch {}
    for (const machine of this.configs)
      this.states.set(machine.id, {
        info: {
          ...machine,
          kind: 'ssh',
          hasSecret: !!machine.secret,
          status: 'disconnected',
          error: null,
          platform: null,
          home: null,
        },
        projects: [],
        sessions: [],
        executions: new Map(),
      })
    try {
      for (const record of parseWslRecords(JSON.parse(await readFile(this.wslFile, 'utf8'))))
        this.wslRecords.set(record.id, record)
    } catch {}
    // 不阻塞启动：wsl.exe 慢或没有时，列表晚一点出来
    if (process.platform === 'win32') void this.refreshWsl().catch(() => {})
  }
  /** 重新检测发行版，更新机器列表（已连接的保持连接） */
  async refreshWsl(): Promise<MachineState> {
    const listed = await listWsl()
    // wsl.exe 偶发失败：保持现状，不把机器藏起来、也不把当前视图切回本机
    if (!listed) return this.state()
    const distros = visibleDistros(listed)
    const connected = new Set(
      [...this.states]
        .filter(([id, s]) => id.startsWith('wsl-') && (s.info.status === 'connected' || s.info.status === 'connecting'))
        .map(([id]) => id),
    )
    const shown = mergeWsl(this.wslRecords, distros, connected)
    const ids = new Set<string>()
    for (const entry of shown) {
      ids.add(entry.record.id)
      this.applyWsl(entry)
    }
    for (const [id, state] of this.states)
      if (id.startsWith('wsl-') && !ids.has(id)) {
        state.hidden = true
        if (this.currentId === id) this.currentId = 'local'
      }
    this.changed()
    return this.state()
  }
  private applyWsl({ record, distro }: WslEntry): void {
    const old = this.states.get(record.id)
    const keep = old?.info.status === 'connected' || old?.info.status === 'connecting'
    const info: MachineInfo = {
      id: record.id,
      kind: 'wsl',
      name: record.distro,
      host: '',
      port: 0,
      username: '',
      auth: 'wsl',
      hasSecret: false,
      status: keep ? old!.info.status : 'disconnected',
      error: keep ? old!.info.error : null,
      fingerprint: null,
      platform: old?.info.platform ?? null,
      home: old?.info.home ?? null,
      wsl: {
        distro: record.distro,
        version: distro?.version ?? old?.info.wsl?.version ?? 2,
        isDefault: distro?.isDefault ?? false,
        state: distro?.state ?? 'missing',
        lastCheck: record.lastCheck,
        nodePath: record.nodePath,
      },
    }
    if (old) {
      old.info = info
      old.hidden = false
    } else this.states.set(record.id, { info, projects: [], sessions: [], executions: new Map() })
  }
  state(): MachineState {
    return {
      currentId: this.currentId,
      machines: [
        {
          id: 'local',
          kind: 'local',
          name: hostname(),
          host: '',
          port: 0,
          username: '',
          auth: 'local',
          status: 'local',
          hasSecret: false,
          error: null,
          fingerprint: null,
          platform: process.platform,
          home: homedir(),
        },
        ...[...this.states.values()]
          .filter(s => !s.hidden)
          .map(
            ({ info }): MachineInfo => ({
              id: info.id,
              kind: info.kind,
              name: info.name,
              host: info.host,
              port: info.port,
              username: info.username,
              auth: info.auth,
              privateKeyPath: info.privateKeyPath,
              hasSecret: info.hasSecret,
              status: info.status,
              error: info.error,
              fingerprint: info.fingerprint,
              platform: info.platform,
              home: info.home,
              wsl: info.wsl,
            }),
          ),
      ],
    }
  }
  changed(): void {
    this.events.broadcast('machines:changed', this.state())
  }
  broadcast(channel: PushChannel, value: unknown): void {
    this.events.broadcast(channel, value)
  }
  projects(): ProjectRecord[] {
    return [...this.host.projects(), ...[...this.states.values()].flatMap(s => s.projects)]
  }
  sessions(): SessionSummary[] {
    return [...this.host.sessions(), ...[...this.states.values()].flatMap(s => s.sessions)].sort(
      (a, b) => b.record.updatedAt - a.record.updatedAt,
    )
  }
  hostEvent(event: HostEvent): void {
    if (event.kind === 'projects') this.broadcast('engine:event', { kind: 'projects', projects: this.projects() })
    else if (event.kind === 'sessions') this.broadcast('engine:event', { kind: 'sessions', sessions: this.sessions() })
    else if (!['engines', 'engine_config'].includes(event.kind) || this.currentId === 'local')
      this.broadcast('engine:event', event)
  }
  record(id: string): SessionRecord | null {
    const state = this.states.get(machineOf(id))
    return state?.executions.get(id) ?? state?.sessions.find(s => s.record.id === id)?.record ?? null
  }
  target(ref: WorkspaceRef): WorkspaceTarget | null {
    const id = ref.projectId ?? ref.sessionId,
      remote = this.states.get(machineOf(id))
    if (!remote) return null
    const record = ref.sessionId ? this.record(ref.sessionId) : null
    const project = remote.projects.find(p => p.id === (ref.projectId ?? record?.projectId))
    if (!record && !project) throw new Error('项目已不存在')
    return { ref, name: project?.name ?? record!.title, path: record?.cwd ?? project!.path }
  }
  private write(file: string, data: string): Promise<void> {
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        await mkdir(app.getPath('userData'), { recursive: true })
        const temporary = file + '.tmp'
        await writeFile(temporary, data, { mode: 0o600 })
        await rename(temporary, file)
      })
    return this.saving
  }
  private persist(): Promise<void> {
    return this.write(this.file, JSON.stringify({ version: 1, machines: this.configs }, null, 2))
  }
  private persistWsl(): Promise<void> {
    const machines = persistableRecords(this.wslRecords.values())
    return this.write(this.wslFile, JSON.stringify({ version: 1, machines }, null, 2))
  }
  async save(raw: MachineInput): Promise<MachineInfo> {
    if (typeof raw?.id === 'string' && raw.id.startsWith('wsl-')) throw new Error('WSL_NOT_EDITABLE')
    const value = input(raw),
      old = this.configs.find(m => m.id === value.id)
    if (value.id && !old) throw new Error('SSH_MACHINE_MISSING')
    if (old && this.states.get(old.id)?.info.status === 'connected') throw new Error('SSH_DISCONNECT_BEFORE_EDIT')
    const id = old?.id ?? 'ssh-' + randomUUID()
    const secrets = {
      ...(old ? this.secret(old) : {}),
      ...(value.password !== undefined ? { password: value.password } : {}),
      ...(value.passphrase !== undefined ? { passphrase: value.passphrase } : {}),
    }
    if (value.auth === 'password' && !secrets.password) throw new Error('SSH_PASSWORD_REQUIRED')
    const { password: _password, passphrase: _passphrase, ...publicValue } = value
    const machine: StoredMachine = {
      ...publicValue,
      id,
      fingerprint: old?.host === value.host && old.port === value.port ? old.fingerprint : null,
    }
    if (
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
    )
      machine.secret = safeStorage.encryptString(JSON.stringify(secrets)).toString('base64')
    this.memorySecrets.set(id, secrets)
    this.configs = [...this.configs.filter(m => m.id !== id), machine]
    const state: RemoteState = {
      info: {
        ...machine,
        kind: 'ssh',
        hasSecret: !!secrets.password || !!secrets.passphrase,
        status: 'disconnected',
        error: null,
        platform: null,
        home: null,
      },
      projects: this.states.get(id)?.projects ?? [],
      sessions: this.states.get(id)?.sessions ?? [],
      executions: new Map(),
    }
    this.states.set(id, state)
    await this.persist()
    this.changed()
    return this.state().machines.find(m => m.id === id)!
  }
  private secret(machine: StoredMachine): { password?: string; passphrase?: string } {
    const value = this.memorySecrets.get(machine.id)
    if (value) return value
    try {
      return machine.secret ? JSON.parse(safeStorage.decryptString(Buffer.from(machine.secret, 'base64'))) : {}
    } catch {
      return {}
    }
  }
  // SSH 和 WSL 共用：远端程序回调本机的两件事（环境变量、平台额度）
  private callback(id: string, state: RemoteState, link: RemoteLink): RpcHandler {
    return async (method, args) => {
      if (method === 'platform:environment') {
        const record = remoteIds(args[0] as SessionRecord, id, true)
        await validateQueuedInput(record, this.providers())
        state.executions.set(record.id, record)
        const env = this.environment(record)
        // 网关设置文件在远端写：自定义接口按模型的压缩窗口借环境变量带过去（docs/ui/custom-api.md §9）
        const provider = record.engine === 'claude' ? checkProvider(record, this.providers()) : null
        const windows = provider ? compactWindows(provider.models) : null
        if (windows) env[MODEL_SETTINGS_ENV] = JSON.stringify(windows)
        for (const key of [
          'ANTHROPIC_BASE_URL',
          'PIXELSKY_CODEX_BASE_URL',
          'PIXELSKY_PIXEL_BASE_URL',
          'PIXELSKY_PIXEL_SUB_BASE_URL',
        ])
          if (env[key]) {
            const url = new URL(env[key]!),
              remotePort = await link.forwardGateway(Number(url.port))
            url.port = String(remotePort)
            env[key] = url.href.replace(/\/$/, '')
          }
        delete env.PIXELSKY_GATEWAY_SETTINGS
        return env
      }
      if (method === 'platform:charges')
        return platformCharges(args[0] as Parameters<typeof platformCharges>[0], AbortSignal.timeout(30_000))
      throw new Error('REMOTE_CALLBACK_UNSUPPORTED')
    }
  }
  // 开始连接：占位、关掉旧连接、挂上断开处理
  private begin(id: string, state: RemoteState, connection: RemoteLink): void {
    this.busy.add(id)
    state.connection?.close()
    state.info.status = 'connecting'
    state.info.error = null
    this.changed()
    state.connection = connection
    connection.onClose = message => {
      if (state.connection === connection) {
        state.info.status = 'disconnected'
        state.info.error = message
        state.executions.clear()
        this.changed()
      }
    }
  }
  // 握手成功之后：接事件、拉项目和会话、落盘
  private async attach(id: string, state: RemoteState, connection: RemoteLink, save: () => Promise<void>) {
    connection.peer!.onEvent = (channel, raw) => {
      const event = remoteIds(raw, id, true)
      if (channel === 'engine:event') {
        const message = event as HostEvent
        if (message.kind === 'projects') {
          state.projects = message.projects
          this.hostEvent(message)
        } else if (message.kind === 'sessions') {
          state.sessions = message.sessions
          this.hostEvent(message)
        } else if (!['engines', 'engine_config'].includes(message.kind) || this.currentId === id)
          this.broadcast(channel, message)
      } else if (channel === 'projectTools:changed') this.broadcast(channel, null)
    }
    state.projects = await this.call(id, 'engine:projects', [])
    state.sessions = await this.call(id, 'engine:sessions', [])
    await save()
    this.hostEvent({ kind: 'projects', projects: [] })
    this.hostEvent({ kind: 'sessions', sessions: [] })
    this.changed()
  }
  async connect(id: string, accepted?: string): Promise<MachineConnection> {
    const state = this.states.get(id)
    if (state?.info.kind === 'wsl') return this.connectWsl(id, state)
    const config = this.configs.find(m => m.id === id)
    if (!config || !state) throw new Error('SSH_MACHINE_MISSING')
    if (this.busy.has(id)) throw new Error('SSH_CONNECTING')
    if (
      this.configs.some(
        other =>
          other.id !== id &&
          other.host === config.host &&
          other.port === config.port &&
          other.username === config.username &&
          this.states.get(other.id)?.info.status === 'connecting',
      )
    )
      throw new Error('SSH_CONNECTING')
    if (state.connection?.peer && state.info.status === 'connected') return { connected: true }
    if (accepted && state.pendingFingerprint !== accepted) throw new Error('SSH_FINGERPRINT_CHANGED')
    const connection = new SshConnection()
    this.begin(id, state, connection)
    try {
      const hello = await connection.connect(
        { ...config, ...this.secret(config) },
        config.fingerprint,
        accepted,
        join(__dirname, '../remote/helper.cjs'),
        this.callback(id, state, connection),
      )
      config.fingerprint = connection.fingerprint
      state.pendingFingerprint = undefined
      Object.assign(state.info, {
        fingerprint: connection.fingerprint,
        platform: hello.platform,
        home: hello.home,
        status: 'connected',
        error: null,
      })
      await this.attach(id, state, connection, () => this.persist())
      return { connected: true }
    } catch (error) {
      connection.close()
      state.connection = undefined
      state.info.status = 'error'
      if (error instanceof FingerprintRequired) {
        state.pendingFingerprint = error.fingerprint
        state.info.error = 'SSH_FINGERPRINT_REQUIRED'
        return { connected: false, fingerprint: error.fingerprint, changed: error.changed }
      }
      state.info.error = (error as Error).message
      throw error
    } finally {
      this.busy.delete(id)
      this.changed()
    }
  }
  private setCheck(record: WslRecord, state: RemoteState | undefined, items: CheckItem[]): void {
    record.lastCheck = { at: Date.now(), items }
    if (state?.info.wsl) state.info.wsl.lastCheck = record.lastCheck
  }
  private async connectWsl(id: string, state: RemoteState): Promise<MachineConnection> {
    const record = this.wslRecords.get(id)
    if (!record) throw new Error('SSH_MACHINE_MISSING')
    if (this.busy.has(id)) throw new Error('SSH_CONNECTING')
    if (state.connection?.peer && state.info.status === 'connected') return { connected: true }
    const connection = new WslConnection()
    this.begin(id, state, connection)
    try {
      const { hello, items } = await connection.connect(
        record.distro,
        id,
        record.nodePath,
        join(__dirname, '../remote/helper.cjs'),
        this.callback(id, state, connection),
      )
      this.setCheck(record, state, items)
      Object.assign(state.info, { platform: hello.platform, home: hello.home, status: 'connected', error: null })
      await this.attach(id, state, connection, () => this.persistWsl())
      return { connected: true }
    } catch (error) {
      connection.close()
      state.connection = undefined
      state.info.status = 'error'
      const message = (error as Error).message
      state.info.error = message
      if (error instanceof WslNotReady) {
        state.info.error = 'WSL_NOT_READY'
        this.setCheck(record, state, error.items)
        await this.persistWsl().catch(() => {})
        return { connected: false, items: error.items }
      }
      // 探测之后的失败（安装、握手、协议）和「WSL 启动失败」无关，不改检查结果，错误只放在 info.error
      throw error
    } finally {
      this.busy.delete(id)
      this.changed()
    }
  }
  private wslRecord(id: string): { record: WslRecord; state: RemoteState | undefined } {
    const record = typeof id === 'string' ? this.wslRecords.get(id) : undefined
    if (!record) throw new Error('SSH_MACHINE_MISSING')
    return { record, state: this.states.get(id) }
  }
  /** 只探测，不上传、不起后台；结果写进 lastCheck */
  async checkWsl(id: string): Promise<CheckItem[]> {
    const { record, state } = this.wslRecord(id)
    if (this.busy.has(id)) throw new Error('SSH_CONNECTING')
    const items = await probeWsl(record.distro, record.nodePath)
    this.setCheck(record, state, items)
    await this.persistWsl()
    this.changed()
    return items
  }
  /** 指定（或清除，null）这个发行版里用的 Linux 版 node */
  async setWslNode(id: string, path: string | null): Promise<void> {
    const { record, state } = this.wslRecord(id)
    if (state?.info.status === 'connected') throw new Error('SSH_DISCONNECT_BEFORE_EDIT')
    if (path === null) delete record.nodePath
    else record.nodePath = checkNodePath(path)
    if (state?.info.wsl) state.info.wsl.nodePath = record.nodePath
    await this.persistWsl()
    this.changed()
  }
  /**
   * 打开 WSL 终端：本机终端面板没有 WSL 的 shell 配置，所以直接起一个独立的 wsl.exe 控制台窗口。
   * 不经 shell，发行版名只作参数。
   */
  wslTerminal(id: string): Promise<void> {
    const { record } = this.wslRecord(id)
    const child = spawn(wslExe(), ['-d', record.distro, '--cd', '~'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    // 等到真正起来或失败再返回，找不到 wsl.exe 时让界面能提示
    return new Promise((resolve, reject) => {
      child.once('error', error => {
        console.warn('[machines] wsl terminal failed', error.message)
        reject(new Error('WSL_START_FAILED'))
      })
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  }
  /** 已连接的 WSL 机器里我们自己的进程占的内存（Windows 上只记在 vmmemWSL 里，看不到） */
  async stats(id: string): Promise<{ rssMb: number; processes: number } | null> {
    const link = this.states.get(id)?.connection
    return link instanceof WslConnection ? link.stats() : null
  }
  connection(id: string): RemoteLink {
    const state = this.states.get(id)
    if (!state?.connection?.peer || state.info.status !== 'connected') throw new Error('SSH_NOT_CONNECTED')
    return state.connection
  }
  async call<T = unknown>(id: string, channel: string, args: unknown[]): Promise<T> {
    const result = await this.connection(id).peer!.call<T>(channel, remoteArguments(channel, args, id))
    return remoteIds(result, id, true)
  }
  async select(id: string) {
    if (id !== 'local') this.connection(id)
    this.currentId = id
    this.changed()
    return { projects: this.projects(), sessions: this.sessions() }
  }
  disconnect(id: string): void {
    const state = this.states.get(id)
    if (!state) return
    state.connection?.close()
    state.connection = undefined
    state.info.status = 'disconnected'
    state.executions.clear()
    this.changed()
  }
  async remove(id: string): Promise<void> {
    if (id === 'local') throw new Error('SSH_LOCAL_REQUIRED')
    if (id.startsWith('wsl-')) throw new Error('WSL_NOT_EDITABLE')
    this.disconnect(id)
    this.states.delete(id)
    this.configs = this.configs.filter(m => m.id !== id)
    this.memorySecrets.delete(id)
    if (this.currentId === id) this.currentId = 'local'
    await this.persist()
    this.changed()
    this.hostEvent({ kind: 'projects', projects: [] })
    this.hostEvent({ kind: 'sessions', sessions: [] })
  }
  async invoke(channel: string, args: unknown[], fallback: () => unknown): Promise<unknown> {
    const route = resolveRoute(channel, args, this.currentId)
    switch (route.kind) {
      case 'aggregate':
        return route.what === 'projects' ? this.projects() : this.sessions()
      case 'local':
        return fallback()
      case 'copyPath': {
        const target = this.target(args[0] as WorkspaceRef)!
        clipboard.writeText(posix.join(target.path, String(args[1] ?? '')))
        return
      }
      case 'target':
        return this.target(args[0] as WorkspaceRef)
      case 'usageExport': {
        const csv = await this.call<string>(route.machine, remoteMethod(channel), args)
        const result = await dialog.showSaveDialog({
          defaultPath: 'pixelsky-remote-usage.csv',
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        })
        if (result.canceled || !result.filePath) return false
        await writeFile(result.filePath, csv, 'utf8')
        return true
      }
      case 'picker':
        throw new Error('SSH_USE_WORKSPACE_PICKER')
      case 'remote':
        return this.call(route.machine, remoteMethod(channel), args)
    }
  }
}
/** 创建 SSH 机器服务并放进 ctx.machines（读配置之前就放，和原来的时机一致），注册 machines:* 接口 */
export async function initMachines(
  ctx: AppContext,
  host: EngineHost,
  environment: (record: SessionRecord) => NodeJS.ProcessEnv,
): Promise<Machines> {
  const service = new Machines(host, environment, ctx.events, () => ctx.providers)
  ctx.machines = service
  await service.init()
  const actions: Record<string, (...args: never[]) => unknown> = {
    state: () => service.state(),
    save: value => service.save(value),
    connect: (id, fingerprint) => service.connect(id, fingerprint),
    disconnect: id => service.disconnect(id),
    remove: id => service.remove(id),
    select: id => service.select(id),
    chooseKey: async () => {
      const result = await dialog.showOpenDialog({ properties: ['openFile'] })
      return result.canceled ? null : result.filePaths[0]
    },
    directories: (id, path) => service.call(id, remoteMethod('machines:directories'), [path]),
    wslList: () => service.refreshWsl(),
    wslCheck: id => service.checkWsl(id),
    wslSetNode: (id, path) => service.setWslNode(id, path),
    wslTerminal: id => service.wslTerminal(id),
    addProject: (id, path) =>
      id === 'local' ? addProjectPath(host, path) : service.call(id, remoteMethod('machines:addProject'), [path]),
  }
  for (const [name, fn] of Object.entries(actions))
    ipc.handle(`machines:${name}` as ipc.InvokeChannel, (_event, ...args) => fn(...args))
  ctx.lifecycle.onShutdown(() => {
    for (const machine of service.state().machines) if (machine.id !== 'local') service.disconnect(machine.id)
  })
  return service
}
