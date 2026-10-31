import { afterEach, describe, expect, it } from 'vitest'
import { Server as SshServer, type Connection } from 'ssh2'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createServer, connect, type Server } from 'node:net'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { REMOTE_PROTOCOL } from '@pixelsky/protocol'
import { RpcPeer } from './rpc'
import { SshConnection, FingerprintRequired, quoteSh, nodeScript, windowsShellCommand } from './ssh'
import type { MachineInput } from '../../shared/types/machines'

/** nodeScript 包出来的命令还原成脚本；不是这种格式的命令原样返回 */
const decodeNodeScript = (command: string): string => {
  const m = /^node -e "eval\(Buffer\.from\('([A-Za-z0-9+/=]*)','base64'\)\.toString\(\)\)"$/.exec(command)
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : command
}

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function server(probe: { version?: string; arch?: string; platform?: string } = {}) {
  const platform = probe.platform ?? 'linux',
    home = platform === 'win32' ? 'C:\\Users\\test home' : '/test home'
  const at = (...parts: string[]) =>
    [home, '.local', 'share', 'pixelsky', 'remote', ...parts].join(platform === 'win32' ? '\\' : '/')
  await mkdir(resolve('../../scratch'), { recursive: true })
  const dir = await mkdtemp(join(resolve('../../scratch'), 'ssh-transport-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const helper = join(dir, 'helper.cjs')
  await writeFile(helper, '// helper test')
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' })
  const clients = new Set<Connection>(),
    forwards = new Set<Server>(),
    peers = new Set<RpcPeer>()
  let executed = 0,
    uploaded = '',
    cliInstalled = false
  const commands: string[] = [],
    cliCalls: string[] = []
  const ssh = new SshServer({ hostKeys: [key] }, client => {
    clients.add(client)
    client.on('error', () => {})
    client.on('authentication', context =>
      context.method === 'password' && context.password === 'test-password' ? context.accept() : context.reject(),
    )
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const socket = connect(info.destPort, info.destIP)
        socket.once('error', reject)
        socket.once('connect', () => {
          const stream = accept()
          socket.on('error', () => stream.destroy())
          stream.on('error', () => socket.destroy())
          socket.pipe(stream).pipe(socket)
        })
      })
      client.on('request', (accept, reject, name, info) => {
        if (name !== 'tcpip-forward') {
          reject?.()
          return
        }
        const forward = createServer(socket =>
          client.forwardOut(
            info.bindAddr,
            (forward.address() as { port: number }).port,
            socket.remoteAddress!,
            socket.remotePort!,
            (error, channel) => {
              if (error) {
                socket.destroy()
                return
              }
              socket.on('error', () => channel.destroy())
              channel.on('error', () => socket.destroy())
              socket.pipe(channel).pipe(socket)
            },
          ),
        )
        forwards.add(forward)
        forward.listen(0, '127.0.0.1', () => accept?.((forward.address() as { port: number }).port))
      })
      client.on('session', accept =>
        accept().on('exec', (accept, _reject, info) => {
          executed++
          commands.push(info.command)
          const command = decodeNodeScript(info.command)
          const stream = accept()
          if (command.includes('process.stdout.write(JSON.stringify')) {
            stream.write(
              JSON.stringify({
                home,
                platform,
                version: probe.version ?? '22.0.0',
                arch: probe.arch,
              }),
            )
            stream.exit(0)
            stream.end()
            return
          }
          // 命令行包：检查脚本带 .complete，安装脚本多一个 gunzipSync；这里假装远程的 node 照做
          if (command.includes('.complete')) {
            const entry = at('cli-' + /cli-([a-f0-9]{64})/.exec(command)![1], 'pixel.mjs')
            if (!command.includes('gunzipSync')) {
              cliCalls.push('check')
              if (cliInstalled) stream.write(entry)
              stream.exit(0)
              stream.end()
              return
            }
            const chunks: Buffer[] = []
            stream.on('data', (chunk: Buffer) => chunks.push(chunk))
            stream.on('end', () => {
              cliCalls.push('install:' + Buffer.concat(chunks).toString())
              cliInstalled = true
              stream.write(entry)
              stream.exit(0)
              stream.end()
            })
            return
          }
          if (command.includes('Buffer.concat')) {
            const chunks: Buffer[] = []
            stream.on('data', (chunk: Buffer) => chunks.push(chunk))
            stream.on('end', () => {
              const data = Buffer.concat(chunks)
              uploaded = data.toString()
              const hash = createHash('sha256').update(data).digest('hex')
              stream.write(at('v' + REMOTE_PROTOCOL, 'helper-' + hash + '.cjs'))
              stream.exit(0)
              stream.end()
            })
            return
          }
          const peer = new RpcPeer(stream, stream, method => {
            if (method !== 'hello') throw new Error('Unsupported')
            return {
              protocol: REMOTE_PROTOCOL,
              platform,
              home,
              arch: 'x64',
              hostname: 'test',
              node: '22.0.0',
              shell: platform === 'win32' ? 'powershell.exe' : '/bin/sh',
            }
          })
          peers.add(peer)
        }),
      )
    })
  })
  await new Promise<void>(r => ssh.listen(0, '127.0.0.1', r))
  cleanup.push(() => {
    peers.forEach(p => p.close())
    clients.forEach(c => c.end())
    forwards.forEach(f => f.close())
    ssh.close()
  })
  const config: MachineInput = {
    host: '127.0.0.1',
    port: (ssh.address() as { port: number }).port,
    name: 'Test',
    username: 'test',
    auth: 'password',
    password: 'test-password',
  }
  return { config, helper, stats: () => ({ executed, uploaded, commands, cliCalls }) }
}
describe('SSH trust and loopback transport', () => {
  it('rejects an untrusted key before executing commands, then connects and forwards both directions', async () => {
    const target = await server(),
      untrusted = new SshConnection()
    cleanup.push(() => untrusted.close())
    let fingerprint: string
    try {
      await untrusted.connect(target.config, null, undefined, target.helper, () => {})
      throw new Error('Unexpected trust')
    } catch (error) {
      expect(error).toBeInstanceOf(FingerprintRequired)
      fingerprint = (error as FingerprintRequired).fingerprint
    }
    expect(target.stats().executed).toBe(0)
    untrusted.close()
    const trusted = new SshConnection()
    cleanup.push(() => trusted.close())
    expect((await trusted.connect(target.config, fingerprint, undefined, target.helper, () => {})).platform).toBe(
      'linux',
    )
    expect(target.stats().uploaded).toBe('// helper test')
    const echo = createServer(socket => socket.pipe(socket))
    cleanup.push(() => {
      echo.close()
    })
    await new Promise<void>(r => echo.listen(0, '127.0.0.1', r))
    const port = (echo.address() as { port: number }).port
    const request = (port: number) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1')
        socket.setTimeout(2000, () => {
          socket.destroy()
          reject(new Error('echo timeout'))
        })
        socket.on('error', reject)
        socket.on('connect', () => socket.write('ssh-roundtrip'))
        socket.on('data', data => {
          resolve(data.toString())
          socket.destroy()
        })
      })
    expect(await request(await trusted.forwardPort(port))).toBe('ssh-roundtrip')
    expect(await request(await trusted.forwardGateway(port))).toBe('ssh-roundtrip')
    expect(await trusted.forwardGateway(port)).toBe(await trusted.forwardGateway(port))
  }, 15_000)
  it('quotes remote paths without interpreting shell substitutions', () => {
    expect(quoteSh("/tmp/a'b $(touch bad)")).toBe("'/tmp/a'\\''b $(touch bad)'")
  })
  it('node 脚本编码成 base64：命令里没有 sh / cmd / PowerShell 会展开的字符', () => {
    const script = `process.stdout.write("a'b $HOME %PATH% \`x\` \\\\")`
    const command = nodeScript(script)
    expect(command).not.toMatch(/[$%`\\]/)
    expect(decodeNodeScript(command)).toBe(script)
  })
  it('Windows 终端：PowerShell 用 -EncodedCommand 进目录，cmd 也由 PowerShell 进目录后再起', () => {
    const ps = windowsShellCommand("C:\\Users\\a'b\\proj", 'powershell.exe')
    const encoded = /-EncodedCommand (\S+)$/.exec(ps)![1]
    expect(ps.startsWith('powershell.exe -NoLogo -NoExit ')).toBe(true)
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe("Set-Location -LiteralPath 'C:\\Users\\a''b\\proj'")
    expect(windowsShellCommand('C:\\proj', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe').startsWith('pwsh.exe ')).toBe(
      true,
    )
    // 路径里的 % 不能被 cmd 当成变量：整段编码交给 PowerShell，命令行里只有 base64
    const cmd = windowsShellCommand("C:\\my %PATH% a'b", 'C:\\Windows\\system32\\cmd.exe')
    expect(cmd.startsWith('powershell.exe -NoLogo -NoProfile -EncodedCommand ')).toBe(true)
    expect(cmd).not.toContain('%')
    expect(Buffer.from(/-EncodedCommand (\S+)$/.exec(cmd)![1], 'base64').toString('utf16le')).toBe(
      "Set-Location -LiteralPath 'C:\\my %PATH% a''b'; & cmd.exe /d; exit $LASTEXITCODE",
    )
  })
  it('连 Windows 远端：上传 helper、装命令行，helper 用 node -e 设好参数再加载', async () => {
    const target = await server({ platform: 'win32', version: '22.19.0', arch: 'x64' })
    const probe = new SshConnection()
    cleanup.push(() => probe.close())
    const fingerprint = await probe
      .connect(target.config, null, undefined, target.helper, () => {})
      .then(
        () => '',
        (error: FingerprintRequired) => error.fingerprint,
      )
    probe.close()
    const link = new SshConnection()
    cleanup.push(() => link.close())
    const archive = { data: Buffer.from('archive-bytes'), hash: createHash('sha256').update('x').digest('hex') }
    const platforms: Array<string | undefined> = []
    link.cliArchive = async (_arch, platform) => {
      platforms.push(platform)
      return archive
    }
    const hello = await link.connect(target.config, fingerprint, undefined, target.helper, () => {})
    expect(hello.platform).toBe('win32')
    expect(platforms).toEqual(['win32'])
    const base = 'C:\\Users\\test home\\.local\\share\\pixelsky\\remote\\'
    const launch = decodeNodeScript(target.stats().commands.at(-1)!)
    expect(launch).toBe(
      'process.argv=[process.execPath,...' +
        JSON.stringify([
          base +
            'v' +
            REMOTE_PROTOCOL +
            '\\helper-' +
            createHash('sha256').update('// helper test').digest('hex') +
            '.cjs',
          'default',
          base + 'cli-' + archive.hash + '\\pixel.mjs',
        ]) +
        '];require(process.argv[1])',
    )
    // 每条命令都是编码过的 node 脚本，不依赖远端 shell 是 sh 还是 cmd / PowerShell
    for (const command of target.stats().commands) expect(command.startsWith('node -e "eval(')).toBe(true)
  }, 15_000)
  it('blocks changed host keys and wrong credentials before upload', async () => {
    const target = await server(),
      changed = new SshConnection()
    cleanup.push(() => changed.close())
    let fingerprint: string
    try {
      await changed.connect(target.config, 'SHA256:old-key', undefined, target.helper, () => {})
      throw new Error('Unexpected trust')
    } catch (error) {
      expect(error).toBeInstanceOf(FingerprintRequired)
      expect((error as FingerprintRequired).changed).toBe(true)
      fingerprint = (error as FingerprintRequired).fingerprint
    }
    expect(target.stats().executed).toBe(0)
    changed.close()
    const incorrect = new SshConnection()
    cleanup.push(() => incorrect.close())
    await expect(
      incorrect.connect({ ...target.config, password: 'wrong' }, fingerprint, undefined, target.helper, () => {}),
    ).rejects.toThrow()
    expect(target.stats().executed).toBe(0)
  }, 15_000)
  it('握手中途被断开（发了 banner 就关）：connect 报连接已断开，不一直挂着', async () => {
    const sockets = new Set<import('node:net').Socket>()
    const half = createServer(socket => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.write('SSH-2.0-Fake_1.0\r\n')
      setTimeout(() => socket.destroy(), 50)
    })
    await new Promise<void>(r => half.listen(0, '127.0.0.1', r))
    cleanup.push(() => {
      for (const s of sockets) s.destroy()
      half.close()
    })
    const link = new SshConnection()
    cleanup.push(() => link.close())
    const input: MachineInput = {
      name: 'half',
      host: '127.0.0.1',
      port: (half.address() as { port: number }).port,
      username: 'u',
      auth: 'password',
      password: 'p',
    } as MachineInput
    await expect(link.connect(input, null, undefined, '', () => {})).rejects.toThrow()
  }, 10_000)
  it('本机转发端口：同一远程端口并发只开一个；关闭后不再开，开监听期间关闭的也关掉', async () => {
    const link = new SshConnection()
    const listening = (port: number) =>
      new Promise<boolean>(resolve => {
        const socket = connect(port, '127.0.0.1')
        socket.on('connect', () => {
          socket.destroy()
          resolve(true)
        })
        socket.on('error', () => resolve(false))
      })
    const [a, b] = await Promise.all([link.forwardPort(4321), link.forwardPort(4321)])
    expect(a).toBe(b)
    const inner = link as unknown as { localForwards: Map<number, Promise<Server>> }
    expect(inner.localForwards.size).toBe(1)
    const racing = link.forwardPort(4322)
    link.close()
    await expect(racing).rejects.toThrow('SSH_CONNECTION_CLOSED')
    await expect(link.forwardPort(4323)).rejects.toThrow('SSH_CONNECTION_CLOSED')
    await new Promise(r => setTimeout(r, 20))
    expect(await listening(a)).toBe(false)
  })
})

describe('SSH 下发像素星空命令行', () => {
  const archive = {
    data: Buffer.from('archive-bytes'),
    hash: createHash('sha256').update('archive-bytes').digest('hex'),
  }
  const entry = '/test home/.local/share/pixelsky/remote/cli-' + archive.hash + '/pixel.mjs'
  async function open(target: Awaited<ReturnType<typeof server>>, cliArchive: SshConnection['cliArchive']) {
    const probe = new SshConnection()
    cleanup.push(() => probe.close())
    const fingerprint = await probe
      .connect(target.config, null, undefined, target.helper, () => {})
      .then(
        () => '',
        (error: FingerprintRequired) => error.fingerprint,
      )
    probe.close()
    const link = new SshConnection()
    cleanup.push(() => link.close())
    link.cliArchive = cliArchive
    await link.connect(target.config, fingerprint, undefined, target.helper, () => {})
    return target.stats().commands.at(-1)!
  }

  it('Node 够新就上传一次，helper 带上入口路径；第二次连接只检查不重传', async () => {
    const target = await server({ version: '22.19.0', arch: 'x64' })
    const asked: string[] = []
    const provide: SshConnection['cliArchive'] = async arch => {
      asked.push(arch)
      return archive
    }
    const first = await open(target, provide)
    expect(first.endsWith(" 'default' '" + entry + "'")).toBe(true)
    expect(asked).toEqual(['x64'])
    expect(target.stats().cliCalls).toEqual(['check', 'install:archive-bytes'])
    const second = await open(target, provide)
    expect(second.endsWith("'" + entry + "'")).toBe(true)
    expect(target.stats().cliCalls).toEqual(['check', 'install:archive-bytes', 'check'])
  }, 15_000)

  it('Node 不够新、架构不认识、没有包、打包失败：不下发，连接照常', async () => {
    for (const [probe, provide] of [
      [{ version: '22.18.0', arch: 'x64' }, async () => archive],
      [{ version: '22.19.0', arch: 'arm' }, async () => archive],
      [{ version: '22.19.0' }, async () => archive],
      [{ version: '22.19.0', arch: 'x64' }, async () => null],
      [
        { version: '22.19.0', arch: 'x64' },
        async () => {
          throw new Error('pack failed')
        },
      ],
    ] as const) {
      const target = await server(probe)
      const command = await open(target, provide)
      expect(command.endsWith(" 'default'")).toBe(true)
      expect(target.stats().cliCalls).toEqual([])
    }
  }, 30_000)
})
