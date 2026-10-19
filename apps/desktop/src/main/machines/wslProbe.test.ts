import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  PROBE_SCRIPT,
  parseProbe,
  pickNode,
  probeArgs,
  readyToConnect,
  wslCheckItems,
  type WslProbe,
  type WslProbeCli,
  type WslProbeNode,
} from './wslProbe'

const node = (over: Partial<WslProbeNode> = {}): WslProbeNode => ({
  source: 'usr',
  path: '/usr/bin/node',
  windows: false,
  version: '22.11.0',
  platform: 'linux',
  ...over,
})
const cli = (over: Partial<WslProbeCli> = {}): WslProbeCli => ({
  path: '/home/x/.local/bin/claude',
  real: '/home/x/.local/share/claude/claude',
  mnt: false,
  mz: false,
  version: '2.1.5 (Claude Code)',
  ...over,
})
const probe = (over: Partial<WslProbe> = {}): WslProbe => ({
  pretty: 'Debian GNU/Linux 12',
  kernel: '5.15.0-microsoft-standard-WSL2',
  distro: 'Debian',
  shell: '/bin/bash',
  home: '/home/x',
  charmap: 'UTF-8',
  arch: 'x64',
  nodes: [node()],
  claude: [cli()],
  codex: [],
  login: { claude: true, codex: false },
  ...over,
})
const find = (items: ReturnType<typeof wslCheckItems>, key: string) => items.find(i => i.key === key)!

describe('parseProbe', () => {
  it('从带噪音的输出里挑最后一行 JSON', () => {
    const out =
      'welcome\nPIXELSKY_PROBE={"home":"/old"}\nnoise\r\nPIXELSKY_PROBE={"home":"/home/x","nodes":[]}\r\ntail\n'
    expect(parseProbe(out)?.home).toBe('/home/x')
  })
  it('uname -m 归一成 x64 / arm64，认不出的是 null', () => {
    const arch = (raw: unknown) => parseProbe('PIXELSKY_PROBE=' + JSON.stringify({ arch: raw }))?.arch
    expect(arch('x86_64')).toBe('x64')
    expect(arch('amd64')).toBe('x64')
    expect(arch('aarch64')).toBe('arm64')
    expect(arch('arm64')).toBe('arm64')
    expect(arch('armv7l')).toBeNull()
    expect(arch('i686')).toBeNull()
    expect(arch(null)).toBeNull()
    expect(arch(5)).toBeNull()
    expect(parseProbe('PIXELSKY_PROBE={}')?.arch).toBeNull()
  })
  it('没有标记或 JSON 坏了返回 null', () => {
    expect(parseProbe('nothing')).toBeNull()
    expect(parseProbe('PIXELSKY_PROBE={bad')).toBeNull()
  })
})

