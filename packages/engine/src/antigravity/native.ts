// 接着 agy 自己留下的会话（终端里用过的 agy，docs/antigravity-engine.md §12）：
// 列表用 ACP session/list（id、cwd、标题、更新时间），读内容用 session/load（agy 把整段对话按 session/update 回放一遍），
// 回放经 AgyTranslator 翻成条目，用户消息另记。agy 的记录不在文件里，读一次要起一个临时 agy 进程
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { Item } from '@pixelsky/protocol'
import type { Launcher } from '../adapter'
import type { ListOptions, NativeListedSession, NativeRead, NativeSessionList, ReadOptions } from '../native/types'
import { matchCwd } from '../native/paths'
import { withAgy } from './discover'
import { AgyTranslator, agyPath } from './translate'

type Msg = Record<string, unknown>
const obj = (v: unknown): Msg => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Msg) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 最多翻几页（每页 agy 自己定） */
const MAX_PAGES = 20

/** session/list 全部翻完 */
async function listAll(launcher: Launcher, args: string[], env: NodeJS.ProcessEnv): Promise<Msg[]> {
  return withAgy(launcher, args, env, async conn => {
    const all: Msg[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = obj(await conn.request('session/list', cursor ? { cursor } : {}, 20_000))
      all.push(...(Array.isArray(r.sessions) ? r.sessions.map(obj) : []))
      cursor = str(r.nextCursor) || undefined
      if (!cursor) break
    }
    return all
  })
}

/** 这个项目（含子文件夹）里 agy 的会话，按更新时间从新到旧 */
export async function agyNativeSessions(
  launcher: Launcher,
  args: string[],
  env: NodeJS.ProcessEnv,
  project: string,
  opts: ListOptions = {},
): Promise<NativeSessionList> {
  const rows = await listAll(launcher, args, env)
  const sessions: NativeListedSession[] = []
  for (const s of rows) {
    const id = str(s.sessionId)
    const cwd = agyPath(str(s.cwd))
    if (!id || !cwd) continue
    const where = await matchCwd(project, cwd, opts.subfolders !== false)
    if (!where) continue
    const at = Date.parse(str(s.updatedAt)) || 0
    const title = str(s.title)
    sessions.push({
      id,
      file: '',
      size: 0,
      mtimeMs: at,
      updatedAt: at,
      cwd,
      subdir: where.subdir,
      title,
      firstPrompt: title,
      lastPrompt: null,
      branch: null,
      source: 'terminal',
      model: null,
    })
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  const limited = opts.limit ? sessions.slice(0, opts.limit) : sessions
  return {
    sessions: limited,
    // 列表里已经有标题和时间，没有可补的尾部
    details: async function* () {},
  }
}

/**
 * 用过的工作目录（项目导入）：agy 的会话文件加密，路径只能从 session/list 拿。
 * 应用自己读模型目录、一次性小任务开的临时会话（withAgy 的 pixelsky-agy-* 临时文件夹）不算
 */
export async function agyProjectDirs(launcher: Launcher, args: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  const dirs = (await listAll(launcher, args, env)).map(s => agyPath(str(s.cwd)))
  return [...new Set(dirs.filter(p => p && !/^pixelsky-agy-[A-Za-z0-9]{6}$/.test(basename(p))))]
}

/** session/load 的回放 → 条目：用户消息块合成一条用户条目，其余交给翻译 */
export function replayItems(updates: Msg[], cwd: string): Item[] {
  const items = new Map<string, Item>()
  const order: string[] = []
  const put = (item: Item): void => {
    if (!items.has(item.id)) order.push(item.id)
    items.set(item.id, item)
  }
  const t = new AgyTranslator(e => {
    if (e.type === 'item_started' || e.type === 'item_completed') put(e.item)
    if (e.type === 'item_delta') {
      const it = items.get(e.itemId) as { text?: string } | undefined
      if (it && typeof it.text === 'string') it.text += e.delta
    }
  }, cwd)
  let user: Extract<Item, { kind: 'user' }> | null = null
  for (const u of updates) {
    if (u.sessionUpdate === 'user_message_chunk') {
      const text = str(obj(u.content).text)
      if (!user) {
        // 上一轮收尾，再开新的用户条目
        t.finish('completed')
        user = { kind: 'user', id: 'ag-imp-' + randomUUID(), text: '', createdAt: Date.now(), engine: 'antigravity' }
        put(user)
      }
      user.text += text
      continue
    }
    user = null
    t.update(u)
  }
  t.finish('completed')
  return order.map(id => items.get(id)!)
}

/** 读一个 agy 会话：临时进程里 session/load 收回放，读完关掉；会话不在了返回 null */
export async function agyReadNative(
  launcher: Launcher,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  id: string,
  opts: ReadOptions = {},
): Promise<NativeRead | null> {
  const updates: Msg[] = []
  try {
    await withAgy(
      launcher,
      args,
      env,
      async conn => {
        if (opts.signal?.aborted) return
        await conn.request('session/load', { sessionId: id, cwd, mcpServers: [] }, 60_000)
        await conn.request('session/close', { sessionId: id }, 10_000).catch(() => {})
      },
      {
        notification: (method, params) => {
          if (method === 'session/update' && str(params.sessionId) === id) updates.push(obj(params.update))
        },
      },
    )
  } catch (error) {
    if (/not found|找不到|unknown session/i.test((error as Error).message)) return null
    throw error
  }
  const items = replayItems(updates, cwd)
  const users = items.filter(i => i.kind === 'user')
  if (!users.length) return null
  const title = (users[0] as { text: string }).text.split('\n')[0]!.slice(0, 80)
  return {
    file: '',
    items,
    title,
    turns: users.length,
    shown: users.length,
    summary: null,
    source: 'terminal',
    model: null,
    leafUuid: null,
    // agy 不能从中间分叉：没有「复制一份接着聊」的截断点
    at: null,
    earliestShownUuid: null,
    hasEarlier: false,
    compacted: false,
    cwd,
  }
}
