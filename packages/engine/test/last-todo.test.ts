import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import { EngineHost } from '../src/host'
import { LastTodoCache, lastTodoInFile } from '../src/last-todo'

let root: string
let host: EngineHost
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-last-todo-'))
  host = new EngineHost({ dataDir: root, emit: () => {}, adapters: {} })
})
afterEach(async () => {
  await host.shutdown()
  rmSync(root, { recursive: true, force: true })
})

const todo = (id: string, text: string, status: 'running' | 'completed' = 'completed'): Item => ({
  kind: 'todo',
  id,
  steps: [{ text, status: 'pending' }],
  status,
})
const reply = (id: string, text: string): Item => ({ kind: 'assistant', id, text, status: 'completed' })
const lines = (items: Item[]) => items.map(i => JSON.stringify(i)).join('\n') + '\n'
const runtimes = () => (host as unknown as { runtimes: Map<string, unknown> }).runtimes.size

describe('lastTodoInFile', () => {
  it('取文件里最后一个 todo；文件不存在或没有 todo 时 null', async () => {
    const file = join(root, 'items.jsonl')
    expect(await lastTodoInFile(file)).toBeNull()
    writeFileSync(file, lines([reply('a', '没有待办')]))
    expect(await lastTodoInFile(file)).toBeNull()
    writeFileSync(file, lines([todo('t1', '旧'), reply('a', '回复'), todo('t2', '新'), reply('b', '尾')]))
    expect(await lastTodoInFile(file)).toMatchObject({ id: 't2', steps: [{ text: '新' }] })
  })

  it('用户文字里出现 "kind":"todo" 不算；坏行和半截行跳过；没等到完成的标成已中断', async () => {
    const file = join(root, 'items.jsonl')
    writeFileSync(
      file,
      lines([
        todo('t1', '真的', 'running'),
        { kind: 'user', id: 'u', text: '"kind":"todo" 误导', mode: 'normal' } as Item,
      ]) + '{"kind":"todo","id":"bad\n',
    )
    expect(await lastTodoInFile(file)).toMatchObject({ id: 't1', status: 'interrupted' })
  })

  it('跨多个读取块、行很长（含中文）时仍能找到，且不依赖末尾换行', async () => {
    const file = join(root, 'items.jsonl')
    const big = (i: number) => reply(`r${i}`, '长文本。'.repeat(20000))
    writeFileSync(
      file,
      lines([todo('t-first', '最前面'), big(1), big(2), todo('t-mid', '中间'), big(3), big(4)]).trimEnd(),
    )
    expect(await lastTodoInFile(file)).toMatchObject({ id: 't-mid' })
    appendFileSync(file, '\n' + JSON.stringify(todo('t-last', '最后')))
    expect(await lastTodoInFile(file)).toMatchObject({ id: 't-last' })
    // todo 在文件第一行
    writeFileSync(file, lines([todo('only', '第一行'), big(1), big(2)]))
    expect(await lastTodoInFile(file)).toMatchObject({ id: 'only' })
  })
})

describe('EngineHost.lastTodo / historyItems 不创建运行时', () => {
  function record(items: Item[]) {
    const p = host.addProject(root),
      r = host.createSession({ projectId: p.id })
    mkdirSync(join(root, 'sessions', r.id), { recursive: true })
    writeFileSync(join(root, 'sessions', r.id, 'items.jsonl'), lines(items))
    return r
  }
  async function reopen() {
    await host.shutdown()
    host = new EngineHost({ dataDir: root, emit: () => {}, adapters: {} })
  }

  it('没有运行时：从文件读，运行时数量不变', async () => {
    const r = record([todo('t1', '做事'), reply('a', '回复')])
    await reopen()
    expect(await host.lastTodo(r.id)).toMatchObject({ id: 't1' })
    expect((await host.historyItems(r.id)).map(i => i.id)).toEqual(['t1', 'a'])
    expect(runtimes()).toBe(0)
  })

  it('已有运行时：直接用内存快照，不复制数组', async () => {
    const r = record([todo('t1', '做事'), reply('a', '回复')])
    await reopen()
    const snapshot = host.open(r.id)
    appendFileSync(join(root, 'sessions', r.id, 'items.jsonl'), lines([todo('t2', '磁盘上更新的')]))
    expect(await host.lastTodo(r.id)).toMatchObject({ id: 't1' })
    expect(await host.historyItems(r.id)).toBe(snapshot.items)
    expect(runtimes()).toBe(1)
  })

  it('会话不存在：historyItems 报错，lastTodo 为 null', async () => {
    await expect(host.historyItems('nope')).rejects.toThrow('会话不存在')
    expect(await host.lastTodo('nope')).toBeNull()
  })
})

