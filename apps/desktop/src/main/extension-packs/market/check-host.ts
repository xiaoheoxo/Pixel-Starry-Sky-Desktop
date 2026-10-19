import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { utilityProcess } from 'electron'
import { codedError, EXT_RULES_VERSION } from '@pixelsky/protocol'
import type { ExtPackIssue, ExtStoreCheckReport } from '@pixelsky/protocol'

// 本机按上传标准检查（docs/ui/extension-store-client.md §6.2）：起 utilityProcess 跑 workers/ext-check，
// 发字节、收报告、90 秒超时。进程起不来、中途退出、超时、回 failed 都当「本机没检查完」（incomplete: true），不抛错。
// publish.ts 只依赖 RunUploadCheck 这个类型，不知道进程怎么起（测试用假实现）。

/** 本机检查：把 zip 字节检查一遍，交回上传报告。永远不因为「没检查完」而抛错；signal 被取消时抛 extstore.cancelled */
export type RunUploadCheck = (zipBytes: Buffer, signal?: AbortSignal) => Promise<ExtStoreCheckReport>

export const CHECK_TIMEOUT_MS = 90_000

/** 检查进程里 workers/ext-check.ts 回的报告里这里用到的几项（结构上是它的 ExtCheckReport 的子集） */
interface WorkerReport {
  check: { issues: ExtPackIssue[] }
  verdict: { blocking: number; counts: { hint: number } }
}

/** utilityProcess 子进程里这里用到的部分 */
export interface CheckProcess {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}

export interface CheckHostDeps {
  /** 起检查进程；modulePath 是打包后的 ext-check.js */
  fork: (modulePath: string) => CheckProcess
  /** 打包后的 ext-check.js（和 main/index.js 同一个文件夹） */
  workerPath: string
  /** 临时 zip 写在 <tmpRoot>/check-<随机>/ 下，检查完（含超时被杀）整个文件夹删掉 */
  tmpRoot: string
  /** 建临时目录之前先等它（启动时清理 store/.tmp 完成）；不传不等 */
  whenReady?: () => Promise<void>
  timeoutMs?: number
  rm?: (path: string) => Promise<void>
  randomName?: () => string
}

const incomplete = (): ExtStoreCheckReport => ({ incomplete: true, issues: [] })

/** 检查进程交回的报告 → 软件里的 ExtStoreCheckReport（和云端 check_failed 带回来的同一个形状） */
export function toStoreReport(report: WorkerReport): ExtStoreCheckReport {
  return {
    incomplete: false,
    issues: report.check.issues,
    blocking: report.verdict.blocking,
    hints: report.verdict.counts.hint,
    rulesVersion: EXT_RULES_VERSION,
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function workerReport(v: unknown): WorkerReport | null {
  if (!isObj(v) || !isObj(v.check) || !Array.isArray(v.check.issues)) return null
  if (!isObj(v.verdict) || typeof v.verdict.blocking !== 'number' || !isObj(v.verdict.counts)) return null
  if (typeof v.verdict.counts.hint !== 'number') return null
  return v as unknown as WorkerReport
}

export function createCheckHost(deps: CheckHostDeps): RunUploadCheck {
  const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS
  const remove = deps.rm ?? ((p: string) => rm(p, { recursive: true, force: true }))
  const randomName = deps.randomName ?? ((): string => randomBytes(8).toString('hex'))

  return async (zipBytes, signal) => {
    if (signal?.aborted) throw codedError('extstore.cancelled')
    await deps.whenReady?.()
    if (signal?.aborted) throw codedError('extstore.cancelled')
    const tmpDir = join(deps.tmpRoot, `check-${randomName()}`)
    const proc: { child: CheckProcess | null } = { child: null }
    try {
      return await new Promise<ExtStoreCheckReport>((resolve, reject) => {
        let done = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (fn: () => void): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          fn()
        }
        const onAbort = (): void => finish(() => reject(codedError('extstore.cancelled')))
        try {
          proc.child = deps.fork(deps.workerPath)
        } catch {
          resolve(incomplete())
          return
        }
        timer = setTimeout(() => finish(() => resolve(incomplete())), timeoutMs)
        signal?.addEventListener('abort', onAbort, { once: true })
        const child = proc.child
        child.on('message', raw => {
          if (!isObj(raw) || raw.requestId !== 1) return // ready 等其他消息
          if (raw.type === 'result') {
            const report = workerReport(raw.report)
            finish(() => resolve(report ? toStoreReport(report) : incomplete()))
          } else if (raw.type === 'failed') finish(() => resolve(incomplete()))
        })
        child.on('exit', () => finish(() => resolve(incomplete())))
        try {
          child.postMessage({ type: 'check', requestId: 1, bytes: zipBytes, tmpDir })
        } catch {
          finish(() => resolve(incomplete()))
        }
      })
    } finally {
      try {
        proc.child?.kill()
      } catch {
        // 进程已经退出
      }
      await remove(tmpDir).catch(() => undefined)
    }
  }
}

/** 默认的起进程方式：Electron utilityProcess（开发版和打包版都是 main 旁边的 ext-check.js） */
export function forkCheckProcess(modulePath: string): CheckProcess {
  return utilityProcess.fork(modulePath, [], { serviceName: 'pixelsky-ext-check' }) as unknown as CheckProcess
}
