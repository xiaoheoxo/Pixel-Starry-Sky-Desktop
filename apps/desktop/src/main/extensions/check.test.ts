import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkMcp, launcher } from './check'
let root: string
beforeEach(() => {
  const scratch = resolve('../../scratch')
  mkdirSync(scratch, { recursive: true })
  root = mkdtempSync(join(scratch, 'mcp-check-'))
})
// Windows 上子进程（工作目录就是 root）被结束后句柄释放有延迟。rmSync 自带的 maxRetries 在满负载下仍偶发 EPERM，
// 这里自己重试约 3 秒，避免测试失败和在 scratch 留下空目录
afterEach(async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 30) throw error
      await new Promise(r => setTimeout(r, 100))
    }
  }
})
const result = (m: Record<string, unknown>): Record<string, unknown> | null =>
  m.method === 'initialize'
    ? {
        protocolVersion: (m.params as Record<string, unknown>).protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      }
    : m.method === 'tools/list'
      ? { tools: [{ name: 'fixture_tool', description: '本地检测工具', inputSchema: { type: 'object' } }] }
      : null
describe('MCP 只做初始化与工具列表', () => {
  it('stdio 能加载工具，退出关闭服务器进程', async () => {
    const fixture = join(root, 'server.cjs'),
      pidFile = join(root, 'pid')
    writeFileSync(
      fixture,
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const value=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[{name:'fixture_tool',inputSchema:{type:'object'}}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:value})+'\\n')})`,
    )
    const check = await checkMcp({ type: 'stdio', command: process.execPath, args: [fixture] }, root, 4000)
    expect(check.status, check.message).toBe('connected')
    expect(check.tools?.[0].name).toBe('fixture_tool')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await new Promise(r => setTimeout(r, 100))
    expect(() => process.kill(pid, 0)).toThrow()
  })
  it.each(['http', 'sse'] as const)('%s 使用真实传输完成 handshake / tools/list', async type => {
    let stream: ServerResponse | null = null
    const seen: string[] = []
    const server = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/sse') {
        stream = res
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write('event: endpoint\ndata: /messages\n\n')
        return
      }
      let body = ''
      for await (const chunk of req) body += chunk
      if (!body) {
        res.writeHead(405)
        res.end()
        return
      }
      const m = JSON.parse(body)
      seen.push(m.method)
      if (m.id === undefined) {
        res.writeHead(202)
        res.end()
        return
      }
      const response = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: result(m) })
      if (type === 'sse') {
        res.writeHead(202)
        res.end()
        stream?.write('event: message\ndata: ' + response + '\n\n')
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(response)
      }
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const check = await checkMcp(
        { type, url: `http://127.0.0.1:${port}/${type === 'sse' ? 'sse' : 'mcp'}` },
        root,
        4000,
      )
      expect(check.status, check.message).toBe('connected')
      expect(check).toMatchObject({ tools: [{ name: 'fixture_tool' }] })
      expect(seen).not.toContain('tools/call')
    } finally {
      ;(stream as ServerResponse | null)?.end()
      server.closeAllConnections()
      await new Promise<void>(r => server.close(() => r()))
    }
  })
  it('认证失败与超时明确返回，不把已配置当连接成功', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401)
      res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const check = await checkMcp(
        { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer private-token' } },
        root,
        2000,
      )
      expect(check.status, check.message).toBe('auth')
    } finally {
      server.closeAllConnections()
      await new Promise<void>(r => server.close(() => r()))
    }
    const fixture = join(root, 'hang.cjs')
    writeFileSync(fixture, 'setInterval(()=>{},1000)')
    const check = await checkMcp({ type: 'stdio', command: process.execPath, args: [fixture] }, root, 250)
    expect(check.status).toBe('error')
    expect(check.message).toContain('超时')
  })
})

describe.runIf(process.platform === 'win32')('Windows 批处理垫片', () => {
  const shim = (name: string, lines: string[], scripts: string[]): string => {
    for (const script of scripts) {
      mkdirSync(join(root, 'node_modules', 'npm', 'bin'), { recursive: true })
      writeFileSync(join(root, 'node_modules', 'npm', 'bin', script), '')
    }
    const file = join(root, name)
    writeFileSync(file, lines.join('\r\n'))
    return file
  }
  const script = (name: string): string => join(root, 'node_modules', 'npm', 'bin', name)

  it('npm 自带的 npx.cmd：运行 npx-cli.js，不是前面只打印目录的 npm-prefix.js', () => {
    const file = shim(
      'npx.cmd',
      [
        String.raw`SET "NPM_PREFIX_JS=%~dp0\node_modules\npm\bin\npm-prefix.js"`,
        String.raw`SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js"`,
        '"%NODE_EXE%" "%NPX_CLI_JS%" %*',
      ],
      ['npm-prefix.js', 'npx-cli.js'],
    )
    expect(launcher(file, ['-y', 'x@1.0.0'], process.env).args).toEqual([script('npx-cli.js'), '-y', 'x@1.0.0'])
  })

  it('全局包的垫片只有一个脚本：照旧', () => {
    const file = shim('tool.cmd', [String.raw`"%_prog%" "%dp0%\node_modules\npm\bin\cli.js" %*`], ['cli.js'])
    expect(launcher(file, ['a'], process.env).args).toEqual([script('cli.js'), 'a'])
  })

  it('任意批处理：没有脚本就报错，要用户写明解释器', () => {
    const file = shim('run.bat', ['echo hi'], [])
    expect(() => launcher(file, [], process.env)).toThrow('解释器')
  })
})
