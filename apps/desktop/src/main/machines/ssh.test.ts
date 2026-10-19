import { afterEach, describe, expect, it } from 'vitest'
import { Server as SshServer, type Connection } from 'ssh2'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createServer, connect, type Server } from 'node:net'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { REMOTE_PROTOCOL } from '@pixelsky/protocol'
import { RpcPeer } from './rpc'
import { SshConnection, FingerprintRequired, quoteSh } from './ssh'
import type { MachineInput } from '../../shared/types/machines'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function server(probe: { version?: string; arch?: string } = {}) {
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
          const stream = accept()
          if (info.command.includes('process.stdout.write(JSON.stringify')) {
            stream.write(
              JSON.stringify({
                home: '/test home',
                platform: 'linux',
                version: probe.version ?? '22.0.0',
                arch: probe.arch,
              }),
            )
            stream.exit(0)
            stream.end()
            return
          }
          // 命令行包：检查脚本带 .complete，安装脚本多一个 gunzipSync；这里假装远程的 node 照做
          if (info.command.includes('.complete')) {
            const entry =
              '/test home/.local/share/pixelsky/remote/cli-' +
              /cli-([a-f0-9]{64})/.exec(info.command)![1] +
              '/pixel.mjs'
            if (!info.command.includes('gunzipSync')) {
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
          if (info.command.includes('Buffer.concat')) {
            const chunks: Buffer[] = []
            stream.on('data', (chunk: Buffer) => chunks.push(chunk))
            stream.on('end', () => {
              const data = Buffer.concat(chunks)
              uploaded = data.toString()
              const hash = createHash('sha256').update(data).digest('hex')
              stream.write('/test home/.local/share/pixelsky/remote/v' + REMOTE_PROTOCOL + '/helper-' + hash + '.cjs')
              stream.exit(0)
              stream.end()
            })
            return
          }
          const peer = new RpcPeer(stream, stream, method => {
            if (method !== 'hello') throw new Error('Unsupported')
            return {
              protocol: REMOTE_PROTOCOL,
              platform: 'linux',
              home: '/test home',
              arch: 'x64',
              hostname: 'test',
              node: '22.0.0',
              shell: '/bin/sh',
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
