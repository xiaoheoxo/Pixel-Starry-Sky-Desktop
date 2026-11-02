// 像素星空的旁聊（docs/ui/rewind-fork-sidechat.md §3）：带着这个会话的上下文单独问一次，没有工具、不改原会话。
// Pi 的引擎会话 id 就是会话文件路径：复制一份到临时目录，`-p --session <副本> --no-tools --no-skills` 从 stdin 读问题、
// 回答印在 stdout，问完把副本删掉。主会话可能正在写这个文件，复制时截到最后一个完整的行。
import { spawn } from 'node:child_process'
import { closeSync, ftruncateSync, mkdtempSync, openSync, readSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { viaGateway, type SessionRecord } from '@pixelsky/protocol'
import type { Launcher } from '../adapter'
import { IS_WINDOWS, killTree, removeTree } from '../exec'
import { GATEWAY_PROVIDER } from './session'

/** 旁聊最长等多久（和 Claude 的一样） */
export const SIDE_TIMEOUT_MS = 5 * 60_000

/**
 * 把会话文件复制成 dest，截到最后一个完整的行；一个完整的行都没有时返回 false。
 * 按字节分块复制，不读成字符串（长会话的文件会超过 V8 字符串上限 512 MB）；
 * 不用 copyFileSync：Windows 上它复制期间独占源文件，主会话这时追加会 EBUSY、丢条目
 */
export function copyCompleteLines(src: string, dest: string): boolean {
  const from = openSync(src, 'r')
  try {
    const to = openSync(dest, 'w')
    try {
      const chunk = Buffer.allocUnsafe(1024 * 1024)
      let size = 0,
        complete = 0
      for (let n; (n = readSync(from, chunk, 0, chunk.length, null)) > 0; size += n) {
        writeSync(to, chunk, 0, n)
        const at = chunk.subarray(0, n).lastIndexOf(10)
        if (at >= 0) complete = size + at + 1
      }
      ftruncateSync(to, complete)
      return complete > 0
    } finally {
      closeSync(to)
    }
  } finally {
    closeSync(from)
  }
}

/**
 * 旁聊用的模型，规则同会话进程的 pickModel：经网关的是 pixelsky/<id>，本机的照记录（provider/id）。
 * 一定要明确指定：Pi 恢复不了会话里的模型时会悄悄换成默认模型、甚至用本机别的密钥（sdk.js findInitialModel）；
 * 指定了找不到就报错。没选过模型时不指定，按会话文件恢复
 */
export function pixelSideModel(record: Pick<SessionRecord, 'model' | 'platform' | 'provider'>): string | null {
  const model = record.model?.trim()
  if (!model) return null
  return viaGateway(record) ? `${GATEWAY_PROVIDER}/${model.replace(/^pixelsky\//, '')}` : model
}

/** 带值的：选工具、加技能；不带值的：关工具。旁聊不能有工具，用户追加的这些去掉 */
const VALUE_ARGS = ['--tools', '-t', '--skill']
const FLAG_ARGS = ['--no-tools', '-nt', '--no-builtin-tools', '-nbt']

/** 用户在设置里追加的启动参数（比如 -e 加的自定义提供方）照带，去掉选工具 / 加技能的 */
export function sideUserArgs(args: readonly string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (VALUE_ARGS.includes(arg)) i++
    else if (FLAG_ARGS.includes(arg) || VALUE_ARGS.some(name => arg.startsWith(name + '='))) continue
    else kept.push(arg)
  }
  return kept
}

/** 用户的参数放前面，旁聊自己的放后面（Pi 同一个参数以后面的为准） */
export function pixelSideArgs(sessionCopy: string, model: string | null, userArgs: readonly string[] = []): string[] {
  return [
    ...sideUserArgs(userArgs),
    '-p',
    '--session',
    sessionCopy,
    '--no-tools',
    '--no-skills',
    ...(model ? ['--model', model] : []),
  ]
}

/**
 * 去掉回答前后的空白；没回答时报 stderr 的第一行（Pi 的报错第一行是原因，后面是文档路径之类，
 * 例如「No API key found for the selected model.」）
 */
export function answerOf(stdout: string, stderr: string): string {
  const text = stdout.trim()
  if (text) return text
  const first = stderr.split(/\r?\n/).find(l => l.trim())
  throw new Error(first?.trim().replace(/^Error:\s*/, '') || '像素星空没有回答')
}

export function pixelSideQuestion(opts: {
  launcher: Launcher
  sessionFile: string
  cwd: string
  env: NodeJS.ProcessEnv
  model: string | null
  userArgs?: readonly string[]
  prompt: string
  signal: AbortSignal
  timeoutMs?: number
}): Promise<string> {
  const { signal } = opts
  if (signal.aborted) return Promise.reject(new Error('已停止'))
  const dir = mkdtempSync(join(tmpdir(), 'pixelsky-pixel-side-'))
  const copy = join(dir, 'session.jsonl')
  const cleanup = (): void => {
    // Windows 上进程刚退出时文件可能还被占着：删不掉就留给系统清
    try {
      removeTree(dir)
    } catch {
      // 留下的临时副本无害
    }
  }
  let complete: boolean
  try {
    complete = copyCompleteLines(opts.sessionFile, copy)
  } catch (error) {
    cleanup()
    return Promise.reject(
      new Error(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? '找不到这个对话的会话文件，先在主对话里发一条消息'
          : `复制会话文件失败：${(error as Error).message}`,
      ),
    )
  }
  if (!complete) {
    cleanup()
    return Promise.reject(new Error('先在主对话里发一条消息'))
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      opts.launcher.command,
      [...opts.launcher.args, ...pixelSideArgs(copy, opts.model, opts.userArgs)],
      {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !IS_WINDOWS,
      },
    )
    let out = '',
      err = '',
      settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      killTree(child)
      done(() => reject(new Error('已停止')))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      killTree(child)
      done(() => reject(new Error('旁聊超时（5 分钟）')))
    }, opts.timeoutMs ?? SIDE_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-4000)))
    child.stdin.on('error', () => undefined)
    child.on('error', e => {
      cleanup()
      done(() => reject(e))
    })
    child.on('close', () => {
      cleanup()
      done(() => {
        try {
          resolve(answerOf(out, err))
        } catch (e) {
          reject(e)
        }
      })
    })
    child.stdin.end(opts.prompt)
  })
}
