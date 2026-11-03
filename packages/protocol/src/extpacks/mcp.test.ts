import { describe, expect, it } from 'vitest'
import { commandProblems, mcpServerProblems } from './mcp'

const codes = (raw: unknown): string[] => mcpServerProblems(raw, new Set()).map(p => p.code)
const cmd = (command: string, ...args: string[]): string[] => commandProblems(command, args).map(p => p.code)

const github = {
  name: 'github',
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'],
  inputs: [{ name: 'GITHUB_TOKEN', description: 'GitHub 个人令牌', secret: true, required: true }],
  source: 'https://github.com/modelcontextprotocol/servers',
}

describe('mcpServerProblems', () => {
  it('合格的 stdio / http 连接器没有问题', () => {
    expect(codes(github)).toEqual([])
    expect(
      codes({
        name: 'context7',
        type: 'http',
        url: 'https://mcp.context7.com/mcp',
        headers: { Authorization: 'Bearer ${API_KEY}' },
        inputs: [{ name: 'API_KEY', description: 'Context7 密钥' }],
        source: 'https://github.com/upstash/context7',
      }),
    ).toEqual([])
    expect(
      codes({ name: 'figma', type: 'sse', url: 'http://127.0.0.1:3845/sse', source: 'https://github.com/x/y' }),
    ).toEqual([])
  })

  it('字段：名字、来源、类型、重名', () => {
    expect(codes({ ...github, name: 'GitHub' })).toEqual(['mcp.fields'])
    expect(codes({ ...github, source: 'http://github.com/x' })).toEqual(['mcp.fields'])
    expect(codes({ ...github, source: undefined })).toEqual(['mcp.fields'])
    expect(codes({ ...github, type: 'ws' })).toEqual(['mcp.fields'])
    expect(codes('x')).toEqual(['mcp.fields'])
    const names = new Set<string>()
    mcpServerProblems(github, names)
    expect(mcpServerProblems(github, names).map(p => p.code)).toEqual(['mcp.fields'])
  })

  it('http：只收 https 或本机 http，不能带 command', () => {
    const http = { name: 'a', type: 'http', source: 'https://github.com/x/y' }
    expect(codes({ ...http, url: 'http://example.com/mcp' })).toEqual(['mcp.fields'])
    expect(codes({ ...http, url: 'https://x.dev/mcp', command: 'npx' })).toEqual(['mcp.fields'])
    expect(codes({ ...http, url: 'https://${HOST}/mcp' })).toEqual(['mcp.placeholder'])
  })

  it('stdio：命令白名单，不能带 url', () => {
    expect(codes({ ...github, command: 'node' })).toEqual(['mcp.command'])
    expect(codes({ ...github, command: 'cmd.exe' })).toEqual(['mcp.command'])
    expect(codes({ ...github, url: 'https://x.dev' })).toEqual(['mcp.fields'])
    expect(codes({ ...github, args: [1] })).toEqual(['mcp.fields'])
  })

  it('inputs：名字格式、重名、要有说明；占位只能引用声明过的', () => {
    expect(codes({ ...github, inputs: [{ name: 'token', description: 'x' }] })).toContain('mcp.inputs')
    expect(codes({ ...github, inputs: [{ name: 'A', description: '' }] })).toContain('mcp.inputs')
    expect(codes({ ...github, inputs: [{ name: 'A', description: 'x', secret: 'yes' }] })).toEqual(['mcp.inputs'])
    expect(
      codes({
        ...github,
        inputs: [
          { name: 'A', description: 'x' },
          { name: 'A', description: 'y' },
        ],
      }),
    ).toEqual(['mcp.inputs'])
    for (const name of ['NODE_OPTIONS', 'NPM_CONFIG_REGISTRY', 'UV_INDEX_URL', 'PATH'])
      expect(codes({ ...github, inputs: [{ name, description: 'x' }] })).toEqual(['mcp.inputs'])
    expect(codes({ ...github, args: [...github.args, '${ROOT}'] })).toEqual(['mcp.placeholder'])
    expect(
      codes({
        ...github,
        args: [...github.args, '${ROOT}'],
        inputs: [{ name: 'ROOT', description: '要开放的文件夹' }],
      }),
    ).toEqual([])
  })
})

describe('commandProblems', () => {
  it('npx：包要写死版本，-p 指定的也算', () => {
    expect(cmd('npx', '-y', 'pkg@1.2.3')).toEqual([])
    expect(cmd('npx', '-y', '@scope/pkg@1.2.3-beta.1', '--flag')).toEqual([])
    expect(cmd('npx', '-y', 'pkg')).toEqual(['mcp.unpinned'])
    expect(cmd('npx', 'pkg@latest')).toEqual(['mcp.unpinned'])
    expect(cmd('npx', 'pkg@^1.0.0')).toEqual(['mcp.unpinned'])
    expect(cmd('npx', '-p', 'pkg@1.0.0', 'pkg-bin')).toEqual([])
    expect(cmd('npx', '--package=pkg', 'pkg-bin')).toEqual(['mcp.unpinned'])
    expect(cmd('npx', '-y')).toEqual(['mcp.command'])
  })

  it('npx：不能换包源、不能 -c 跑 shell', () => {
    expect(cmd('npx', '--userconfig', 'x.npmrc', 'pkg@1.0.0')).toContain('mcp.command')
    expect(cmd('npx', '--registry', 'https://evil', 'pkg@1.0.0')).toContain('mcp.command')
    expect(cmd('npx', '-c', 'rm -rf /')).toContain('mcp.command')
  })

  it('uvx：name==x.y.z 或 name@x.y.z；--from / --with 也要写死', () => {
    expect(cmd('uvx', 'mcp-server-fetch==2025.4.7')).toEqual([])
    expect(cmd('uvx', 'mcp-server-fetch@2025.4.7')).toEqual([])
    expect(cmd('uvx', 'mcp-server-fetch')).toEqual(['mcp.unpinned'])
    expect(cmd('uvx', '--from', 'pkg[extra]==1.0.0', 'pkg-cmd')).toEqual([])
    expect(cmd('uvx', '--from', 'pkg', 'pkg-cmd')).toEqual(['mcp.unpinned'])
    expect(cmd('uvx', '--with', 'dep', 'pkg==1.0.0')).toEqual(['mcp.unpinned'])
    expect(cmd('uvx', '--python', '3.12', 'pkg==1.0.0')).toEqual([])
    expect(cmd('uvx', '--index-url', 'https://evil', 'pkg==1.0.0')).toContain('mcp.command')
  })

  it('docker：run + 镜像摘要；禁止提权', () => {
    const digest = 'ghcr.io/github/github-mcp-server@sha256:' + 'a'.repeat(64)
    expect(cmd('docker', 'run', '-i', '--rm', '-e', 'GITHUB_TOKEN', digest)).toEqual([])
    expect(cmd('docker', 'run', '-i', 'ghcr.io/github/github-mcp-server:v1')).toEqual(['mcp.unpinned'])
    expect(cmd('docker', 'pull', digest)).toEqual(['mcp.command'])
    expect(cmd('docker', 'run', '--privileged', digest)).toEqual(['mcp.command'])
  })
})
