import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHAT_PROJECT_ID, type Item, type SearchQuery } from '@pixelsky/protocol'
import { EngineHost } from '../src/host'
import { searchQuery, searchSessions } from '../src/search'

let root: string
let host: EngineHost
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-search-'))
  host = new EngineHost({ dataDir: root, emit: () => {}, adapters: {} })
})
afterEach(async () => {
  await host.shutdown()
  rmSync(root, { recursive: true, force: true })
})
const query = (text: string, scope: SearchQuery['scope'] = 'all', projectId: string | null = null): SearchQuery => ({
  requestId: 1,
  text,
  scope,
  projectId,
})
function record(title: string, items: Item[] = [], projectPath = root) {
  const p = host.addProject(projectPath),
    r = host.createSession({ projectId: p.id })
  // 通过存储写入标题与历史，构造重新启动后尚未打开的会话。
  const next = { ...r, title }
  writeFileSync(join(root, 'sessions', r.id, 'record.json'), JSON.stringify(next))
  writeFileSync(join(root, 'sessions', r.id, 'items.jsonl'), items.map(i => JSON.stringify(i)).join('\n') + '\n')
  return next
}
async function reopen() {
  await host.shutdown()
  host = new EngineHost({ dataDir: root, emit: () => {}, adapters: {} })
}
const reply = (id: string, text: string): Item => ({ kind: 'assistant', id, text, status: 'completed' })

