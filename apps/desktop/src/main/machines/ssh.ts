import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
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
/**
 * 让远端 node 跑一段脚本。远端的默认 shell 可能是 sh / bash（Linux、macOS），也可能是 cmd / PowerShell（Windows 的 OpenSSH）：
 * 脚本 base64 后只剩字母数字和 +/=，外面一层双引号、里面单引号，几种 shell 都原样交给 node，不会被展开或转义
 */
export const nodeScript = (script: string): string =>
  `node -e "eval(Buffer.from('${Buffer.from(script, 'utf8').toString('base64')}','base64').toString())"`
/** 能连的远端系统：helper 和引擎都是纯 Node，这几个平台本机也都支持 */
const SUPPORTED_PLATFORMS = new Set(['linux', 'darwin', 'win32'])
/** 远端路径用远端系统的规则拼（Windows 是反斜杠） */
export const remotePath = (platform: string) => (platform === 'win32' ? win32 : posix)
/** 命令输出的最后一个非空行：远端 shell 的启动文件（.bashrc 等）可能在前面打印东西，我们的脚本只输出一行 */
export const lastLine = (output: string): string =>
  output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1) ?? ''
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
  /** 远程端口 → 本机监听；存进行中的 Promise，同一端口并发请求复用同一个，不会多开一个关不到的 */
  private localForwards = new Map<number, Promise<Server>>()
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
        // 收到 banner 后、ready 前断开（或连接中途被 disconnect）只有 close 没有 error：不结束握手的话 connect 永远挂着
        reject(new Error('SSH_CONNECTION_CLOSED'))
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
      nodeScript(
        "process.stdout.write(JSON.stringify({home:require('node:os').homedir(),platform:process.platform,version:process.versions.node,arch:process.arch}))",
      ),
    )
    let info: { home: string; platform: string; version: string; arch?: string }
    try {
      info = JSON.parse(lastLine(probe))
    } catch {
      throw new Error('SSH_NODE_REQUIRED')
    }
    if (!SUPPORTED_PLATFORMS.has(info.platform)) throw new Error('SSH_PLATFORM_UNSUPPORTED')
    const path = remotePath(info.platform)
    if (Number(info.version.split('.')[0]) < 22) throw new Error('SSH_NODE_REQUIRED')
    const helper = await readFile(helperPath),
      hash = createHash('sha256').update(helper).digest('hex')
    // Upload through stdin; paths/data never become shell fragments.
    const install = `const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');const b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>{const data=Buffer.concat(b);if(c.createHash('sha256').update(data).digest('hex')!==${JSON.stringify(hash)})process.exit(2);const dir=p.join(require('node:os').homedir(),'.local','share','pixelsky','remote',${JSON.stringify(REMOTE_DIR)});fs.mkdirSync(dir,{recursive:true,mode:448});const file=p.join(dir,${JSON.stringify('helper-' + hash + '.cjs')});fs.writeFileSync(file,data,{mode:384});process.stdout.write(file)})`
    const helperFile = lastLine(await this.exec(nodeScript(install), helper))
    if (helperFile !== path.join(info.home, '.local', 'share', 'pixelsky', 'remote', REMOTE_DIR, `helper-${hash}.cjs`))
      throw new Error('SSH_HELPER_PATH_INVALID')
    const namespace = input.id ?? 'default'
    if (!/^((ssh|wsl)-[a-f0-9-]+|default)$/.test(namespace)) throw new Error('SSH_INVALID_CONFIG')
    const cliPath = await this.installCli(info)
    const args = [helperFile, namespace, ...(cliPath ? [cliPath] : [])]
    // Windows 上路径交给 cmd / PowerShell 转义不可靠：改由 node -e 设好 argv 再加载 helper（Windows 没有 /proc，
    // remote-entry 也不靠命令行认旧进程）；其他系统照旧直接跑，命令行里带 helper 路径
    const channel = await this.channel(
      info.platform === 'win32'
        ? nodeScript(`process.argv=[process.execPath,...${JSON.stringify(args)}];require(process.argv[1])`)
        : 'node ' + args.map(quoteSh).join(' '),
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
    if (this.hello.protocol !== REMOTE_PROTOCOL || this.hello.platform !== info.platform)
      throw new Error('SSH_PROTOCOL_MISMATCH')
    return this.hello
  }
  /** 把像素星空命令行装到远程（已装好的不重传）。失败一律吞掉：没有命令行不影响连接，只是远程用不了像素星空引擎 */
  private async installCli(info: {
    home: string
    platform: string
    version: string
    arch?: string
  }): Promise<string | null> {
    try {
      if (!remoteCliSupported(info.version, info.arch)) return null
      const archive = await this.cliArchive(info.arch as 'x64' | 'arm64', info.platform)
      if (!archive) return null
      // 只认最后一行、而且得是装好的入口：.bashrc 打印的横幅不能被当成「已装好」
      const valid = (path: string): string | null =>
        isRemoteCliEntry(path, info.home, archive.hash, info.platform === 'win32') ? path : null
      const found = valid(lastLine(await this.exec(nodeScript(remoteCliCheckScript(archive.hash)))))
      if (found) return found
      return valid(
        lastLine(
          await this.exec(nodeScript(remoteCliInstallScript(archive.hash)), archive.data, REMOTE_CLI_INSTALL_TIMEOUT),
        ),
      )
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
    const channel = await this.channel(
      this.hello?.platform === 'win32'
        ? windowsShellCommand(cwd, shell)
        : 'cd -- ' + quoteSh(cwd) + ' && exec ' + quoteSh(shell) + ' -l',
      size,
    )
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
    if (this.closing) throw new Error('SSH_CONNECTION_CLOSED')
    let pending = this.localForwards.get(remotePort)
    if (!pending) {
      const created = this.listenLocal(remotePort)
      this.localForwards.set(remotePort, created)
      // 没开成：不记着，下次重试
      created.catch(() => {
        if (this.localForwards.get(remotePort) === created) this.localForwards.delete(remotePort)
      })
      pending = created
    }
    return ((await pending).address() as { port: number }).port
  }
  private async listenLocal(remotePort: number): Promise<Server> {
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
    // 开监听期间连接关了：close() 关不到它，这里关掉
    if (this.closing) {
      server.close()
      throw new Error('SSH_CONNECTION_CLOSED')
    }
    return server
  }
  close(): void {
    if (this.closing) return
    this.closing = true
    this.peer?.close()
    this.client.end()
    for (const pending of this.localForwards.values())
      pending.then(
        server => server.close(),
        () => {},
      )
    this.localForwards.clear()
    this.remoteForwards.clear()
  }
}

