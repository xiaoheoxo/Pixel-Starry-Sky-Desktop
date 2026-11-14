// 接着 agy 自己的会话：session/list 按项目过滤、session/load 回放翻成条目（docs/antigravity-engine.md §12）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { agyNativeSessions, agyProjectDirs, agyReadNative, replayItems } from '../src/antigravity/native'

const dir = mkdtempSync(join(tmpdir(), 'pixelsky-agy-native-'))
const project = join(dir, 'proj')
mkdirSync(join(project, 'sub'), { recursive: true })
const slash = (p: string): string => '/' + p.replace(/\\/g, '/')
const fake = join(dir, 'fake-agy.mjs')
writeFileSync(
  fake,
  `
import { createInterface } from 'node:readline'
const out = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const upd = u => out({ method: 'session/update', params: { sessionId: 'a1', update: u } })
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1 } })
  else if (m.method === 'session/list')
    m.params.cursor
      ? out({ id: m.id, result: { sessions: [
          { sessionId: 'a3', cwd: ${JSON.stringify(slash(join(project, 'sub')))}, title: 'sub', updatedAt: '2026-11-14T08:00:00Z' },
          { sessionId: 'a4', cwd: ${JSON.stringify(slash(join(dir, 'pixelsky-agy-Ab12Cd')))}, title: '', updatedAt: '2026-11-14T05:00:00Z' },
        ] } })
      : out({ id: m.id, result: { nextCursor: 'p2', sessions: [
          { sessionId: 'a1', cwd: ${JSON.stringify(slash(project))}, title: 'old', updatedAt: '2026-11-14T06:00:00Z' },
          { sessionId: 'a2', cwd: ${JSON.stringify(slash(dir))}, title: 'other', updatedAt: '2026-11-14T07:00:00Z' },
        ] } })
  else if (m.method === 'session/load') {
    if (m.params.sessionId !== 'a1') return out({ id: m.id, error: { code: -32603, message: 'session not found' } })
    upd({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '记住 4217' } })
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } })
    upd({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '是多少？' } })
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '4217' } })
    out({ id: m.id, result: {} })
  } else if (m.method === 'session/close') out({ id: m.id, result: {} })
})
`,
)
const launcher = { command: process.execPath, args: [fake] }
const env = { ...process.env, GEMINI_API_KEY: '' }
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('agy 原生会话', () => {
  it('列表翻完所有页，只留项目和子文件夹里的，新的在前', async () => {
    const list = await agyNativeSessions(launcher, [], env, project)
    expect(list.sessions.map(s => [s.id, s.subdir, s.title])).toEqual([
      ['a3', 'sub', 'sub'],
      ['a1', null, 'old'],
    ])
    expect(
      (await agyNativeSessions(launcher, [], env, project, { subfolders: false })).sessions.map(s => s.id),
    ).toEqual(['a1'])
  })

  it('项目导入：所有页里用过的工作目录，去重、转成本机路径，不算应用自己的临时会话', async () => {
    expect((await agyProjectDirs(launcher, [], env)).sort()).toEqual([dir, project, join(project, 'sub')].sort())
  })

  it('读一个会话：回放成用户 / 回复条目，轮数按用户消息算；会话不在了返回 null', async () => {
    const read = await agyReadNative(launcher, [], env, project, 'a1')
    expect(read?.items.map(i => [i.kind, (i as { text: string }).text])).toEqual([
      ['user', '记住 4217'],
      ['assistant', 'ok'],
      ['user', '是多少？'],
      ['assistant', '4217'],
    ])
    expect(read).toMatchObject({ turns: 2, shown: 2, title: '记住 4217', at: null })
    expect(await agyReadNative(launcher, [], env, project, 'gone')).toBeNull()
  })

  it('回放里同一条用户消息分几块时合成一条', () => {
    const items = replayItems(
      [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'a' } },
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'b' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'c' } },
      ],
      project,
    )
    expect(items.map(i => (i as { text: string }).text)).toEqual(['ab', 'c'])
  })
})