describe('本机会话搜索', () => {
  it('搜索未打开的历史，中文、多词和符号均按字面匹配，不创建运行时', async () => {
    const r = record('查缓存', [reply('a', '命令输出 Cache (MISS) 与中文错误提示')])
    await reopen()
    expect((await host.search(query('cache (MISS)'))).results[0]).toMatchObject({
      sessionId: r.id,
      itemId: 'a',
      field: '助手回复',
    })
    expect((await host.search(query('错误 提示'))).results).toHaveLength(1)
    expect((await host.search(query('['))).results).toEqual([])
    expect((host as unknown as { runtimes: Map<string, unknown> }).runtimes.size).toBe(0)
  })

  it('同一条目只匹配最后版本；删除过时命中，坏行不阻塞后面的内容', async () => {
    const r = record('历史', [reply('a', '旧命中'), reply('b', '新命中')])
    const file = join(root, 'sessions', r.id, 'items.jsonl')
    appendFileSync(
      file,
      JSON.stringify(reply('a', '已经修正')) + '\nBAD JSON\n' + JSON.stringify(reply('b', '新命中最后版本')) + '\n',
    )
    await reopen()
    const result = await host.search(query('命中'))
    expect(result.results.map(r => r.itemId)).toEqual(['b'])
    expect(result.results[0].snippet.map(p => p.text).join('')).toBe('新命中最后版本')
    expect(result.partial).toBe(true)
  })

  it('实时快照优先于旧文件，排队原文和草稿不会作为已发送消息命中', async () => {
    const r = record('实时', [reply('a', '历史字词')])
    await reopen()
    host.open(r.id).items = [reply('a', '正在流式的新内容')]
    expect((await host.search(query('历史字词'))).results).toEqual([])
    expect((await host.search(query('新内容'))).results[0].itemId).toBe('a')
    host.open(r.id).queue = [
      {
        id: 'q',
        text: '还未发送',
        createdAt: 0,
        settings: { model: null, effort: null, platform: null },
        mode: 'normal',
        status: 'queued',
        error: null,
      },
    ]
    expect((await host.search(query('还未发送'))).results).toEqual([])
  })

  it('打开的会话：截过的长输出中间的词从磁盘搜到，省略说明不算；还在跑的条目搜内存里流式的文字', async () => {
    const command = (id: string, output: string, status: 'completed' | 'running' = 'completed'): Item => ({
      kind: 'command',
      id,
      command: 'build',
      description: null,
      output,
      exitCode: null,
      status,
    })
    const r = record('长输出', [command('c1', `${'x'.repeat(6000)}中间的关键字${'y'.repeat(6000)}`)])
    await reopen()
    const items = host.open(r.id).items
    expect(items[0]).toMatchObject({ cut: true })
    expect((await host.search(query('中间的关键字'))).results[0]).toMatchObject({ itemId: 'c1', field: '命令输出' })
    expect((await host.search(query('chars omitted'))).results).toEqual([])
    host.open(r.id).items = [...items, command('c2', '流式中的输出', 'running')]
    expect((await host.search(query('流式中的输出'))).results[0]).toMatchObject({ itemId: 'c2' })
  })

  it('范围和项目筛选正确，标题完全匹配优先于更新的正文', async () => {
    const path = join(root, 'another-project')
    mkdirSync(path)
    const exact = record('关键词', [reply('m', '不同正文')])
    const other = record('另外一个', [reply('o', '关键词在正文里')], path)
    await reopen()
    const result = await host.search(query('关键词'))
    expect(result.results[0].sessionId).toBe(exact.id)
    expect((await host.search(query('关键词', 'messages'))).results.map(r => r.sessionId)).toEqual([other.id])
    expect((await host.search(query('关键词', 'all', exact.projectId))).results).toHaveLength(1)
    expect((await host.search(query('another-project', 'titles'))).results[0].kind).toBe('project')
    expect((await host.search(query(path, 'titles'))).results[0].sessionId).toBe(other.id)
  })

  it('命令输出 / 工具摘要 / diff 命中携带实际条目 ID，不包含推理与用量', async () => {
    const r = record('工具测试', [
      {
        kind: 'command',
        id: 'cmd',
        command: 'npm run build',
        description: null,
        output: 'Build Error [42]',
        exitCode: 1,
        status: 'failed',
      },
      {
        kind: 'file_change',
        id: 'diff',
        changes: [{ path: 'src/app.ts', diff: '+ searchKeyword', kind: 'update', added: 1, removed: 0 }],
        status: 'completed',
      },
      { kind: 'reasoning', id: 'thought', text: 'Build Error [42]', status: 'completed' },
    ])
    await reopen()
    expect((await host.search(query('error [42]', 'tools'))).results[0]).toMatchObject({
      sessionId: r.id,
      itemId: 'cmd',
      field: '命令输出',
    })
    expect((await host.search(query('searchkeyword', 'tools'))).results[0]).toMatchObject({
      itemId: 'diff',
      field: '文件改动',
    })
    expect((await host.search(query('error [42]', 'messages'))).results).toHaveLength(0)
  })

  it('空词只返回最近十个会话，无正文 IO；超过限额时返回截断提示', async () => {
    for (let i = 0; i < 55; i++) record(`命中标题${i}`)
    await reopen()
    const recent = await host.search(query('  '))
    expect(recent.results).toHaveLength(10)
    const hits = await host.search(query('命中', 'titles'))
    expect(hits.results).toHaveLength(50)
    expect(hits.truncated).toBe(true)
  })

  it('单个历史文件读取失败只标 partial，其他记录仍有结果', async () => {
    const bad = record('坏文件'),
      good = record('正常文件', [reply('a', '找到内容')])
    rmSync(join(root, 'sessions', bad.id, 'items.jsonl'))
    mkdirSync(join(root, 'sessions', bad.id, 'items.jsonl'))
    await reopen()
    const response = await host.search(query('找到内容'))
    expect(response.partial).toBe(true)
    expect(response.results[0].sessionId).toBe(good.id)
  })

  it('大记录扫描可中途取消，事件循环保持可响应', async () => {
    const r = record('大记录')
    writeFileSync(
      join(root, 'sessions', r.id, 'items.jsonl'),
      Array.from({ length: 15000 }, (_, i) => JSON.stringify(reply(`i${i}`, '不会命中'.repeat(16)))).join('\n'),
    )
    await reopen()
    const controller = new AbortController(),
      task = host.search(query('target'), controller.signal)
    setTimeout(() => controller.abort(), 5)
    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('完整扫描约 20MB 历史仍让事件循环运行，只返回短摘要', async () => {
    const r = record('性能检查')
    writeFileSync(
      join(root, 'sessions', r.id, 'items.jsonl'),
      Array.from({ length: 8000 }, (_, i) =>
        JSON.stringify(reply(`i${i}`, '无关上下文。'.repeat(150) + (i === 7000 ? 'target' : ''))),
      ).join('\n'),
    )
    await reopen()
    let ticks = 0
    const timer = setInterval(() => ticks++, 1),
      start = performance.now()
    try {
      const result = await host.search(query('target'))
      expect(result.results).toHaveLength(1)
      expect(result.results[0].itemId).toBe('i7000')
      expect(JSON.stringify(result).length).toBeLessThan(2000)
      expect(ticks).toBeGreaterThan(0)
      console.log(`search scan: ${(performance.now() - start).toFixed(0)}ms, event loop yielded ${ticks} times`)
    } finally {
      clearInterval(timer)
    }
  })

  it('搜索期间已删除的会话被剔除', async () => {
    const r = record('删除目标', [reply('a', '目标')])
    await reopen()
    const controller = new AbortController()
    const results = await searchSessions(
      {
        dataDir: root,
        records: [r],
        projects: host.projects(),
        liveItems: () => undefined,
        body: (_, item) => item,
        exists: () => false,
      },
      query('目标'),
      controller.signal,
    )
    expect(results.results).toEqual([])
  })

  it('不用项目的对话写「对话」，项目移除了才写「已移除的项目」', async () => {
    const chat = host.createSession({ projectId: CHAT_PROJECT_ID })
    const gone = record('旧项目的会话')
    host.removeProject(gone.projectId)
    const names = new Map((await host.search(query(''))).results.map(r => [r.sessionId, r.projectName]))
    expect(names.get(chat.id)).toBe('对话')
    expect(names.get(gone.id)).toBe('已移除的项目')
  })

  it('从侧栏 Dot 组打开的对话不进搜索结果', async () => {
    const chat = host.createSession({ projectId: CHAT_PROJECT_ID })
    const dot = host.createSession({
      projectId: CHAT_PROJECT_ID,
      engine: 'dot',
      dot: { account: 'default', id: 'd', threadId: 't' },
    })
    const ids = (await host.search(query(''))).results.map(r => r.sessionId)
    expect(ids).toContain(chat.id)
    expect(ids).not.toContain(dot.id)
  })

  it('无数据目录保持空结果；输入不接受越界路径或任意正则范围', async () => {
    expect((await host.search(query(''))).results).toEqual([])
    expect(() => searchQuery({ ...query('text'), projectId: '../other' })).toThrow('无效')
    expect(() => searchQuery({ ...query('text'), scope: 'regex' })).toThrow('无效')
    expect(() => searchQuery({ ...query('text'), text: 'a'.repeat(201) })).toThrow('无效')
  })
})

describe('按会话合并要用的命中总数（docs/ui/conversation-ux-2.md §2.5）', () => {
  it('每个会话最多带最近 3 处，同时给出总数；这不算结果太多', async () => {
    const r = record(
      '五处',
      [1, 2, 3, 4, 5].map(i => reply(`a${i}`, `第 ${i} 处关键字`)),
    )
    await reopen()
    const res = await host.search(query('关键字'))
    expect(res.results.map(x => x.itemId).sort()).toEqual(['a3', 'a4', 'a5'])
    expect(res.results.every(x => x.sessionId === r.id && x.sessionMatches === 5)).toBe(true)
    expect(res.truncated).toBe(false)
  })
})