/**
 * Windows 远端的终端命令：OpenSSH 默认用 cmd 或 PowerShell 执行，没有 `cd -- … && exec`。
 * 都用 PowerShell 的 -EncodedCommand 进目录（UTF-16LE base64，不经任何 shell 转义，路径里的 `'`、`%`、`$` 都原样）。
 * 要 cmd 时由 PowerShell 进目录后再起 cmd（PowerShell 起外部程序时把当前目录交给它），cmd 退出 PowerShell 也跟着退出；
 * 不用 `cmd /k cd /d "…"`，那样路径里的 % 会被 cmd 当成变量展开
 */
export function windowsShellCommand(cwd: string, shell: string): string {
  const name = win32.basename(shell).toLowerCase()
  const enter = "Set-Location -LiteralPath '" + cwd.replaceAll("'", "''") + "'"
  const encode = (script: string) => Buffer.from(script, 'utf16le').toString('base64')
  if (name === 'cmd.exe' || name === 'cmd')
    return `powershell.exe -NoLogo -NoProfile -EncodedCommand ${encode(enter + '; & cmd.exe /d; exit $LASTEXITCODE')}`
  const exe = name === 'pwsh.exe' || name === 'pwsh' ? 'pwsh.exe' : 'powershell.exe'
  return `${exe} -NoLogo -NoExit -EncodedCommand ${encode(enter)}`
}
