import { spawn as defaultSpawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { REMOTE_PROTOCOL } from '@pixelsky/protocol'
import { RpcPeer, type RpcHandler } from './rpc'
import { TunnelEnd } from './tunnel'
import type { RemoteHello, RemoteLink, ShellChannel } from './link'
import { PROBE_SCRIPT, parseProbe, pickNode, probeArgs, readyToConnect, wslCheckItems } from './wslProbe'
import type { CheckItem, WslProbe } from './wslProbe'
import { decodeWslOutput } from './wslList'
import {
  REMOTE_CLI_INSTALL_TIMEOUT,
  isRemoteCliEntry,
  remoteCliCheckScript,
  remoteCliInstallScript,
  remoteCliSupported,
} from './remote-cli'
import { remoteCliArchive, type RemoteCliProvider } from './remote-cli-source'

// 绝不执行 wsl --shutdown / --terminate：会把 Docker Desktop 等其他发行版一起关掉。关闭只结束我们自己起的进程。

const REMOTE_DIR = 'v' + REMOTE_PROTOCOL
const PROBE_TIMEOUT = 60_000
const INSTALL_TIMEOUT = 30_000
const HELLO_TIMEOUT = 20_000
const KILL_DELAY = 5_000

/** 必需项没过：message 固定，items 交给界面显示检查卡片。 */
export class WslNotReady extends Error {
  constructor(readonly items: CheckItem[]) {
    super('WSL_NOT_READY')
  }
}

export const wslExe = (): string => join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'wsl.exe')

const base = (distro: string, cd = '~') => ['-d', distro, '--cd', cd, '--exec']

/**
 * 上传程序的 node -e 脚本。命令行经 Windows / wsl.exe 转义，脚本里不能有双引号、$、反引号、百分号，
 * 所以字符串全用单引号、不用模板字符串。哈希是十六进制，目录名是 v<数字>，嵌入单引号里安全。
 */
export function installScript(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('WSL_INVALID_HASH')
  return (
    "const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');" +
    "const b=[];process.stdin.on('data',x=>b.push(x));" +
    "process.stdin.on('end',()=>{const data=Buffer.concat(b);" +
    "if(c.createHash('sha256').update(data).digest('hex')!=='" +
    hash +
    "')process.exit(2);" +
    "const dir=p.join(require('node:os').homedir(),'.local','share','pixelsky','remote','" +
    REMOTE_DIR +
    "');fs.mkdirSync(dir,{recursive:true,mode:448});" +
    "const file=p.join(dir,'helper-" +
    hash +
    ".cjs');" +
    'fs.writeFileSync(file,data,{mode:384});process.stdout.write(file)})'
  )
}

export const installArgs = (distro: string, node: string, hash: string): string[] => [
  ...base(distro),
  node,
  '-e',
  installScript(hash),
]

