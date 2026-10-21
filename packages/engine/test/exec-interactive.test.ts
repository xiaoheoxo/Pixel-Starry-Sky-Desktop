import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { run, runInteractive } from '../src/exec'

const fake = fileURLToPath(new URL('./fakes/fake-login.mjs', import.meta.url))
const node = { command: process.execPath, args: [fake] }

describe('runInteractive', () => {
  it('不带换行的提示符也交出来，去掉颜色，只交一次；stdin 写入后命令结束', async () => {
    const lines: string[] = []
    const p = runInteractive(node, ['code'], process.env, l => lines.push(l))
    await new Promise<void>(resolve => {
      const t = setInterval(() => {
        if (lines.includes('Paste code here if prompted >')) {
          clearInterval(t)
          resolve()
        }
      }, 20)
    })
    p.write('abc\n')
    const r = await p.done
    expect(r.ok).toBe(true)
    expect(lines.filter(l => l.startsWith('Paste code'))).toHaveLength(1)
    expect(lines[0]).toMatch(/^If the browser didn't open, visit: https:/)
    expect(lines).toContain('got abc')
  })

  it('网址分两段到：先交出的半行不算数，补齐后交完整的一行', async () => {
    const lines: string[] = []
    const r = await runInteractive(node, ['split'], process.env, l => lines.push(l)).done
    expect(r.ok).toBe(true)
    expect(lines.at(-1)).toBe("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true")
  })

  it('kill 结束命令', async () => {
    const p = runInteractive(node, ['hang'], process.env, () => undefined)
    await new Promise(r => setTimeout(r, 300))
    p.kill()
    const r = await p.done
    expect(r.ok).toBe(false)
  })

  it('程序起不来：started 为 false', async () => {
    const p = runInteractive({ command: 'definitely-not-a-command-xyz', args: [] }, [], process.env, () => undefined)
    expect((await p.done).started).toBe(false)
  })
})

describe('run', () => {
  it('输出超过上限报「输出过大」，不当成超时', async () => {
    const r = await run(
      { command: process.execPath, args: [] },
      ['-e', "process.stdout.write('x'.repeat(5 * 1024 * 1024))"],
      process.env,
    )
    expect(r).toMatchObject({ ok: false, started: true, error: '输出过大' })
  })

  it('超时照旧报「超时」', async () => {
    const r = await run(
      { command: process.execPath, args: [] },
      ['-e', 'setTimeout(() => {}, 10000)'],
      process.env,
      200,
    )
    expect(r).toMatchObject({ ok: false, started: true, error: '超时' })
  })
})
