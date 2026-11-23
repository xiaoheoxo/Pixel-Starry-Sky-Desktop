// oh-my-pi 的扩展注入（docs/omp-engine.md §12.3）：应用自己的工具（扩展）、用户的 MCP 和技能（插件目录）
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExtensionLaunch } from '@pixelsky/protocol'
import { ompLaunch } from '../src/omp/launch'
import { writeOmpPlan } from '../src/omp/plan-ext'
import { cleanOmpPlugins, writeOmpPlugin } from '../src/omp/plugin-dir'
import { OMP_TOOLS_ENV, writeOmpTools } from '../src/omp/tools-ext'
import { makeTmp, removeTmp } from './helpers/tmp'

let root: string, server: Server | undefined
const shared = globalThis as { __pixelskyOmpTools?: unknown; __pixelskyOmpPlan?: unknown }
beforeEach(() => {
  root = makeTmp('omp-ext')
})
afterEach(() => {
  server?.closeAllConnections()
  server?.close()
  server = undefined
  delete shared.__pixelskyOmpTools
  delete shared.__pixelskyOmpPlan
  delete process.env[OMP_TOOLS_ENV]
  delete process.env.PIXELSKY_OMP_PLAN
  removeTmp(root)
})

type Tool = {
  name: string
  approval: string
  loadMode: string
  parameters: unknown
  execute(id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown): Promise<unknown>
}
const load = async (file: string) =>
  (await import(`${pathToFileURL(file).href}?${Math.random()}`)).default as (pi: unknown) => Promise<void>
const pi = () => {
  const tools: Tool[] = [],
    handlers: Record<string, (event: unknown) => Promise<unknown>> = {}
  return {
    tools,
    handlers,
    registerTool: (t: Tool) => tools.push(t),
    on: (name: string, fn: (event: unknown) => Promise<unknown>) => (handlers[name] = fn),
    typebox: { Type: { Object: () => ({}), String: () => ({}) } },
  }
}