export const helperArgs = (
  distro: string,
  node: string,
  helperPath: string,
  namespace: string,
  utf8Fix: boolean,
  cliPath?: string,
): string[] => [
  ...base(distro),
  ...(utf8Fix ? ['env', 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8'] : []),
  node,
  helperPath,
  namespace,
  ...(cliPath ? [cliPath] : []),
]

export const shellArgs = (distro: string, cwd: string, shell: string): string[] => [...base(distro, cwd), shell, '-l']

type Spawn = typeof defaultSpawn
export interface WslConnectOptions {
  exe?: string
  spawn?: Spawn
  requireLinux?: boolean
  /** 测试用：关闭后多久强杀 wsl.exe */
  killDelay?: number
  /** 测试用：命令行包的来源 */
  cliArchive?: RemoteCliProvider
}
interface Captured {
  stdout: Buffer
  stderr: Buffer
  code: number | null
}

/** 给服务层的「重新检查」用：一次性探测，不建立连接 */
export async function probeWsl(
  distro: string,
  nodePath?: string,
  opts: Pick<WslConnectOptions, 'exe' | 'spawn'> = {},
): Promise<CheckItem[]> {
  const link = new WslConnection()
  link.configure(opts)
  return (await link.probe(distro, nodePath)).items
}

export class WslConnection implements RemoteLink {
  peer: RpcPeer | null = null
  hello: RemoteHello | null = null
  onClose: (message: string) => void = () => {}
  private child: ChildProcess | null = null
  private tunnel: TunnelEnd | null = null
  private closing = false
  private exe = wslExe()
  private spawn: Spawn = defaultSpawn
  private distro = ''
  private readonly direct = new Map<number, Promise<number>>()
  private readonly shells = new Set<pty.IPty>()
  private killDelay = KILL_DELAY

  configure(opts: WslConnectOptions): void {
    this.exe = opts.exe ?? wslExe()
    this.spawn = opts.spawn ?? defaultSpawn
  }

  async connect(
    distro: string,
    id: string,
    nodePath: string | undefined,
    helperPath: string,
    callback: RpcHandler,
    opts: WslConnectOptions = {},
  ): Promise<{ hello: RemoteHello; probe: WslProbe; items: CheckItem[] }> {
    if (!/^wsl-[a-f0-9]{12}$/.test(id)) throw new Error('SSH_INVALID_CONFIG')
    this.distro = distro
    this.configure(opts)
    this.killDelay = opts.killDelay ?? KILL_DELAY
    const { probe, items } = await this.probe(distro, nodePath)
    const node = probe ? pickNode(probe) : null
    if (!probe || !node || !readyToConnect(items)) throw new WslNotReady(items)
    const home = probe.home
    if (!home)
      throw new WslNotReady([{ key: 'start', status: 'fail', required: true, detail: '', code: 'WSL_HOME_EMPTY' }])

    const helper = await readFile(helperPath)
    const hash = createHash('sha256').update(helper).digest('hex')
    const installed = await this.capture(installArgs(distro, node, hash), helper, INSTALL_TIMEOUT)
    if (installed.code) throw new Error(decodeWslOutput(installed.stderr).slice(0, 2000) || 'WSL_COMMAND_FAILED')
    const remotePath = installed.stdout.toString('utf8').trim()
    if (!remotePath.startsWith(home + '/.local/share/pixelsky/remote/' + REMOTE_DIR + '/helper-'))
      throw new Error('SSH_HELPER_PATH_INVALID')

    const cliPath = await this.installCli(distro, node, probe, opts.cliArchive ?? remoteCliArchive)
    const utf8Fix = !/^utf-?8$/i.test(probe.charmap ?? '')
    const child = this.spawn(this.exe, helperArgs(distro, node, remotePath, id, utf8Fix, cliPath ?? undefined), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: '1' },
    })
    this.child = child
    let diagnostic = ''
    // hello 之前失败只让 connect 抛错，不再触发 onClose，免得调用方收到两次
    let ready = false
    child.stderr!.on('data', (data: Buffer) => {
      if (diagnostic.length < 2000) diagnostic += data.toString()
    })
    const closed = (message: string) => {
      if (this.closing) return
      if (ready) this.onClose(message)
      this.close()
    }
    child.on('error', error => closed(error.message))
    child.on('exit', () => closed('WSL_CONNECTION_CLOSED'))
    const peer = new RpcPeer(child.stdout!, child.stdin!, callback)
    this.peer = peer
    peer.onClose = error => closed(error.message === 'SSH_CONNECTION_CLOSED' ? 'WSL_CONNECTION_CLOSED' : error.message)
    this.tunnel = new TunnelEnd(peer, 'desktop')
    try {
      this.hello = await peer.call<RemoteHello>('hello', [], HELLO_TIMEOUT)
    } catch (error) {
      this.close()
      if (diagnostic.includes('SSH_ALREADY_CONNECTED')) throw new Error('SSH_ALREADY_CONNECTED')
      if ((error as Error).message === 'SSH_CONNECTION_CLOSED') throw new Error('WSL_CONNECTION_CLOSED')
      throw error
    }
    if (this.hello.protocol !== REMOTE_PROTOCOL || (opts.requireLinux !== false && this.hello.platform !== 'linux')) {
      this.close()
      throw new Error('SSH_PROTOCOL_MISMATCH')
    }
    ready = true
    return { hello: this.hello, probe, items }
  }

  /** 把像素星空命令行装进发行版（已装好的不重传）。node 不够新（Pi 要 22.19）或架构不认识就跳过；失败一律吞掉，不影响连接 */
  private async installCli(
    distro: string,
    node: string,
    probe: WslProbe,
    provider: RemoteCliProvider,
  ): Promise<string | null> {
    try {
      const version = probe.nodes.find(n => n.path === node)?.version
      if (!probe.home || !remoteCliSupported(version, probe.arch)) return null
      const archive = await provider(probe.arch!)
      if (!archive) return null
      const run = async (script: string, input: Buffer, timeout: number) => {
        const out = await this.capture([...base(distro), node, '-e', script], input, timeout)
        return out.code ? '' : out.stdout.toString('utf8').trim()
      }
      const path =
        (await run(remoteCliCheckScript(archive.hash), Buffer.alloc(0), INSTALL_TIMEOUT)) ||
        (await run(remoteCliInstallScript(archive.hash), archive.data, REMOTE_CLI_INSTALL_TIMEOUT))
      return isRemoteCliEntry(path, probe.home, archive.hash) ? path : null
    } catch {
      return null
    }
  }

  /** 只探测：不上传、不起后台。启动失败也返回（probe 为 null，items 里有 start 项） */
  async probe(distro: string, nodePath?: string): Promise<{ probe: WslProbe | null; items: CheckItem[] }> {
    let probe: WslProbe | null = null
    let startError: string | undefined
    try {
      const out = await this.capture(probeArgs(distro, nodePath), Buffer.from(PROBE_SCRIPT), PROBE_TIMEOUT)
      probe = parseProbe(decodeWslOutput(out.stdout))
      if (!probe) {
        startError = (decodeWslOutput(out.stderr).trim() || decodeWslOutput(out.stdout).trim()).slice(0, 2000)
      }
    } catch (error) {
      startError = (error as Error).message
    }
    return { probe, items: wslCheckItems(probe, startError) }
  }

  // 一次性命令：stdin 喂 input，收齐 stdout / stderr；超时杀掉子进程
  private capture(args: string[], input: Buffer, timeout: number): Promise<Captured> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.exe, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, WSL_UTF8: '1' },
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let size = 0
      let errSize = 0
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('WSL_COMMAND_TIMEOUT'))
      }, timeout)
      child.stdout!.on('data', (d: Buffer) => {
        size += d.length
        if (size > 1024 * 1024) {
          child.kill()
          clearTimeout(timer)
          reject(new Error('SSH_OUTPUT_LIMIT'))
        } else out.push(d)
      })
      child.stderr!.on('data', (d: Buffer) => {
        if (errSize < 4000) {
          errSize += d.length
          err.push(d)
        }
      })
      child.on('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', code => {
        clearTimeout(timer)
        resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code })
      })
      child.stdin!.on('error', () => {})
      child.stdin!.end(input)
    })
  }

  async openShell(cwd: string, shell: string, size: { cols: number; rows: number }): Promise<ShellChannel> {
    if (this.closing) throw new Error('WSL_CONNECTION_CLOSED')
    const child = pty.spawn(this.exe, shellArgs(this.distro, cwd, shell), {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      env: { ...process.env, WSL_UTF8: '1' } as Record<string, string>,
      useConpty: true,
    })
    this.shells.add(child)
    child.onExit(() => this.shells.delete(child))
    return {
      write: data => child.write(data),
      resize: (cols, rows) => child.resize(cols, rows),
      pause: () => child.pause(),
      resume: () => child.resume(),
      kill: () => {
        // Windows 上 node-pty 不支持信号，传了会抛
        if (process.platform !== 'win32') {
          try {
            child.kill('SIGTERM')
          } catch {
            /* 已退出 */
          }
        }
        try {
          child.kill()
        } catch {
          /* 已退出 */
        }
      },
      onData: cb => void child.onData(data => cb(Buffer.from(data))),
      onClose: cb => void child.onExit(e => cb(e.exitCode)),
      onError: () => {},
    }
  }

  forwardGateway(localPort: number): Promise<number> {
    if (!this.tunnel) return Promise.reject(new Error('WSL_CONNECTION_CLOSED'))
    return this.tunnel.listenRemote(localPort)
  }

  // 不先试直连 Windows 的 127.0.0.1：端口可能被 Windows 上别的程序占着，会悄悄连错；一律走隧道
  forwardPort(remotePort: number): Promise<number> {
    let found = this.direct.get(remotePort)
    if (!found) {
      if (!this.tunnel) return Promise.reject(new Error('WSL_CONNECTION_CLOSED'))
      found = this.tunnel.listenLocal(remotePort)
      this.direct.set(remotePort, found)
      found.catch(() => this.direct.delete(remotePort))
    }
    return found
  }

  async stats(): Promise<{ rssMb: number; processes: number } | null> {
    try {
      return (await this.peer?.call<{ rssMb: number; processes: number }>('stats', [], 5000)) ?? null
    } catch {
      return null
    }
  }

  close(): void {
    if (this.closing) return
    this.closing = true
    this.tunnel?.close()
    this.peer?.close()
    this.direct.clear()
    // 已开的终端也是 wsl.exe 子进程，一起结束
    for (const shell of this.shells) {
      try {
        shell.kill()
      } catch {
        /* 已退出 */
      }
    }
    this.shells.clear()
    const child = this.child
    if (!child) return
    child.stdin?.end()
    if (child.exitCode !== null || child.signalCode !== null) return
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }, this.killDelay)
    timer.unref()
    child.once('exit', () => clearTimeout(timer))
  }
}
