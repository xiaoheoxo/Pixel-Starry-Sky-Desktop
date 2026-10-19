import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { connect as connectTcp, createServer, type Server } from 'node:net'
import { REMOTE_PROTOCOL } from '@pixelsky/protocol'
import { RpcPeer, type RpcHandler } from './rpc'
import type { MachineInput } from '../../shared/types/machines'
import type { RemoteHello, RemoteLink, ShellChannel } from './link'
import {
  REMOTE_CLI_INSTALL_TIMEOUT,
  isRemoteCliEntry,
  remoteCliCheckScript,
  remoteCliInstallScript,
  remoteCliSupported,
} from './remote-cli'
import { remoteCliArchive, type RemoteCliProvider } from './remote-cli-source'

/** Upload directory of the helper on the remote machine; changes together with the protocol version. */
const REMOTE_DIR = 'v' + REMOTE_PROTOCOL
export const quoteSh = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
export type { RemoteHello }
export class FingerprintRequired extends Error {
  constructor(
    readonly fingerprint: string,
    readonly changed: boolean,
  ) {
    super('SSH_FINGERPRINT_REQUIRED')
  }
}
export class SshConnection implements RemoteLink {
  readonly client = new Client()
  peer: RpcPeer | null = null
  hello: RemoteHello | null = null
  fingerprint = ''
  private closing = false
  private remoteForwards = new Map<number, number>()
  private localForwards = new Map<number, Server>()
  onClose: (message: string) => void = () => {}
  /** 命令行包的来源；测试里换掉 */
  cliArchive: RemoteCliProvider = remoteCliArchive
  async connect(
    input: MachineInput,
    trusted: string | null,
    candidate: string | undefined,
    helperPath: string,
    callback: RpcHandler,
  ): Promise<RemoteHello> {
    const config: ConnectConfig = {
      host: input.host,
      port: input.port,
      username: input.username,
      readyTimeout: 15_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        this.fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
        return this.fingerprint === trusted || this.fingerprint === candidate
      },
    }
    if (input.auth === 'password') config.password = input.password
    else if (input.auth === 'key') {
      if (!input.privateKeyPath) throw new Error('SSH_KEY_REQUIRED')
      config.privateKey = await readFile(input.privateKeyPath)
      config.passphrase = input.passphrase || undefined
    } else
      config.agent =
        process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
    if (input.auth === 'agent' && !config.agent) throw new Error('SSH_AGENT_UNAVAILABLE')
    await new Promise<void>((resolve, reject) => {
      this.client.once('ready', resolve)
      this.client.on('error', error => {
        reject(
          this.fingerprint && this.fingerprint !== trusted && this.fingerprint !== candidate
            ? new FingerprintRequired(this.fingerprint, !!trusted)
            : error,
        )
      })
      this.client.once('close', () => {
        if (!this.closing) {
          this.peer?.close()
          this.onClose('SSH_CONNECTION_CLOSED')
        }
      })
      this.client.connect(config)
    })
    this.client.on('tcp connection', (info, accept, reject) => {
      const target = this.remoteForwards.get(info.destPort)
      if (!target || info.destIP !== '127.0.0.1') {
        reject()
        return
      }
      const channel = accept(),
        socket = connectTcp({ host: '127.0.0.1', port: target })
      socket.on('error', () => channel.destroy())
      channel.on('error', () => socket.destroy())
      channel.on('close', () => socket.destroy())
      socket.on('close', () => channel.destroy())
      socket.pipe(channel).pipe(socket)
    })
    const probe = await this.exec(
      'node -e ' +
        quoteSh(
          "process.stdout.write(JSON.stringify({home:require('node:os').homedir(),platform:process.platform,version:process.versions.node,arch:process.arch}))",
        ),
    )
    let info: { home: string; platform: string; version: string; arch?: string }
    try {
      info = JSON.parse(probe)
    } catch {
      throw new Error('SSH_NODE_REQUIRED')
    }
    if (info.platform !== 'linux') throw new Error('SSH_LINUX_REQUIRED')
    if (Number(info.version.split('.')[0]) < 22) throw new Error('SSH_NODE_REQUIRED')
    const helper = await readFile(helperPath),
      hash = createHash('sha256').update(helper).digest('hex')
    // Upload through stdin; paths/data never become shell fragments.
    const install = `const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');const b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>{const data=Buffer.concat(b);if(c.createHash('sha256').update(data).digest('hex')!==${JSON.stringify(hash)})process.exit(2);const dir=p.join(require('node:os').homedir(),'.local','share','pixelsky','remote',${JSON.stringify(REMOTE_DIR)});fs.mkdirSync(dir,{recursive:true,mode:448});const file=p.join(dir,${JSON.stringify('helper-' + hash + '.cjs')});fs.writeFileSync(file,data,{mode:384});process.stdout.write(file)})`
    const remotePath = (await this.exec('node -e ' + quoteSh(install), helper)).trim()
    if (!remotePath.startsWith(info.home + '/.local/share/pixelsky/remote/' + REMOTE_DIR + '/helper-'))
      throw new Error('SSH_HELPER_PATH_INVALID')
    const namespace = input.id ?? 'default'
    if (!/^((ssh|wsl)-[a-f0-9-]+|default)$/.test(namespace)) throw new Error('SSH_INVALID_CONFIG')
    const cliPath = await this.installCli(info)
    const channel = await this.channel(
      'node ' + quoteSh(remotePath) + ' ' + quoteSh(namespace) + (cliPath ? ' ' + quoteSh(cliPath) : ''),
    )
    let diagnostic = ''
    channel.stderr.on('data', (data: Buffer) => {
      if (diagnostic.length < 2000) diagnostic += data.toString()
    })
    this.peer = new RpcPeer(channel, channel, callback)
    this.peer.onClose = error => {
      if (!this.closing) {
        this.onClose(error.message)
        this.close()
      }
    }
    try {
      this.hello = await this.peer.call<RemoteHello>('hello', [], 20_000)
    } catch (error) {
      if (diagnostic.includes('SSH_ALREADY_CONNECTED')) throw new Error('SSH_ALREADY_CONNECTED')
      throw error
    }
    if (this.hello.protocol !== REMOTE_PROTOCOL || this.hello.platform !== 'linux')
      throw new Error('SSH_PROTOCOL_MISMATCH')
    return this.hello
  }
  /** 把像素星空命令行装到远程（已装好的不重传）。失败一律吞掉：没有命令行不影响连接，只是远程用不了像素星空引擎 */
  private async installCli(info: { home: string; version: string; arch?: string }): Promise<string | null> {
    try {
      if (!remoteCliSupported(info.version, info.arch)) return null
      const archive = await this.cliArchive(info.arch as 'x64' | 'arm64')
      if (!archive) return null
      let path = (await this.exec('node -e ' + quoteSh(remoteCliCheckScript(archive.hash)))).trim()
      if (!path) {
        path = (
          await this.exec(
            'node -e ' + quoteSh(remoteCliInstallScript(archive.hash)),
            archive.data,
            REMOTE_CLI_INSTALL_TIMEOUT,
          )
        ).trim()
      }
      return isRemoteCliEntry(path, info.home, archive.hash) ? path : null
    } catch {
      return null
    }
  }
  channel(command: string, pty?: { cols: number; rows: number }): Promise<ClientChannel> {
    return new Promise((resolve, reject) =>
      this.client.exec(command, pty ? { pty: { term: 'xterm-256color', ...pty } } : {}, (error, stream) =>
        error ? reject(error) : resolve(stream),
      ),
    )
  }
  async openShell(cwd: string, shell: string, size: { cols: number; rows: number }): Promise<ShellChannel> {
    const channel = await this.channel('cd -- ' + quoteSh(cwd) + ' && exec ' + quoteSh(shell) + ' -l', size)
    return {
      write: data => void channel.write(data),
      resize: (cols, rows) => void channel.setWindow(rows, cols, 0, 0),
      pause: () => void channel.pause(),
      resume: () => void channel.resume(),
      kill: () => {
        channel.signal('TERM')
        channel.close()
      },
      onData: cb => {
        channel.on('data', cb)
        channel.stderr.on('data', cb)
      },
      onClose: cb => void channel.on('close', cb),
      onError: cb => void channel.on('error', cb),
    }
  }
  async exec(command: string, input?: Buffer, timeout = 25_000): Promise<string> {
    const channel = await this.channel(command)
    return new Promise((resolve, reject) => {
      let output = '',
        errors = ''
      const timer = setTimeout(() => {
        channel.close()
        reject(new Error('SSH_COMMAND_TIMEOUT'))
      }, timeout)
      channel.on('data', (data: Buffer) => {
        output += data.toString()
        if (output.length > 1024 * 1024) {
          channel.close()
          reject(new Error('SSH_OUTPUT_LIMIT'))
        }
      })
      channel.stderr.on('data', data => {
        if (errors.length < 4000) errors += data.toString()
      })
      channel.on('error', (error: Error) => {
        clearTimeout(timer)
        reject(error)
      })
      channel.on('close', (code: number) => {
        clearTimeout(timer)
        if (code) reject(new Error(errors || 'SSH_COMMAND_FAILED'))
        else resolve(output)
      })
      channel.end(input)
    })
  }
  async forwardGateway(localPort: number): Promise<number> {
    const found = [...this.remoteForwards].find(([, target]) => target === localPort)
    if (found) return found[0]
    const port = await new Promise<number>((resolve, reject) =>
      this.client.forwardIn('127.0.0.1', 0, (error, port) => (error ? reject(error) : resolve(port))),
    )
    this.remoteForwards.set(port, localPort)
    return port
  }
  async forwardPort(remotePort: number): Promise<number> {
    const prior = this.localForwards.get(remotePort)?.address()
    if (prior && typeof prior === 'object') return prior.port
    const server = createServer(socket => {
      this.client.forwardOut('127.0.0.1', socket.localPort ?? 0, '127.0.0.1', remotePort, (error, channel) => {
        if (error) {
          socket.destroy()
          return
        }
        socket.on('error', () => channel.destroy())
        channel.on('error', () => socket.destroy())
        socket.on('close', () => channel.destroy())
        channel.on('close', () => socket.destroy())
        socket.pipe(channel).pipe(socket)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    this.localForwards.set(remotePort, server)
    return (server.address() as { port: number }).port
  }
  close(): void {
    if (this.closing) return
    this.closing = true
    this.peer?.close()
    this.client.end()
    for (const server of this.localForwards.values()) server.close()
    this.localForwards.clear()
    this.remoteForwards.clear()
  }
}
