// Claude Code 自己的会话记录文件：<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects/<编码后的工作目录>/<session_id>.jsonl
// 编码规则：工作目录里不是字母数字的字符都换成 '-'（例如 D:\像素星空 → D------）。
// 很长的路径会被截断并加哈希，所以按规则找不到时，再在所有项目目录里找一遍。
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ImageAttachment } from '@pixelsky/protocol'
import { isFile } from '../exec'
import { anchorPositionIn, branchUuids, copyRowsTo, leafOf, rewindAnchorIn, transcriptIndex } from './transcript-index'

export function defaultProjectsDir(env: NodeJS.ProcessEnv): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
}

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** 找 Claude Code 的会话记录文件（<会话 id>.jsonl）；找不到返回 null */
export function findClaudeTranscript(projectsDir: string, cwd: string, sessionId: string): string | null {
  const direct = join(projectsDir, encodeCwd(cwd), `${sessionId}.jsonl`)
  if (isFile(direct)) return direct
  try {
    for (const d of readdirSync(projectsDir, { withFileTypes: true })) {
      const p = join(projectsDir, d.name, `${sessionId}.jsonl`)
      if (d.isDirectory() && isFile(p)) return p
    }
  } catch {
    // 目录不存在
  }
  return null
}

/** Claude Code 那边是否还留着这个会话的记录（决定用 --resume 还是 --session-id） */
export function claudeTranscriptExists(projectsDir: string, cwd: string, sessionId: string): boolean {
  return findClaudeTranscript(projectsDir, cwd, sessionId) !== null
}

/** Claude Code 放这个会话附属文件（子智能体对话、编排结果）的目录：记录文件去掉 .jsonl */
export function claudeSessionDir(projectsDir: string, cwd: string, sessionId: string): string | null {
  const file = findClaudeTranscript(projectsDir, cwd, sessionId)
  return file ? file.slice(0, -'.jsonl'.length) : null
}

/**
 * 从记录末尾往前找第一条让 pick 返回值的条目；记录很大时也只读最后一段。
 * maxBytes：最多读末尾这么多字节，超过还没找到就当没有（列表里只有元数据的大文件不会被整个读）；不传就一直读到文件开头
 */
export function scanBack<T>(
  file: string,
  pick: (entry: Record<string, unknown>) => T | null,
  maxBytes = Infinity,
): T | null {
  const size = statSync(file).size
  for (let chunk = 256 * 1024; ; chunk *= 4) {
    const start = Math.max(0, size - Math.min(chunk, maxBytes))
    const buffer = Buffer.alloc(size - start)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buffer, 0, buffer.length, start)
    } finally {
      closeSync(fd)
    }
    const lines = buffer.toString('utf8').split('\n')
    // 不是从文件开头读的：第一行多半是半截
    if (start > 0) lines.shift()
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue
      try {
        const found = pick(JSON.parse(lines[i]) as Record<string, unknown>)
        if (found !== null) return found
      } catch {
        // 跳过写坏的行
      }
    }
    if (start === 0 || chunk >= maxBytes) return null
  }
}

/** 当前分支的最后一条消息：主线上（不是子智能体）最后写进记录的 user / assistant 条目的 uuid，没有时 null */
export function currentLeaf(file: string): string | null {
  return scanBack(file, e =>
    (e.type === 'user' || e.type === 'assistant') && typeof e.uuid === 'string' && e.isSidechain !== true
      ? e.uuid
      : null,
  )
}

/**
 * 让另起的 --resume 进程读当前分支（GitHub #82）。Claude Code 恢复会话时，最后一条 last-prompt 记的 leafUuid
 * 还是分支末端就从它接着读；这条只在会话进程退出时写。回退时进程退出，记下的是回退前那条分支的末端，
 * 之后接着聊（进程还开着）的新分支就被它盖住：恢复代码的辅助进程、旁聊读到旧分支，新消息找不到检查点。
 * 记的不是当前末端时，按 Claude Code 自己的格式补一条指向当前末端的 last-prompt（--resume-session-at 换不了分支，
 * 只能在它读到的那条分支里截断）。会话进程之后退出时会照常再写一条，和这条一致
 */
export function pointLastPrompt(file: string, sessionId: string, leaf = currentLeaf(file)): void {
  if (!leaf) return
  const last = scanBack(file, e => (e.type === 'last-prompt' ? e : null))
  if (last?.leafUuid === leaf) return
  const lastPrompt = typeof last?.lastPrompt === 'string' ? last.lastPrompt : ''
  appendFileSync(file, JSON.stringify({ type: 'last-prompt', lastPrompt, leafUuid: leaf, sessionId }) + '\n')
}

/**
 * 回退截断点：按顺序找第一条出现在记录里的用户消息（我们发送时把条目 id 写成了 uuid），
 * 取它的 parentUuid 作为 --resume-session-at。都不在记录里时返回 null。
 * 走记录索引（流式读，不把整份记录读进内存，docs/ui/claude-resume.md §4.7）
 */
export async function findRewindAnchor(file: string, userIds: string[]): Promise<{ at: string | null } | null> {
  return rewindAnchorIn(await transcriptIndex(file), userIds)
}