async function channel() {
  const calls: unknown[] = []
  server = createServer((req, res) => {
    let body = ''
    req
      .on('data', d => (body += d))
      .on('end', () => {
        const m = JSON.parse(body)
        calls.push([req.headers.authorization, m.method, m.params])
        const result =
          m.method === 'tools/list'
            ? {
                tools: [
                  { name: 'task_done', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
                  { name: 'channel_reply', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
                ],
              }
            : { content: [{ type: 'text', text: `做了 ${m.params.name}` }], isError: m.params.arguments.bad === true }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
      })
  })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  process.env[OMP_TOOLS_ENV] = JSON.stringify([
    { name: 'pixelsky_channel', url, token: 'tok' },
    { name: 'gone', url: 'http://127.0.0.1:1/mcp', token: 'x' },
  ])
  return calls
}

describe('应用自己的工具', () => {
  it('注册成普通工具、不用确认；令牌读到就从环境里拿掉；连不上的服务不影响别的', async () => {
    const calls = await channel()
    const api = pi()
    await (
      await load(writeOmpTools(root))
    )(api)
    expect(process.env[OMP_TOOLS_ENV]).toBeUndefined()
    expect(api.tools.map(t => [t.name, t.approval, t.loadMode])).toEqual([
      ['mcp__pixelsky_channel__task_done', 'read', 'essential'],
      ['mcp__pixelsky_channel__channel_reply', 'read', 'essential'],
    ])
    await expect(api.tools[1].execute('1', { text: 'hi' })).resolves.toMatchObject({
      content: [{ type: 'text', text: '做了 channel_reply' }],
    })
    expect(calls.at(-1)).toEqual(['Bearer tok', 'tools/call', { name: 'channel_reply', arguments: { text: 'hi' } }])
    await expect(api.tools[1].execute('1', { bad: true })).rejects.toThrow('做了 channel_reply')
  })

  it('交付、提问的只留给主智能体；子智能体再挂一份扩展时不重新列工具', async () => {
    const calls = await channel()
    const extension = await load(writeOmpTools(root))
    await extension(pi())
    const child = pi()
    await extension(child)
    expect(child.tools).toHaveLength(2)
    expect(calls.filter(c => (c as string[])[1] === 'tools/list')).toHaveLength(1)
    const [done, reply] = child.tools
    const sub = { agent: { kind: 'sub' } }
    await expect(done.execute('1', {}, undefined, undefined, sub)).rejects.toThrow('main agent')
    await expect(reply.execute('1', {}, undefined, undefined, sub)).resolves.toBeTruthy()
    await expect(done.execute('1', {}, undefined, undefined, { agent: { kind: 'main' } })).resolves.toBeTruthy()
  })

  it('计划档：只读标记的放行，写的和别的 MCP 拦', async () => {
    await channel()
    process.env.PIXELSKY_OMP_PLAN = '1'
    await (
      await load(writeOmpTools(root))
    )(pi())
    const plan = pi()
    await (
      await load(writeOmpPlan(root))
    )(plan)
    const call = (toolName: string) => plan.handlers.tool_call({ toolName })
    expect(await call('mcp__pixelsky_channel__task_done')).toBeUndefined()
    expect(await call('mcp__pixelsky_channel__channel_reply')).toMatchObject({ block: true })
    expect(await call('mcp__pixelsky_user_look')).toMatchObject({ block: true })
  })
})

describe('插件目录', () => {
  const skill = (name: string, parent = 'src') => {
    const dir = join(root, parent, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`)
    return dir
  }
  it('MCP 原样放进去，技能用联接、同名的改名；删掉时不碰技能原来的目录', () => {
    const a = skill('a'),
      other = skill('a', 'src2')
    const mcpFile = join(root, 'mcp.json')
    const servers = { usr: { type: 'http', url: 'http://x', headers: { key: 'se$cret' } } }
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }))
    const made = writeOmpPlugin(join(root, 'plugins'), {
      mcpFile,
      skillRoots: [a, other, a, join(root, 'no-skill')],
    })!
    expect(JSON.parse(readFileSync(join(made.dir, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: servers })
    expect(JSON.parse(readFileSync(join(made.dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('pixelsky')
    expect(readdirSync(join(made.dir, 'skills')).sort()).toEqual(['a', 'a-2'])
    expect(existsSync(join(made.dir, 'skills', 'a-2', 'SKILL.md'))).toBe(true)
    made.remove()
    expect(existsSync(made.dir)).toBe(false)
    expect(existsSync(join(a, 'SKILL.md'))).toBe(true)
    expect(writeOmpPlugin(join(root, 'plugins'), { skillRoots: [] })).toBeNull()
  })
  it('上次没删成的清掉，技能原来的目录还在', () => {
    const a = skill('a')
    const plugins = join(root, 'plugins')
    writeOmpPlugin(plugins, { skillRoots: [a] })
    cleanOmpPlugins(plugins)
    expect(readdirSync(plugins)).toEqual([])
    expect(existsSync(join(a, 'SKILL.md'))).toBe(true)
  })
})

describe('启动参数', () => {
  const record = { model: 'm', provider: null } as never
  const ext: ExtensionLaunch = {
    key: 'k',
    pluginDirs: [],
    pathDirs: ['/tools'],
    env: { SECRET: 's' },
    ownTools: [{ name: 'pixelsky_history', url: 'http://h', token: 't' }],
  }
  const options = {
    toolsFile: () => '/x/tools.mjs',
    pluginDir: () => ({ dir: '/x/plugin', remove: () => {} }),
    configFile: () => '/x/o.yml',
  }
  it('带上扩展、环境、PATH 和插件目录；没有要给的不带，也不留外面带进来的令牌', () => {
    const on = ompLaunch({ PATH: '/bin' }, record, 'ask', ext, options)
    expect(on.args).toEqual(expect.arrayContaining(['-e', '/x/tools.mjs', '--plugin-dir', '/x/plugin']))
    expect(on.env).toMatchObject({ SECRET: 's' })
    expect(on.env.PATH).toMatch(/^\/tools/)
    expect(JSON.parse(on.env[OMP_TOOLS_ENV]!)).toEqual(ext.ownTools)
    expect(on.cleanup).toBeTypeOf('function')
    const off = ompLaunch({ [OMP_TOOLS_ENV]: 'x' }, record, 'ask', undefined, options)
    expect(off.args).not.toContain('--plugin-dir')
    expect(off.env[OMP_TOOLS_ENV]).toBeUndefined()
  })
  it('队友派来的活（strictMcp）不给插件目录', () => {
    expect(ompLaunch({}, record, 'ask', { ...ext, strictMcp: true }, options).args).not.toContain('--plugin-dir')
  })
})
