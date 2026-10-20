// 短命的辅助进程（docs/ui/rewind-fork-sidechat.md §0）：不占用会话进程，做完就退出。
// - 恢复代码：stream-json 模式发 rewind_files 控制请求（可以只预览），不调用模型
// - 旁聊：-p 单次问答，--fork-session --no-session-persistence --tools ""，没有工具、不写会话记录
import { spawn } from 'node:child_process'
import type { Launcher, RewindFilesReply } from '../adapter'
export type { RewindFilesReply }
import { IS_WINDOWS, killTree } from '../exec'
import { logger } from '../log'
import { holdConfigDir } from './accounts'
import { ClaudeProcess, ownClaudePids } from './process'

const log = logger('engine.claude')

export interface HelperTarget {
  launcher: Launcher
  cwd: string
  env: NodeJS.ProcessEnv
  /** --resume <会话>，平台会话再加 --settings <网关配置> */
  resumeArgs: string[]
}

const STREAM_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
/**
 * 恢复代码的辅助进程不调用模型，只读记录和检查点（GitHub #35）：--bare 不加载 hook、插件、LSP、CLAUDE.md、后台预取，
 * --strict-mcp-config 不起 MCP 服务器。Claude Code 2.1.296 实测预览和还原的结果和不带时一样
 */
export const REWIND_ARGS = [...STREAM_ARGS, '--bare', '--strict-mcp-config']
/** 预览 / 还原超过这么久记一条，看慢在哪 */
const SLOW_REWIND_MS = 3_000

/** 还在退出的辅助进程：拿到回复就返回，进程在后台关（实测退出要再等约 2 秒） */
const exiting = new Set<Promise<void>>()
/** 等后台的辅助进程都退出（测试删临时目录前用：Windows 上进程还在时工作目录删不掉） */
export async function helpersExited(): Promise<void> {
  await Promise.all([...exiting])
}

/** rewind_files 的回复 → 结果；canRewind 为 false 时多半是这条消息没有检查点 */
export function parseRewindReply(raw: Record<string, unknown>): RewindFilesReply {
  if (raw.canRewind !== true) {
    const message = typeof raw.error === 'string' ? raw.error : ''
    return { ok: false, reason: /checkpoint/i.test(message) || !message ? 'no-checkpoint' : 'failed', message }
  }
  const files = Array.isArray(raw.filesChanged)
    ? raw.filesChanged.filter((f): f is string => typeof f === 'string')
    : []
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return { ok: true, files, insertions: num(raw.insertions), deletions: num(raw.deletions) }
}

/** Claude Code 自己启动就可能要 30 秒；代码检查不再挡着「只恢复对话」，宁可多等也别超时失败 */
const REWIND_INIT_TIMEOUT_MS = 90_000

/**
 * 预览（dryRun）或还原。还原在同一个进程里先预览、调 beforeRestore（存一份当前内容）、再真的还原，只起一次进程；
 * 返回预览出的文件列表（还原的回复里没有）。预览没成功就不还原
 */
export async function rewindFilesOnce(
  target: HelperTarget,
  userMessageId: string,
  dryRun: boolean,
  beforeRestore?: (files: string[]) => void,
): Promise<RewindFilesReply> {
  const started = performance.now()
  const ms = (): number => Math.round(performance.now() - started)
  const timing: Record<string, number> = {}
  const proc = new ClaudeProcess(target.launcher, [...REWIND_ARGS, ...target.resumeArgs], target.cwd, target.env, {
    onMessage: () => undefined,
    onControlRequest: () => undefined,
    onControlCancel: () => undefined,
    onExit: () => undefined,
  })
  try {
    await proc.request('initialize', {}, REWIND_INIT_TIMEOUT_MS)
    timing.initMs = ms()
    const preview = parseRewindReply(
      await proc.request('rewind_files', { user_message_id: userMessageId, dry_run: true }, 60_000),
    )
    timing.previewMs = ms()
    if (dryRun || !preview.ok) return preview
    beforeRestore?.(preview.files)
    const done = parseRewindReply(await proc.request('rewind_files', { user_message_id: userMessageId }, 60_000))
    timing.restoreMs = ms()
    return done.ok ? preview : done
  } catch (err) {
    return {
      ok: false,
      reason: 'failed',
      message: proc.alive ? (err as Error).message : proc.stderrTail.trim() || (err as Error).message,
    }
  } finally {
    const total = ms()
    if (total > SLOW_REWIND_MS) log.warn('恢复代码的辅助进程很慢', { dryRun, ...timing, ms: total })
    else log.info('恢复代码的辅助进程', { dryRun, ...timing, ms: total })
    const closing = proc.close(3_000).finally(() => exiting.delete(closing))
    exiting.add(closing)
  }
}

/** 旁聊的启动参数（单测用） */
export function sideQuestionArgs(resumeArgs: string[], model: string | null): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    ...resumeArgs,
    '--fork-session',
    '--no-session-persistence',
    '--tools',
    '',
    ...(model ? ['--model', model] : []),
  ]
}

/** 单次问答：问题从 stdin 进（不受命令行长度和引号影响），stdout 是一个 JSON 结果 */
export function sideQuestionOnce(
  target: HelperTarget,
  prompt: string,
  model: string | null,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('已停止'))
    const child = spawn(
      target.launcher.command,
      [...target.launcher.args, ...sideQuestionArgs(target.resumeArgs, model)],
      {
        cwd: target.cwd,
        env: target.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !IS_WINDOWS,
      },
    )
    let out = '',
      err = ''
    const kill = (): void => {
      killTree(child)
    }
    const onAbort = (): void => {
      kill()
      reject(new Error('已停止'))
    }
    const pid = child.pid
    if (pid !== undefined) ownClaudePids.add(pid)
    const release = holdConfigDir(target.env.CLAUDE_CONFIG_DIR)
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      kill()
      reject(new Error('旁聊超时（5 分钟）'))
    }, 5 * 60_000)
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-4000)))
    child.stdin.on('error', () => undefined)
    child.on('error', e => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (pid !== undefined) ownClaudePids.delete(pid)
      release()
      reject(e)
    })
    child.on('close', () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (pid !== undefined) ownClaudePids.delete(pid)
      release()
      if (signal.aborted) return
      try {
        resolve(parseSideAnswer(out))
      } catch (e) {
        reject(new Error(lastLine(err) || (e as Error).message))
      }
    })
    child.stdin.end(prompt)
  })
}

/** -p --output-format json 的结果；is_error 时把 result 当错误原因 */
export function parseSideAnswer(stdout: string): string {
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find(l => l.trim().startsWith('{'))
  if (!line) throw new Error('Claude Code 没有回答')
  const j = JSON.parse(line) as { result?: unknown; is_error?: unknown }
  const text = typeof j.result === 'string' ? j.result : ''
  if (j.is_error === true) throw new Error(text || 'Claude Code 回答失败')
  return text
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).at(-1) ?? ''
}