/**
 * 截断点在记录里的位置。Claude Code 恢复会话时只加载最近一次压缩之后的部分，更早的条目
 * 用 --resume-session-at 找不到（报 No message found…，docs/ui/rewind-fork-sidechat.md §2.4）。
 * 'loaded'：在最近一次压缩之后；'compacted'：在它之前；null：记录里没有。
 */
export async function anchorPosition(file: string, at: string): Promise<'loaded' | 'compacted' | null> {
  return anchorPositionIn(await transcriptIndex(file), at)
}

/**
 * 把记录复制到截断点为止（含截断点），存成同目录下 <sessionId>.jsonl，返回新文件路径；截断点不在记录里时返回 null。
 * 截断点是最后一条，Claude Code 用 --resume 加载时从它往回接，之前的压缩摘要照常生效（§2.4）。
 * 分块读写；同名记录已存在时抛错
 */
export async function copyTranscriptUntil(file: string, at: string, sessionId: string): Promise<string | null> {
  const row = (await transcriptIndex(file)).rows.get(at)
  if (!row) return null
  const end = row.first ?? row
  const path = join(dirname(file), `${sessionId}.jsonl`)
  await copyRowsTo(file, end.offset + end.len, path, sessionId)
  return path
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 用户消息的 content：带图时和 Claude Code 自己记的一样，是文字块加图片块的数组；没有图就是一段文字 */
function userContent(text: string, images: readonly ImageAttachment[] = []): string | Record<string, unknown>[] {
  if (images.length === 0) return text
  return [
    { type: 'text', text },
    ...images.map(image => ({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.dataBase64 },
    })),
  ]
}

/**
 * 跨引擎接力：把别的引擎期间的聊天按 Claude Code 自己的格式写进会话记录，之后 --resume 就带着这些轮次。
 * 没有记录时新建（从头开始），有记录时接在当前分支末端后面，再让 last-prompt 指向新的末端。
 * 用户消息的 uuid 用我们的条目 id（发送时也是这么写的），回退时照样找得到截断点。
 * 失败的一轮游标不动，进程关掉后重试会把同一轮再交一次：已经在当前分支上的轮次（Claude Code 收到时自己记过，
 * 或上次接力写过）不再写；记录里别处已有这个 uuid（回退掉的旧分支）时换一个新的。同一个 uuid 写两遍会让
 * parentUuid 父链成环、回退截断点找错。返回记录文件路径
 */
export async function seedTranscript(
  projectsDir: string,
  cwd: string,
  sessionId: string,
  turns: readonly { id: string; user: string; assistant: string | null; images?: readonly ImageAttachment[] }[],
  noReply: string,
): Promise<string> {
  const existing = findClaudeTranscript(projectsDir, cwd, sessionId)
  const file = existing ?? join(projectsDir, encodeCwd(cwd), `${sessionId}.jsonl`)
  const idx = existing ? await transcriptIndex(existing) : null
  let parent = idx ? leafOf(idx) : null
  let parentIsUser = !!(parent && idx?.rows.get(parent)?.type === 'user')
  const branch = idx && parent ? branchUuids(idx, parent) : new Set<string>()
  const branchItems = new Set([...branch].map(uuid => idx?.rows.get(uuid)?.pixelskyItemId))
  const timestamp = new Date().toISOString()
  const base = { isSidechain: false, userType: 'external', cwd, sessionId, timestamp }
  const lines: string[] = []
  // 同一批里已经写过的条目 id（重复的不再写）
  const written = new Set<string>()
  for (const turn of turns) {
    // 任意 id 都去重：非 UUID 的（如重试出来的 X-retry-…）靠记录里的 pixelskyItemId 认出已写过
    const own = turn.id
    if (branch.has(own) || branchItems.has(own) || written.has(own)) continue
    written.add(own)
    if (parentIsUser) {
      const replyId = randomUUID()
      lines.push(
        JSON.stringify({
          ...base,
          parentUuid: parent,
          type: 'assistant',
          uuid: replyId,
          message: { role: 'assistant', type: 'message', content: [{ type: 'text', text: noReply }] },
        }),
      )
      parent = replyId
    }
    const userId = UUID.test(own) && !idx?.rows.has(own) ? own : randomUUID()
    lines.push(
      JSON.stringify({
        ...base,
        parentUuid: parent,
        type: 'user',
        uuid: userId,
        ...(userId !== own ? { pixelskyItemId: own } : {}),
        message: { role: 'user', content: userContent(turn.user, turn.images) },
      }),
    )
    const replyId = randomUUID()
    lines.push(
      JSON.stringify({
        ...base,
        parentUuid: userId,
        type: 'assistant',
        uuid: replyId,
        message: { role: 'assistant', type: 'message', content: [{ type: 'text', text: turn.assistant ?? noReply }] },
      }),
    )
    parent = replyId
    parentIsUser = false
  }
  if (lines.length === 0) {
    if (existing) pointLastPrompt(file, sessionId, parent)
    return file
  }
  if (!existing) mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, lines.join('\n') + '\n')
  if (existing) pointLastPrompt(file, sessionId, parent)
  return file
}