describe('LastTodoCache', () => {
  const file = () => join(root, 'items.jsonl')
  /** 把修改时间钉在固定值上（毫秒精度恢复不回原值）：之后改内容但大小不变，缓存命中的话就读不到这次改动 */
  const pin = (path = file()) => utimesSync(path, 1_700_000_000, 1_700_000_000)
  function overwriteQuietly(content: string) {
    writeFileSync(file(), content)
    pin()
  }

  it('文件没变过就不再读：同大小同修改时间的改动看不到', async () => {
    const cache = new LastTodoCache()
    overwriteQuietly(lines([todo('t1', 'AAAA'), reply('a', '回复')]))
    expect(await cache.get(file())).toMatchObject({ steps: [{ text: 'AAAA' }] })
    overwriteQuietly(lines([todo('t1', 'BBBB'), reply('a', '回复')]))
    expect(await cache.get(file())).toMatchObject({ steps: [{ text: 'AAAA' }] })
    // 没有 todo 的会话同样缓存
    const noTodo = lines([reply('a', '没有待办。'.repeat(40))])
    overwriteQuietly(noTodo)
    expect(await cache.get(file())).toBeNull()
    overwriteQuietly(JSON.stringify(todo('t1', 'new')).padEnd(Buffer.byteLength(noTodo) - 1, ' ') + '\n')
    expect(statSync(file()).size).toBe(Buffer.byteLength(noTodo))
    expect(await cache.get(file())).toBeNull()
  })

  it('变大了只扫新增的一段：新 todo 取新的，没有就沿用旧的', async () => {
    const cache = new LastTodoCache()
    const big = reply('big', '长文本。'.repeat(80000))
    writeFileSync(file(), lines([todo('t1', '旧'), big, big]))
    expect(await cache.get(file())).toMatchObject({ id: 't1' })
    // 旧的那一段被改成别的内容但大小、修改时间不变：增量扫描不会再去读它
    appendFileSync(file(), lines([reply('b', '追加')]))
    expect(await cache.get(file())).toMatchObject({ id: 't1' })
    appendFileSync(file(), lines([todo('t2', '新')]))
    expect(await cache.get(file())).toMatchObject({ id: 't2' })
    appendFileSync(file(), lines([reply('c', '又追加')]))
    expect(await cache.get(file())).toMatchObject({ id: 't2' })
  })

  it('末尾是还没写完的半行：写完后能读到', async () => {
    const cache = new LastTodoCache()
    const full = JSON.stringify(todo('t2', '后写完'))
    writeFileSync(file(), lines([todo('t1', '旧'), reply('a', '回复')]) + full.slice(0, 20))
    expect(await cache.get(file())).toMatchObject({ id: 't1' })
    appendFileSync(file(), full.slice(20) + '\n')
    expect(await cache.get(file())).toMatchObject({ id: 't2' })
  })

  it('回退重写：变小、或重写后又追加到更大，都整份重扫', async () => {
    const cache = new LastTodoCache()
    writeFileSync(file(), lines([reply('a', '开头'), todo('t1', '会被回退掉'), reply('b', '尾')]))
    expect(await cache.get(file())).toMatchObject({ id: 't1' })
    writeFileSync(file(), lines([reply('a', '开头')]))
    expect(await cache.get(file())).toBeNull()
    // 回退后马上又追加了很多，大小超过了缓存时的大小
    writeFileSync(file(), lines([reply('a', '开头'), todo('t1', '会被回退掉'), reply('b', '尾')]))
    expect(await cache.get(file())).toMatchObject({ id: 't1' })
    writeFileSync(file(), lines([reply('a', '另一个开头'), reply('x', '新内容'.repeat(50)), todo('t9', '新的')]))
    expect(await cache.get(file())).toMatchObject({ id: 't9' })
    writeFileSync(
      file(),
      lines([reply('a', '另一个开头'), reply('x', '新内容'.repeat(50)), reply('y', '没有 todo 了')]),
    )
    expect(await cache.get(file())).toBeNull()
  })

  it('文件被删掉后为 null', async () => {
    const cache = new LastTodoCache()
    writeFileSync(file(), lines([todo('t1', '旧')]))
    expect(await cache.get(file())).toMatchObject({ id: 't1' })
    rmSync(file())
    expect(await cache.get(file())).toBeNull()
  })

  it('EngineHost.lastTodo 没有运行时时走缓存，会话新增 todo 后跟着更新', async () => {
    const p = host.addProject(root),
      r = host.createSession({ projectId: p.id })
    mkdirSync(join(root, 'sessions', r.id), { recursive: true })
    const items = join(root, 'sessions', r.id, 'items.jsonl')
    writeFileSync(items, lines([todo('t1', 'AAAA')]))
    utimesSync(items, 1_700_000_000, 1_700_000_000)
    await host.shutdown()
    host = new EngineHost({ dataDir: root, emit: () => {}, adapters: {} })
    expect(await host.lastTodo(r.id)).toMatchObject({ steps: [{ text: 'AAAA' }] })
    writeFileSync(items, lines([todo('t1', 'BBBB')]))
    utimesSync(items, 1_700_000_000, 1_700_000_000)
    expect(await host.lastTodo(r.id)).toMatchObject({ steps: [{ text: 'AAAA' }] })
    appendFileSync(items, lines([todo('t2', '新')]))
    expect(await host.lastTodo(r.id)).toMatchObject({ id: 't2' })
  })
})

describe('lastTodoInFile 与逐行解析结果一致', () => {
  it('各种行长（含刚好卡在读取块边界上的）随机组合', async () => {
    const file = join(root, 'items.jsonl')
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const sizes = [10, 300, 4000, 262144 - 60, 262144, 262144 + 50, 600000]
    for (let round = 0; round < 12; round++) {
      const items: Item[] = []
      for (let i = 0, n = 2 + rand(6); i < n; i++)
        items.push(
          rand(3) === 0
            ? todo(`t${round}-${i}`, '待办')
            : reply(`r${round}-${i}`, 'x'.repeat(sizes[rand(sizes.length)])),
        )
      const text = lines(items)
      writeFileSync(file, text)
      const expected = items.filter(i => i.kind === 'todo').at(-1)
      const found = await lastTodoInFile(file)
      expect(found?.id ?? null).toBe(expected?.id ?? null)
      // 增量也一样：再追加一些，缓存的结果和整份重扫相同
      const cache = new LastTodoCache()
      await cache.get(file)
      const more = [
        reply(`m${round}`, 'y'.repeat(sizes[rand(sizes.length)])),
        ...(rand(2) ? [todo(`n${round}`, '新')] : []),
      ]
      appendFileSync(file, lines(more))
      expect((await cache.get(file))?.id ?? null).toBe((await lastTodoInFile(file))?.id ?? null)
    }
  })
})
