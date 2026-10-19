import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { WorkspaceRef } from '../../../shared/types/workspace'
import type { ServiceDefinition, ServiceInput, EnvironmentState, ToolStatus } from '../../../shared/types/project-tools'
import { JsonStore, directory, gitInfo, optional, run, samePath, value, type ToolsHost } from './common'
import { ConsoleLineDecoder, detectOemCodePage } from '@pixelsky/engine'
import { LOCKFILE_NAMES, detectPackageManager } from '@pixelsky/protocol'

interface Runtime {
  child: ChildProcess
  done: Promise<void>
  stopping: boolean
  secrets: string[]
  decoders: { stdout: ConsoleLineDecoder; stderr: ConsoleLineDecoder }
}
const envPattern = /TOKEN|SECRET|PASSWORD|KEY|AUTH|CREDENTIAL|COOKIE/i
export function redact(input: string, secrets: string[]): string {
  // eslint-disable-next-line no-control-regex -- 故意匹配终端转义码（ANSI 颜色序列），脱敏前先去掉
  let out = input.replace(/\x1b\[[0-9;]*m/g, '')
  for (const secret of secrets.filter(s => s.length >= 4).sort((a, b) => b.length - a.length))
    out = out.split(secret).join('[redacted]')
  return out
    .replace(/(Bearer\s+)[\w.+/=-]+/gi, '$1[redacted]')
    .replace(/((?:token|password|secret|api_key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
}
export function childEnvironment(names: string[], port: number | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, v] of Object.entries(process.env)) {
    if (v === undefined || /^ELECTRON_|^PIXELSKY_|^NODE_OPTIONS$|^NODE_PATH$/i.test(name)) continue
    if (!envPattern.test(name) || names.includes(name)) env[name] = v
  }
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name) || /^ELECTRON_|^PIXELSKY_|^NODE_OPTIONS$|^NODE_PATH$/i.test(name))
      throw new Error('环境变量名不正确')
    if (process.env[name] === undefined) throw new Error('环境变量不存在：' + name)
    env[name] = process.env[name]
  }
  if (port) env.PORT = String(port)
  return env
}
async function fileText(path: string): Promise<string> {
  try {
    if ((await stat(path)).size > 256_000) return ''
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}
async function findProgram(program: string): Promise<string | null> {
  const out = await optional(process.platform === 'win32' ? 'where.exe' : 'which', [program])
  return out?.split(/\r?\n/).find(p => process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(p)) ?? null
}
/** 程序版本。cwd 是项目目录（corepack 的 pnpm 按项目的 packageManager 报版本） */
export async function version(program: string, path: string, cwd: string): Promise<string | null> {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(path)) {
    // Fixed program identifiers only, avoiding arbitrary shell text during detection.
    if (!['pnpm', 'npm'].includes(program)) return null
    // cmd 按名字找程序时先找当前目录：写垫片的绝对路径，并让垫片里的 node 也不从项目目录找（审查报告 2026-10-14 第 2 条）
    return new Promise(done => {
      execFile(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `""${path}" --version"`],
        {
          cwd,
          env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
          windowsVerbatimArguments: true,
          windowsHide: true,
          timeout: 6000,
          encoding: 'utf8',
        },
        (err, out) => done(err ? null : out.trim()),
      )
    })
  }
  return optional(path, ['--version'], cwd)
}
export async function portStatus(port: number): Promise<{ occupied: boolean; pid: string | null; suggested: number }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口不正确')
  const probe = (host: string) =>
    new Promise<boolean>(r => {
      const sock = connect({ host, port })
      let done = false
      const end = (ok: boolean) => {
        if (done) return
        done = true
        sock.destroy()
        r(ok)
      }
      sock.setTimeout(500)
      sock.once('connect', () => end(true))
      sock.once('error', () => end(false))
      sock.once('timeout', () => end(false))
    })
  const occupied = (await Promise.all([probe('127.0.0.1'), probe('::1')])).some(Boolean)
  let pid: string | null = null,
    suggested = port
  if (occupied) {
    if (process.platform === 'win32') {
      const data = await optional('netstat.exe', ['-ano', '-p', 'tcp'])
      pid =
        data
          ?.split('\n')
          .map(l => l.trim().split(/\s+/))
          .find(p => p[1]?.endsWith(':' + port) && p[3] === 'LISTENING')?.[4] ?? null
    }
    suggested = await new Promise<number>((r, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address(),
          available = typeof address === 'object' && address ? address.port : 0
        server.close(() => r(available))
      })
    })
  }
  return { occupied, pid, suggested }
}
export class Services {
  readonly store: JsonStore<{ version: 1; services: ServiceDefinition[] }>
  private running = new Map<string, Runtime>()
  private operations = new Map<string, Promise<unknown>>()
  private cache = new Map<string, { at: number; state: EnvironmentState }>()
  private closed = false
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(
    dir: string,
    private host: ToolsHost,
    private changed: () => void,
    private validateWorkspace: (id: string, path: string) => Promise<void> = async () => {},
  ) {
    this.store = new JsonStore(join(dir, 'services.json'), { version: 1, services: [] })
  }
  async init(): Promise<void> {
    await this.store.init()
    for (const s of this.store.data.services) {
      s.status = 'stopped'
      s.pid = null
      s.output = ''
      s.error = null
      s.health = 'none'
    }
    this.timer = setInterval(() => {
      void this.healthChecks()
    }, 2500)
    this.timer.unref()
    for (const service of this.store.data.services.filter(s => s.autoStart)) void this.start(service.id).catch(() => {})
  }
  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    this.operations.set(id, next)
    void next
      .finally(() => {
        if (this.operations.get(id) === next) this.operations.delete(id)
      })
      .catch(() => {})
    return next
  }
  get(id: string): ServiceDefinition {
    const s = this.store.data.services.find(s => s.id === id)
    if (!s) throw new Error('服务不存在')
    return s
  }
  list(ref: WorkspaceRef): ServiceDefinition[] {
    const target = this.host.resolve(ref)
    return this.store.data.services
      .filter(s => s.projectId === target.projectId && samePath(s.workspacePath, target.path))
      .map(s => ({ ...s }))
  }
  async save(ref: WorkspaceRef, input: ServiceInput): Promise<ServiceDefinition> {
    if (!input || typeof input !== 'object') throw new Error('参数不正确')
    const target = this.host.resolve(ref)
    await this.validateWorkspace(target.projectId, target.path)
    const cwd = await directory(target.path, input.cwd || '')
    const name = value(input.name, 80, true),
      command = value(input.command, 2000, true),
      port = input.port ?? null
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('端口不正确')
    const healthUrl = input.healthUrl ? value(input.healthUrl, 1000) : null
    if (healthUrl && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(healthUrl))
      throw new Error('健康检查只支持本机 HTTP 地址')
    const envNames = input.envNames ?? []
    if (!Array.isArray(envNames) || envNames.length > 50) throw new Error('环境变量名不正确')
    childEnvironment(envNames, port)
    const result = await this.store.transaction(data => {
      const old = input.id
        ? data.services.find(
            s => s.id === input.id && s.projectId === target.projectId && samePath(s.workspacePath, target.path),
          )
        : null
      if (input.id && !old) throw new Error('服务不存在')
      if (old && this.running.has(old.id)) throw new Error('请先停止服务')
      const s: ServiceDefinition = {
        id: old?.id ?? randomUUID(),
        projectId: target.projectId,
        workspacePath: target.path,
        name,
        command,
        cwd,
        port,
        healthUrl,
        envNames: [...new Set(envNames)],
        autoStart: input.autoStart === true,
        status: 'stopped',
        pid: null,
        output: '',
        error: null,
        exitCode: null,
        health: 'none',
        updatedAt: Date.now(),
      }
      if (old) data.services = data.services.map(item => (item.id === s.id ? s : item))
      else data.services.push(s)
      return s
    })
    this.changed()
    return result
  }
  async remove(id: string): Promise<void> {
    await this.locked(id, async () => {
      if (this.running.has(id)) throw new Error('请先停止服务')
      await this.store.transaction(data => {
        data.services = data.services.filter(s => s.id !== id)
      })
    })
    this.changed()
  }
  start(id: string): Promise<ServiceDefinition> {
    return this.locked(id, () => this.startInner(id))
  }
  private async startInner(id: string): Promise<ServiceDefinition> {
    const s = this.get(id)
    if (this.closed) throw new Error('服务正在关闭')
    if (this.running.has(id)) return { ...s }
    this.host.resolve({ projectId: s.projectId })
    await this.validateWorkspace(s.projectId, s.workspacePath)
    await directory(s.workspacePath, s.cwd)
    if (s.port && (await portStatus(s.port)).occupied) throw new Error('端口已被占用：' + s.port)
    const env = childEnvironment(s.envNames, s.port)
    const secrets = Object.entries(env)
      .filter(([name]) => envPattern.test(name))
      .map(([, v]) => v ?? '')
    // The user previews and starts this command explicitly. It is a normal local process, not an OS sandbox.
    const command =
      process.platform === 'win32'
        ? ((await findProgram('pwsh.exe')) ??
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'))
        : '/bin/sh'
    const args =
      process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', s.command]
        : ['-c', s.command]
    await detectOemCodePage() // 先查好系统代码页（只查一次），输出解码时用
    const child = spawn(command, args, {
      cwd: s.cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    s.status = 'starting'
    s.output = ''
    s.error = null
    s.exitCode = null
    s.pid = child.pid ?? null
    s.health = s.port || s.healthUrl ? 'checking' : 'none'
    let finish!: () => void
    const runtime: Runtime = {
      child,
      stopping: false,
      secrets,
      done: new Promise(r => {
        finish = r
      }),
      // 按字节收、整行解码：UTF-8 优先，原生程序按系统代码页（GBK 等）输出的行也能读。
      // 两个流各用一个，免得两边的半行拼在一起；密钥在解码前先按字节遮掉（解错编码也拆不散它）
      decoders: {
        stdout: new ConsoleLineDecoder({ mask: secrets }),
        stderr: new ConsoleLineDecoder({ mask: secrets }),
      },
    }
    this.running.set(id, runtime)
    const update =
      (decoder: ConsoleLineDecoder) =>
      (chunk: Buffer): void => {
        if (this.running.get(id) !== runtime) return
        // Render only complete lines: a credential split across data events is never leaked.
        const text = decoder.write(chunk)
        if (text) {
          s.output = (s.output + redact(text, secrets)).slice(-24_000)
          this.changed()
        }
      }
    child.stdout?.on('data', update(runtime.decoders.stdout))
    child.stderr?.on('data', update(runtime.decoders.stderr))
    child.once('close', (code, signal) => {
      if (this.running.get(id) !== runtime) {
        finish()
        return
      }
      const rest = runtime.decoders.stdout.end() + runtime.decoders.stderr.end()
      s.output = (s.output + redact(rest, secrets)).slice(-24_000)
      s.status = runtime.stopping || code === 0 ? 'stopped' : 'failed'
      s.error = s.status === 'failed' ? signal || String(code) : null
      s.exitCode = code
      s.pid = null
      s.health = 'none'
      s.updatedAt = Date.now()
      this.running.delete(id)
      this.changed()
      finish()
    })
    try {
      await new Promise<void>((r, reject) => {
        child.once('spawn', r)
        child.once('error', reject)
      })
      child.stdin?.end()
      s.status = 'running'
      s.updatedAt = Date.now()
      this.changed()
      return { ...s }
    } catch (error) {
      s.status = 'failed'
      s.error = redact(String(error), secrets)
      s.pid = null
      this.running.delete(id)
      this.changed()
      finish()
      throw error
    }
  }
  stop(id: string, force = false): Promise<void> {
    return this.locked(id, () => this.stopInner(id, force))
  }
  private async stopInner(id: string, force: boolean): Promise<void> {
    const runtime = this.running.get(id)
    if (!runtime) return
    const s = this.get(id),
      pid = runtime.child.pid
    if (!pid) return
    runtime.stopping = true
    s.status = 'stopping'
    this.changed()
    try {
      if (process.platform === 'win32')
        await run('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], undefined, 6000)
      else process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      /* The close event is the authority; the process may already have exited. */
    }
    await Promise.race([runtime.done, new Promise(r => setTimeout(r, 1800))])
    if (this.running.get(id) === runtime) throw new Error('服务仍在运行，可选择强制停止')
  }
  restart(id: string): Promise<ServiceDefinition> {
    return this.locked(id, async () => {
      await this.stopInner(id, false)
      return this.startInner(id)
    })
  }
  async stopPath(path: string): Promise<void> {
    for (const service of this.store.data.services.filter(s => samePath(s.workspacePath, path)))
      await this.stop(service.id)
  }
  async shutdown(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    await Promise.allSettled([...this.running.keys()].map(id => this.stop(id, true)))
  }
  private async healthChecks(): Promise<void> {
    await Promise.allSettled(
      [...this.running.keys()].map(async id => {
        const s = this.get(id),
          runtime = this.running.get(id)
        if (!s.port && !s.healthUrl) return
        let healthy = false
        try {
          healthy = s.healthUrl
            ? (await fetch(s.healthUrl, { signal: AbortSignal.timeout(1500), redirect: 'error' })).ok
            : !!s.port && (await portStatus(s.port)).occupied
        } catch {}
        if (this.running.get(id) !== runtime || s.status !== 'running') return
        const state = healthy ? 'healthy' : 'unhealthy'
        if (s.health !== state) {
          s.health = state
          this.changed()
        }
      }),
    )
  }
  async environment(ref: WorkspaceRef, force = false): Promise<EnvironmentState> {
    const target = this.host.resolve(ref),
      cached = this.cache.get(target.path)
    if (!force && cached && Date.now() - cached.at < 30_000) return { ...cached.state, services: this.list(ref) }
    const info = await gitInfo(target.path)
    let pkg: { engines?: Record<string, string>; packageManager?: string; scripts?: Record<string, string> } = {}
    try {
      pkg = JSON.parse((await fileText(join(target.path, 'package.json'))) || '{}')
    } catch {}
    const nodeExpected = (await fileText(join(target.path, '.nvmrc'))).trim() || pkg.engines?.node
    const pythonExpected = (await fileText(join(target.path, '.python-version'))).trim()
    const rustExpected =
      (await fileText(join(target.path, 'rust-toolchain'))).trim() ||
      (await fileText(join(target.path, 'rust-toolchain.toml'))).match(/channel\s*=\s*"([^"]+)"/)?.[1]
    const expected: Record<string, string | undefined> = {
      ...pkg.engines,
      node: nodeExpected,
      python: pythonExpected,
      rustc: rustExpected,
    }
    if (pkg.packageManager) {
      const match = pkg.packageManager.match(/^(npm|pnpm)@([^+]+)/)
      if (match) expected[match[1]] = match[2]
    }
    const tools: ToolStatus[] = await Promise.all(
      ['git', 'node', 'pnpm', 'npm', 'python', 'rustc', 'cargo'].map(async name => {
        const path = await findProgram(name),
          raw = path ? await version(name, path, target.path) : null,
          versionText = raw?.split(/\r?\n/)[0] ?? null
        const requirement = expected[name] || null,
          actual = versionText?.match(/\d+\.\d+\.\d+/)?.[0]
        // Exact numeric declarations are comparable; complex constraints remain visible without pretending they were validated.
        const exact = requirement?.replace(/^v/, ''),
          comparable = !!exact && /^\d+(\.\d+){0,2}$/.test(exact)
        const matches = comparable && actual ? actual === exact || actual.startsWith(exact + '.') : true
        return {
          name,
          path,
          version: versionText,
          expected: requirement,
          status: !path
            ? 'missing'
            : !raw
              ? 'error'
              : !matches
                ? 'mismatch'
                : requirement && !comparable
                  ? 'unknown'
                  : 'ready',
          checkedAt: Date.now(),
        }
      }),
    )
    const scripts = Object.fromEntries(
      Object.entries(pkg.scripts ?? {}).filter(([key, val]) => typeof val === 'string' && /^[\w:.-]+$/.test(key)),
    )
    // 终端「脚本」菜单用它决定 npm / pnpm / yarn / bun run（docs/ui/files-search-terminal-pins.md §4.3）
    const lockfiles = new Set(
      (
        await Promise.all(
          LOCKFILE_NAMES.map(name =>
            stat(join(target.path, name)).then(
              () => name,
              () => null,
            ),
          ),
        )
      ).filter((name): name is string => !!name),
    )
    const state: EnvironmentState = {
      projectId: target.projectId,
      projectPath: target.path,
      gitRoot: info.root,
      branch: info.branch,
      commit: info.commit,
      dirty: info.dirty,
      tools,
      services: this.list(ref),
      checkedAt: Date.now(),
      scripts,
      packageManager: detectPackageManager(pkg.packageManager, name => lockfiles.has(name)),
    }
    this.cache.set(target.path, { at: Date.now(), state })
    return state
  }
}
