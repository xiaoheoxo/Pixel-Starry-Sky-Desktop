// 项目文件内容搜索（docs/ui/files-search-terminal-pins.md §2）：Git 仓库用 git grep（快，遵守 .gitignore），
// 其余逐个读文件。两种方式都有结果数、文件大小和时间上限，超出时返回已找到的部分并标 truncated。
// 查询可以是字符串（旧版：忽略大小写的固定字符串），也可以带区分大小写 / 整词 / 正则（docs/ui/coding-tier1.md §3）。
import { spawn } from 'node:child_process'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Script, createContext } from 'node:vm'
import { codedError } from '@pixelsky/protocol'
import type { GrepMatch, GrepResult } from '../../shared/types/workspace'

export const GREP_LIMIT = 200
const DEADLINE_MS = 3000
const FILE_LIMIT = 1024 * 1024
const WALK_FILE_LIMIT = 5000
const TEXT_MAX = 240

export interface GrepQuery {
  text: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export function grepQuery(value: unknown): GrepQuery {
  const raw = (typeof value === 'string' ? { text: value } : (value ?? {})) as Record<string, unknown>
  const text = raw.text
  if (typeof text !== 'string' || !text.trim() || text.length > 200 || text.includes('\n') || text.includes('\0'))
    throw codedError('files.queryInvalid')
  const query = {
    text,
    caseSensitive: raw.caseSensitive === true,
    wholeWord: raw.wholeWord === true,
    regex: raw.regex === true,
  }
  try {
    grepPattern(query)
  } catch {
    throw codedError('files.queryInvalid')
  }
  return query
}

/** 逐个读文件时用的正则；整词和 git grep -w 一样：前后不是字母数字下划线。和界面 replaceModel 的 searchRegExp 同一套规则 */
export function grepPattern(query: GrepQuery): RegExp {
  let source = query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (query.wholeWord) source = `(?<!\\w)(?:${source})(?!\\w)`
  return new RegExp(source, query.caseSensitive ? '' : 'i')
}

const clip = (text: string): string => (text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + '…' : text)

/** 解析 git grep -n --column 的一行：路径:行:列:内容 */
export function parseGitGrepLine(line: string): GrepMatch | null {
  const match = /^(.+?):(\d+):(\d+):(.*)$/.exec(line)
  if (!match) return null
  return {
    path: match[1].replaceAll('\\', '/'),
    line: Number(match[2]),
    column: Number(match[3]),
    text: clip(match[4]),
  }
}

/** 跑一条 git 命令只看退出码；git 不可用时为 null。
 * 不设 cwd、用 -C：Windows 按裸名启动时会先在 cwd 里找，项目里的 git.exe 不能顶替真正的 git */
function gitExit(cwd: string, args: string[]): Promise<number | null> {
  return new Promise(done => {
    const child = spawn('git', ['-C', cwd, ...args], { windowsHide: true, stdio: 'ignore' })
    child.on('error', () => done(null))
    child.on('close', code => done(code))
  })
}

/** git grep；返回 null 表示这里不是 Git 仓库、git 不可用，或项目文件夹本身被外层仓库忽略，改用逐个读文件 */
async function gitGrep(cwd: string, query: GrepQuery, deadline: number): Promise<GrepResult | null> {
  // 项目放在别的仓库忽略的目录里时，git grep 什么都搜不到
  if ((await gitExit(cwd, ['check-ignore', '-q', '.'])) !== 1) return null
  return new Promise(done => {
    // 正则用 -P（和 JS 正则最接近）。PCRE 拿到的行带 CRLF 的 \r：(*ANYCRLF) 让 $ 停在 \r 前，和逐个读文件一致
    // shortcut: \s 仍会吃掉行尾 \r（\s+$ 会列出 CRLF 行，预览和替换不改它们），真碰到再在这里剥 \r
    const args = [
      '-c',
      'core.quotepath=false',
      'grep',
      '-n',
      '--column',
      '-I',
      query.regex ? '-P' : '-F',
      '--untracked',
    ]
    if (!query.caseSensitive) args.push('-i')
    if (query.wholeWord) args.push('-w')
    const child = spawn(
      'git',
      ['-C', cwd, ...args, '--no-color', '-e', query.regex ? `(*ANYCRLF)${query.text}` : query.text, '--', '.'],
      { windowsHide: true },
    )
    const matches: GrepMatch[] = []
    let buffer = '',
      truncated = false,
      settled = false
    const finish = (result: GrepResult | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(result)
    }
    const stop = (): void => {
      truncated = true
      child.kill()
      finish({ matches, truncated })
    }
    const timer = setTimeout(stop, Math.max(0, deadline - Date.now()))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const parsed = parseGitGrepLine(buffer.slice(0, end).replace(/\r$/, ''))
        buffer = buffer.slice(end + 1)
        if (parsed) matches.push(parsed)
        if (matches.length >= GREP_LIMIT) return stop()
      }
    })
    child.stderr.resume()
    child.on('error', () => finish(null))
    // 0 有结果，1 没有结果，其它（128：不是仓库、没编进 PCRE、PCRE 回溯超限等）改用逐个读文件，那边有截止时间
    child.on('close', code => finish(code === 0 || code === 1 ? { matches, truncated } : null))
  })
}

// 用户写的正则可能回溯到停不下来（如 (\w+\s?)+: 碰上一长串字母），主进程里直接 exec 会卡死整个应用；
// 放进 vm 按截止时间跑才能打断
const MATCH_LINES = new Script(
  'found = []; for (let i = 0; i < lines.length && found.length < limit; i++) { const m = pattern.exec(lines[i]); if (m) found.push([i, m.index]) }',
)

async function walkGrep(root: string, query: GrepQuery, deadline: number): Promise<GrepResult> {
  const context = createContext({ pattern: grepPattern(query), lines: [] as string[], limit: 0, found: [] })
  const matches: GrepMatch[] = []
  const queue = ['']
  let examined = 0
  while (queue.length) {
    if (Date.now() > deadline || examined >= WALK_FILE_LIMIT || matches.length >= GREP_LIMIT)
      return { matches, truncated: true }
    const dir = queue.shift()!
    let entries
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        queue.push(path)
        continue
      }
      if (!entry.isFile()) continue
      if (++examined > WALK_FILE_LIMIT) return { matches, truncated: true }
      let text: string
      try {
        const handle = await open(join(root, path), 'r')
        try {
          if ((await handle.stat()).size > FILE_LIMIT) continue
          const bytes = await handle.readFile()
          if (bytes.subarray(0, 8000).includes(0)) continue
          text = bytes.toString('utf8')
        } finally {
          await handle.close()
        }
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      Object.assign(context, { lines, limit: GREP_LIMIT - matches.length })
      let late = false
      try {
        MATCH_LINES.runInContext(context, { timeout: Math.max(1, deadline - Date.now()) })
      } catch {
        late = true // 到截止时间；这个文件里已找到的照样返回
      }
      for (const [i, index] of context.found as Array<[number, number]>)
        matches.push({ path, line: i + 1, column: index + 1, text: clip(lines[i]) })
      if (late || matches.length >= GREP_LIMIT) return { matches, truncated: true }
    }
  }
  return { matches, truncated: false }
}

export async function grepWorkspace(root: string, value: unknown): Promise<GrepResult> {
  const query = grepQuery(value)
  const deadline = Date.now() + DEADLINE_MS
  return (await gitGrep(root, query, deadline)) ?? walkGrep(root, query, deadline)
}
