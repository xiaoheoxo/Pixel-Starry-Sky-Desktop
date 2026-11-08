// 真 CLI + 本机 Responses 服务：不访问真实模型或账号，验证普通请求与压缩的实际请求体。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('real Pixel CLI sends explicit tiers and resets compaction to ordinary after switching off', async () => {
  const scratch = fileURLToPath(new URL('../../../scratch/', import.meta.url))
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, '2026-11-08-pixel-speed-rpc-'))
  const tiers: unknown[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    tiers.push(JSON.parse(body).service_tier)
    const tier = JSON.parse(body).service_tier
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const item = {
      type: 'message',
      id: 'msg',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Completed summary.', annotations: [] }],
    }
    const response = {
      id: 'resp',
      status: 'completed',
      output: [item],
      service_tier: tier,
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    }
    for (const event of [
      { type: 'response.created', response: { ...response, output: [], status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
      {
        type: 'response.content_part.added',
        item_id: 'msg',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg',
        output_index: 0,
        content_index: 0,
        delta: 'Completed summary.',
      },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  let child: ChildProcessWithoutNullStreams | undefined
  let errors = ''
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as { port: number }
    const baseUrl = `http://127.0.0.1:${address.port}/v1`
    const extension = join(dir, 'provider.mjs')
    writeFileSync(
      extension,
      `export default pi => pi.on('session_start', (_event, ctx) => {
      const original = ctx.modelRegistry.getProvider('openai');
      const model = {...original.getModels().find(m => m.api === 'openai-responses'), id:'speed-test',provider:'speed-test',baseUrl:${JSON.stringify(baseUrl)}, serviceTiers:['priority','ultrafast']};
      ctx.modelRegistry.registerProvider({...original, id:'speed-test',baseUrl:${JSON.stringify(baseUrl)}, getModels:()=>[model],getAllModels:()=>[model]});
    });`,
    )
    const env = {
      ...process.env,
      PIXELSKY_CODING_AGENT_DIR: join(dir, 'agent'),
      OPENAI_API_KEY: 'local-test-key',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    }
    mkdirSync(env.PIXELSKY_CODING_AGENT_DIR)
    writeFileSync(
      join(env.PIXELSKY_CODING_AGENT_DIR, 'settings.json'),
      JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 100 } }),
    )
    for (const key of Object.keys(env))
      if (/^(ANTHROPIC_|PIXELSKY_PIXEL_|PIXELSKY_SUBAGENT_|OPENAI_BASE_URL|ELECTRON_RUN_AS_NODE)/.test(key))
        delete env[key as keyof typeof env]
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), '--mode', 'rpc', '--no-session', '-e', extension],
      { cwd: dir, env, windowsHide: true, stdio: 'pipe' },
    )
    child.stderr.on('data', d => {
      errors += String(d)
    })
    let seq = 0,
      buffer = '',
      settled = 0
    const reports: Record<string, unknown>[] = []
    const pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>()
    child.stdout.on('data', data => {
      buffer += String(data)
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let event: Record<string, unknown>
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'response') {
          const waiter = pending.get(String(event.id))
          pending.delete(String(event.id))
          if (event.success === false) waiter?.reject(new Error(String(event.error)))
          else waiter?.resolve(event)
        }
        if (event.type === 'agent_settled') settled++
        if (event.statusKey === 'pixelsky-speed') reports.push(JSON.parse(String(event.statusText)))
      }
    })
    const rpc = (type: string, args: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = String(++seq)
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`RPC ${type} timed out: ${errors}`))
        }, 10000)
        pending.set(id, {
          resolve: value => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: error => {
            clearTimeout(timer)
            reject(error)
          },
        })
        child!.stdin.write(JSON.stringify({ type, id, ...args }) + '\n')
      })
    await rpc('get_state')
    await rpc('set_model', { provider: 'speed-test', modelId: 'speed-test' })
    for (const [i, speed] of ['fast', 'ultrafast', 'off'].entries()) {
      await rpc('prompt', { message: `/pixelsky-speed ${speed} test-${i}` })
      expect(reports.at(-1), errors).toMatchObject({ req: `test-${i}`, error: '', speed })
      await rpc('prompt', { message: 'Summarize briefly.' })
      await expect.poll(() => settled, { timeout: 10000 }).toBe(i + 1)
    }
    await rpc('compact')
    expect(tiers.slice(0, 3), errors).toEqual(['priority', 'ultrafast', 'default'])
    expect(tiers.length).toBeGreaterThan(3)
    expect(tiers.slice(3).every(tier => tier === 'default')).toBe(true)
    expect(reports.some(r => r.actualTier === 'ultrafast')).toBe(true)
  } finally {
    child?.kill()
    if (child && child.exitCode === null) await once(child, 'close')
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}, 25000)
