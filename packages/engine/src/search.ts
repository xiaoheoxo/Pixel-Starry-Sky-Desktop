import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { setImmediate as yieldThread } from 'node:timers/promises'
import { join } from 'node:path'
import {
  CHAT_PROJECT_ID,
  SEARCH_SCOPES,
  compareSearchResults,
  containsTerms,
  itemSearchMatch,
  searchSnippet,
  searchTerms,
  titleMatch,
  type Item,
  type ProjectRecord,
  type SearchMatch,
  type SearchQuery,
  type SearchResponse,
  type SearchResult,
  type SessionRecord,
} from '@pixelsky/protocol'

export function searchQuery(value: unknown): SearchQuery {
  const q = value as Partial<SearchQuery> | null
  if (
    !q ||
    typeof q.text !== 'string' ||
    q.text.length > 200 ||
    !Number.isSafeInteger(q.requestId) ||
    q.requestId! < 1 ||
    !SEARCH_SCOPES.includes(q.scope as SearchQuery['scope']) ||
    (q.projectId !== null && (typeof q.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(q.projectId)))
  )
    throw new Error('搜索参数无效')
  return { requestId: q.requestId!, text: q.text.trim(), scope: q.scope!, projectId: q.projectId! }
}

/** 异步扫描已知会话目录；只保留命中的摘要，重复 ID 的最后版本覆盖或删除旧命中。 */
async function historyMatches(
  file: string,
  query: SearchQuery,
  signal?: AbortSignal,
): Promise<{ matches: Map<string, SearchMatch>; partial: boolean }> {
  signal?.throwIfAborted()
  const matches = new Map<string, SearchMatch>(),
    terms = searchTerms(query.text)
  const stream = createReadStream(file, { encoding: 'utf8', signal })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  // readline 不传播 input 的错误；destroy reader 让迭代退出后显式检查。
  let readError: NodeJS.ErrnoException | null = null
  stream.on('error', err => {
    readError = err
    lines.close()
  })
  let count = 0,
    partial = false
  try {
    for await (const line of lines) {
      signal?.throwIfAborted()
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line) as Item
        if (!item || typeof item.id !== 'string' || typeof item.kind !== 'string') {
          partial = true
          continue
        }
        const match = itemSearchMatch(item, terms, query.scope)
        if (match) matches.set(item.id, match)
        else matches.delete(item.id)
      } catch {
        partial = true
      }
      if (++count % 128 === 0) await yieldThread()
    }
    signal?.throwIfAborted()
    if (readError) {
      if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') partial = true
    }
    return { matches, partial }
  } catch (err) {
    signal?.throwIfAborted()
    return { matches, partial: partial || (err as NodeJS.ErrnoException).code !== 'ENOENT' }
  } finally {
    lines.close()
    stream.destroy()
  }
}

export interface SearchSource {
  dataDir: string
  records: SessionRecord[]
  projects: ProjectRecord[]
  /** 不创建运行时，仅返回已存在快照中的条目；空数组也代表有效的实时快照。 */
  liveItems(id: string): readonly Item[] | undefined
  /** 快照里截过输出的条目（cutChars）从磁盘补回完整的（Store.body）；补不回来为 null，用截过的 */
  body(id: string, item: Item): Item | null
  exists(id: string): boolean
}

export async function searchSessions(
  source: SearchSource,
  query: SearchQuery,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  signal?.throwIfAborted()
  const records = source.records
    // 从侧栏 Dot 组打开的对话不进搜索（只在 Dot 组里出现，没登录 ChatGPT Pro 时整组不显示）
    .filter(r => !r.dot && (!query.projectId || r.projectId === query.projectId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const projects = new Map(source.projects.map(p => [p.id, p]))
  const terms = searchTerms(query.text)
  const results: SearchResult[] = []
  let partial = false,
    truncated = false,
    index = 0
  const result = (record: SessionRecord, match: SearchMatch, itemId: string | null): SearchResult => ({
    id: `${record.id}:${itemId ?? 'title'}`,
    sessionId: record.id,
    itemId,
    title: record.title,
    projectId: record.projectId,
    projectName:
      projects.get(record.projectId)?.name ?? (record.projectId === CHAT_PROJECT_ID ? '对话' : '已移除的项目'),
    engine: record.engine,
    updatedAt: record.updatedAt,
    ...match,
  })
  if (!terms.length)
    return {
      requestId: query.requestId,
      results: records
        .slice(0, 10)
        .map(r =>
          result(r, { kind: 'title', field: '最近会话', rank: 0, snippet: [{ text: r.title, match: false }] }, null),
        ),
      truncated: false,
      partial: false,
      sessionCount: records.length,
    }
  const worker = async () => {
    while (index < records.length) {
      signal?.throwIfAborted()
      const record = records[index++]
      const perSession: SearchResult[] = []
      if (query.scope === 'all' || query.scope === 'titles') {
        let match = titleMatch(record.title, terms, query.text)
        if (!match) {
          const p = projects.get(record.projectId)
          const field =
            p && containsTerms(p.name, terms) ? p.name : containsTerms(record.cwd, terms) ? record.cwd : null
          if (field) match = { kind: 'project', field: '项目', rank: 3, snippet: searchSnippet(field, terms) }
        }
        if (match) perSession.push(result(record, match, null))
      }
      if (query.scope !== 'titles') {
        let live = source.liveItems(record.id),
          matches: Map<string, SearchMatch>
        if (live === undefined) {
          const history = await historyMatches(
            join(source.dataDir, 'sessions', record.id, 'items.jsonl'),
            query,
            signal,
          )
          partial ||= history.partial
          matches = history.matches
          live = source.liveItems(record.id)
        } else matches = new Map()
        if (live !== undefined) {
          matches.clear()
          let liveCount = 0
          for (const item of live) {
            signal?.throwIfAborted()
            // 截过的输出中间也要搜到（省略说明本身不算）：按 id 从磁盘读完整的那一行
            const full =
              item.cutChars !== undefined && query.scope !== 'messages' ? (source.body(record.id, item) ?? item) : item
            const match = itemSearchMatch(full, terms, query.scope)
            if (match) matches.set(item.id, match)
            if (++liveCount % 128 === 0) await yieldThread()
          }
        }
        // 每个会话只带最近 3 处，同时给出总数：界面按会话合并后写「另有 N 处」（不再算作「结果太多」）
        const sessionMatches = matches.size
        for (const [id, match] of [...matches].slice(-3).reverse())
          perSession.push({ ...result(record, match, id), sessionMatches })
      }
      if (source.exists(record.id)) results.push(...perSession)
      // 始终只保留全局最优的 51 条摘要，但继续扫描确保较旧标题优先于新正文。
      results.sort(compareSearchResults)
      if (results.length > 50) truncated = true
      if (results.length > 51) results.length = 51
      await yieldThread()
    }
  }
  await Promise.all([worker(), worker()])
  signal?.throwIfAborted()
  return {
    requestId: query.requestId,
    results: results.filter(r => source.exists(r.sessionId)).slice(0, 50),
    partial,
    truncated,
    sessionCount: records.length,
  }
}
