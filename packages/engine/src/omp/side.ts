// oh-my-pi 的旁聊退路（docs/omp-engine.md §11.6）：这个对话这次打开应用后还没起过会话进程时，复制会话文件，
// 起一次临时 RPC 进程用 btw 问一次就关（会话进程在时直接在里面问，btw.ts）。
// 不直接打开原会话文件，副本还要换一个会话 id：omp 的租约按文件头里的会话 id 算（不看路径），id 一样时用户这会儿发消息，
// 主会话会被改存到新文件（实测），对话就分叉了。
// 千万别用 --no-session：历史不会加载，回答悄悄答偏（实测）
import { randomUUID } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, readSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Effort, SessionRecord } from '@pixelsky/protocol'
import type { Launcher } from '../adapter'
import { removeTree } from '../exec'
import { findModel, piThinkingLevel } from '../pixel/catalog'
import { PixelProcess, array, object, string } from '../pixel/process'
import { SIDE_TIMEOUT_MS, copyCompleteLines } from '../pixel/side'
import { GATEWAY_PROVIDER, negotiateOmp } from '../pixel/session'
import { HEAD_BYTES } from './branch'
import { btwOutcome } from './btw'

/** 把会话文件头里的 id 换成新的（同样长，原地改，大文件不用重写）；找不到文件头返回 false */
export function freshSessionId(file: string): boolean {
  const fd = openSync(file, 'r+')
  try {
    const bytes = Buffer.alloc(HEAD_BYTES)
    // latin1 一个字节一个字符，位置就是字节位置
    const head = bytes.toString('latin1', 0, readSync(fd, bytes, 0, HEAD_BYTES, 0))
    const line = /^\{"type":"session",[^\n]*/m.exec(head)
    const id = line && /"id":"([^"\\]+)"/.exec(line[0])
    if (!id) return false
    const fresh = randomUUID()
      .repeat(Math.ceil(id[1].length / 36))
      .slice(0, id[1].length)
    writeSync(fd, fresh, line.index + id.index + '"id":"'.length, 'latin1')
    return true
  } finally {
    closeSync(fd)
  }
}

export async function ompSideQuestion(opts: {
  launcher: Launcher
  /** 已经是 ompLaunch 算好的参数（权限档、网关扩展、角色、用户参数） */
  args: string[]
  env: NodeJS.ProcessEnv
  record: Pick<SessionRecord, 'cwd' | 'model' | 'effort' | 'engineSessionId'>
  /** 还没落实的回退：问之前先移到截断点，回退掉的不带进去 */
  at?: string | null
  gateway: boolean
  prompt: string
  signal: AbortSignal
  timeoutMs?: number
}): Promise<string> {
  const { signal, record } = opts
  if (signal.aborted) throw new Error('已停止')
  const dir = mkdtempSync(join(tmpdir(), 'pixelsky-omp-side-'))
  const cleanup = (): void => {
    try {
      removeTree(dir)
    } catch {
      // Windows 上进程刚退出时文件可能还被占着：留给系统清
    }
  }
  const copy = join(dir, 'session.jsonl')
  try {
    if (!copyCompleteLines(record.engineSessionId!, copy)) throw new Error('先在主对话里发一条消息')
    // 换不了 id 就不问：宁可这次旁聊用不了，也不能让主会话分叉
    if (!freshSessionId(copy)) throw new Error('认不出这个对话的会话文件，旁聊没有发出')
  } catch (error) {
    cleanup()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('找不到这个对话的会话文件，先在主对话里发一条消息')
    throw error
  }
  type Outcome = { answer: string } | { error: string }
  const box: { settle?: (r: Outcome) => void } = {}
  const outcome = new Promise<Outcome>(resolve => (box.settle = resolve))
  let tail = ''
  const proc = new PixelProcess(
    opts.launcher,
    ['--mode', 'rpc', ...opts.args, '--session', copy],
    record.cwd,
    opts.env,
    {
      // 这个进程里只问一个问题：running 那一帧比 btw 的回应先到（实测），不靠回应里的 id 认
      event: event => {
        if (string(event.type) !== 'btw_record') return
        const result = btwOutcome(object(event.record))
        if (result) box.settle?.(result)
      },
      exit: (_code, stderr) => {
        tail = stderr
        box.settle?.({
          error:
            stderr
              .split(/\r?\n/)
              .find(l => l.trim())
              ?.trim() || 'oh-my-pi 旁聊进程退出了',
        })
      },
    },
  )
  const onAbort = (): void => {
    void proc.request('btw_cancel', {}, 2_000).catch(() => {})
    box.settle?.({ error: '已停止' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => box.settle?.({ error: '旁聊超时（5 分钟）' }), opts.timeoutMs ?? SIDE_TIMEOUT_MS)
  try {
    await negotiateOmp(proc)
    if (opts.at) await proc.request('navigate_tree', { entryId: opts.at })
    // 模型一定要显式指定：经网关的只认网关注册的，找不到就报错（不能退回同名内置模型、用本机的账号）
    if (record.model) {
      const models = array((await proc.request('get_available_models')).data.models).map(object)
      const model = findModel(models, record.model, opts.gateway ? GATEWAY_PROVIDER : undefined)
      if (!model) throw new Error(`Model not found: ${opts.gateway ? `${GATEWAY_PROVIDER}/` : ''}${record.model}`)
      await proc.request('set_model', { provider: string(model.provider), modelId: string(model.id) })
    }
    // 思考档同主会话：提示缓存的前缀才对得上
    if (record.effort) await proc.request('set_thinking_level', { level: piThinkingLevel(record.effort as Effort) })
    // 旁聊不按 Fast 扣：副本会恢复会话里记的 /fast、用户配置里的 tier（同 §11.1）
    await proc.request('set_fast_mode', { enabled: false }).catch(() => {})
    if (object((await proc.request('get_state')).data).fastModeActive === true)
      throw new Error('oh-my-pi 的 Fast 档关不掉，为免按 Fast 加价扣费，这条消息没有发出')
    if (signal.aborted) throw new Error('已停止')
    await proc.request('btw', { question: opts.prompt })
    const result = await outcome
    if ('error' in result) throw new Error(result.error)
    return result.answer
  } catch (error) {
    if (signal.aborted) throw new Error('已停止')
    if (!proc.alive && tail && !(error as Error).message.startsWith('Model not found')) {
      const first = tail.split(/\r?\n/).find(l => l.trim())
      if (first) throw new Error(first.trim())
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    delete box.settle
    await proc.close()
    cleanup()
  }
}