describe('wslCheckItems', () => {
  it('全部满足时可以连接', () => {
    const items = wslCheckItems(probe())
    expect(items.map(i => i.key)).toEqual(['start', 'encoding', 'node', 'claude', 'codex', 'login'])
    expect(readyToConnect(items)).toBe(true)
    expect(find(items, 'login').detail).toBe('claude')
  })
  it('探测为空或启动出错时 start 失败', () => {
    expect(wslCheckItems(null)[0]).toMatchObject({ key: 'start', status: 'fail', code: 'WSL_START_FAILED' })
    const items = wslCheckItems(probe(), 'WSL_TIMEOUT')
    expect(items[0]).toMatchObject({ code: 'WSL_START_FAILED', detail: 'WSL_TIMEOUT' })
    expect(readyToConnect(items)).toBe(false)
  })
  it('非 UTF-8 编码只是提示', () => {
    const items = wslCheckItems(probe({ charmap: 'ANSI_X3.4-1968' }))
    expect(find(items, 'encoding')).toMatchObject({ status: 'info', code: 'ENCODING_NOT_UTF8' })
    expect(readyToConnect(items)).toBe(true)
    expect(find(wslCheckItems(probe({ charmap: '' })), 'encoding')).toMatchObject({ code: 'ENCODING_UNKNOWN' })
  })
  it('Linux 版 node 跑不起来时报 NODE_BROKEN 并带路径', () => {
    const items = wslCheckItems(probe({ nodes: [node({ version: null, platform: null })] }))
    expect(find(items, 'node')).toMatchObject({ status: 'fail', code: 'NODE_BROKEN', detail: '/usr/bin/node' })
  })
  it('用户指定的 node 太旧时报 NODE_OLD，不换成别的', () => {
    const nodes = [
      node({ source: 'env', path: '/opt/node/bin/node', version: '18.0.0' }),
      node({ source: 'nvm', path: '/home/x/.nvm/versions/node/v22.3.0/bin/node', version: '22.3.0' }),
    ]
    expect(pickNode(probe({ nodes }))).toBeNull()
    expect(find(wslCheckItems(probe({ nodes })), 'node')).toMatchObject({
      code: 'NODE_OLD',
      detail: '18.0.0 (/opt/node/bin/node)',
    })
  })
  it('node 太旧', () => {
    const item = find(wslCheckItems(probe({ nodes: [node({ version: '18.19.0' })] })), 'node')
    expect(item).toMatchObject({ status: 'fail', code: 'NODE_OLD' })
    expect(item.fix).toContain('fnm')
    expect(item.detail).toContain('18.19.0')
  })
  it('只有 /mnt 下的 node 判 Windows 版', () => {
    const nodes = [node({ path: '/mnt/c/Program Files/nodejs/node', windows: true, version: null, platform: null })]
    expect(find(wslCheckItems(probe({ nodes })), 'node')).toMatchObject({ status: 'fail', code: 'NODE_WINDOWS' })
  })
  it('没有 node', () => {
    const items = wslCheckItems(probe({ nodes: [] }))
    expect(find(items, 'node').code).toBe('NODE_MISSING')
    expect(readyToConnect(items)).toBe(false)
  })
  it('Windows 版 claude 判 warn', () => {
    const claude = [cli({ path: '/mnt/c/Users/x/AppData/Roaming/npm/claude', real: null, mnt: true, version: null })]
    const item = find(wslCheckItems(probe({ claude })), 'claude')
    expect(item).toMatchObject({ status: 'warn', code: 'CLAUDE_WINDOWS' })
    expect(item.detail).toContain('/mnt/c/')
  })
  it('文件头是 MZ 也判 Windows 版', () => {
    const codex = [cli({ path: '/home/x/.npm-global/bin/codex', mz: true })]
    expect(find(wslCheckItems(probe({ codex })), 'codex').code).toBe('CODEX_WINDOWS')
  })
  it('Linux 版叫 claude.exe 但不是 MZ 判 ok', () => {
    const claude = [cli({ path: '/home/x/.npm-global/bin/claude.exe', mz: false })]
    expect(find(wslCheckItems(probe({ claude })), 'claude').status).toBe('ok')
  })
  it('Windows 版排在前面时仍用后面的 Linux 版', () => {
    const claude = [cli({ path: '/mnt/c/x/claude', mnt: true, version: null }), cli()]
    expect(find(wslCheckItems(probe({ claude })), 'claude').status).toBe('ok')
  })
  it('没装 claude / codex 只是 warn，给安装命令', () => {
    const items = wslCheckItems(probe({ claude: [] }))
    expect(find(items, 'claude')).toMatchObject({ status: 'warn', code: 'CLAUDE_MISSING' })
    expect(find(items, 'claude').fix).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(find(items, 'codex').fix).toBe('npm i -g @openai/codex')
    expect(readyToConnect(items)).toBe(true)
  })
})

describe('pickNode', () => {
  it('nvm 里多个版本取最高的', () => {
    const nodes = [
      node({ source: 'nvm', path: '/home/x/.nvm/versions/node/v18.20.0/bin/node', version: '18.20.0' }),
      node({ source: 'nvm', path: '/home/x/.nvm/versions/node/v22.3.0/bin/node', version: '22.3.0' }),
      node({ source: 'nvm', path: '/home/x/.nvm/versions/node/v22.11.0/bin/node', version: '22.11.0' }),
      node({ source: 'nvm', path: '/home/x/.nvm/versions/node/v8.17.0/bin/node', version: '8.17.0' }),
    ]
    expect(pickNode(probe({ nodes }))).toBe('/home/x/.nvm/versions/node/v22.11.0/bin/node')
  })
  it('用户指定的排在最前面', () => {
    const nodes = [node({ source: 'env', path: '/opt/node/bin/node', version: '24.0.0' }), node()]
    expect(pickNode(probe({ nodes }))).toBe('/opt/node/bin/node')
  })
  it('用户指定的路径不存在时不换别的 node，报 NODE_BROKEN', () => {
    const nodes = [node({ source: 'env', path: '/nope/node', version: null, platform: null }), node()]
    expect(pickNode(probe({ nodes }))).toBeNull()
    const item = wslCheckItems(probe({ nodes })).find(i => i.key === 'node')
    expect(item).toMatchObject({ status: 'fail', code: 'NODE_BROKEN', detail: '/nope/node' })
  })
  it('跳过 Windows 版和旧版本', () => {
    const nodes = [node({ windows: true, platform: null }), node({ version: '20.1.0' })]
    expect(pickNode(probe({ nodes }))).toBeNull()
    expect(pickNode(null)).toBeNull()
  })
})

const shOk = spawnSync('sh', ['-c', 'exit 0']).status === 0

describe('probeArgs', () => {
  it('node 路径用 env 传进去', () => {
    expect(probeArgs('Ubuntu')).toEqual(['-d', 'Ubuntu', '--cd', '~', '--exec', 'sh', '-s'])
    expect(probeArgs('Ubuntu', '/opt/n/bin/node').slice(5)).toEqual([
      'env',
      'PIXELSKY_NODE=/opt/n/bin/node',
      'sh',
      '-s',
    ])
  })
})

describe('PROBE_SCRIPT', () => {
  it.skipIf(!shOk)(
    '在本机 sh 下能跑并输出可解析的 JSON',
    () => {
      const result = spawnSync('sh', ['-s'], {
        input: PROBE_SCRIPT,
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, PIXELSKY_NODE: process.execPath },
      })
      const parsed = parseProbe(result.stdout)
      expect(parsed).not.toBeNull()
      expect(Array.isArray(parsed!.nodes)).toBe(true)
      expect(parsed!.nodes.length).toBeGreaterThan(0)
      expect(parsed!.nodes.find(n => n.source === 'env')?.path).toBe(process.execPath)
      expect(Array.isArray(parsed!.claude)).toBe(true)
      expect(typeof parsed!.login.claude).toBe('boolean')
      // uname -m：本机是 Windows 上的 sh（MSYS）时是 x86_64，Linux / mac 上也认得出；至少不能让输出坏掉
      expect(['x64', 'arm64', null]).toContain(parsed!.arch)
    },
    70000,
  )
  it.skipIf(!shOk)(
    'PIXELSKY_NODE 指向不存在的文件时仍输出 env 项',
    () => {
      const result = spawnSync('sh', ['-s'], {
        input: PROBE_SCRIPT,
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, PIXELSKY_NODE: '/nope/node' },
      })
      const env = parseProbe(result.stdout)!.nodes.find(n => n.source === 'env')
      expect(env).toMatchObject({ path: '/nope/node', version: null })
      expect(pickNode(parseProbe(result.stdout))).toBeNull()
    },
    70000,
  )
  it('不含会破坏模板字符串的写法', () => {
    expect(PROBE_SCRIPT).not.toContain('${')
    expect(PROBE_SCRIPT).not.toContain('`')
  })

  it('交互式 bash 只在 timeout 支持 --foreground 时跑（WSL 有控制终端，后台进程组里的 bash -ic 会被暂停卡住）', () => {
    expect(PROBE_SCRIPT).toContain('timeout --foreground -k 2')
    expect(PROBE_SCRIPT).not.toMatch(/timeout \d+ bash -ic/)
    expect(PROBE_SCRIPT).toMatch(/\[ \$FG = 1 \] && command -v bash/)
  })
})
