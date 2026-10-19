// 本机按上传标准检查扩展的子进程（docs/ui/extension-store-client.md §6.2）：主进程用 utilityProcess.fork 起它，
// 语法引擎（vscode-textmate + onig.wasm）只在这个入口里，主进程的包里没有（eslint 和 scripts/check-main-bundle.mjs 把关）。
//
// 一个文件两种身份：
// - 子进程：通过 process.parentPort 收 zip 字节，写到临时 zip，调 checkInput（语法检查在 worker 线程里跑），交回报告；
// - 语法 worker 线程：checkInput 的 runner:'worker' 会再起一个 Worker 指到本文件（workerUrl），
//   这时 workerData.kind 是 GRAMMAR_WORKER_KIND，直接跑语法 worker。
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMainThread, workerData } from 'node:worker_threads'
import { checkInput } from '@pixelsky/extension-cli/check'
import type { CheckInputOptions, CheckReport } from '@pixelsky/extension-cli/check'
import { GRAMMAR_WORKER_KIND, grammarWorkerMain } from '@pixelsky/extension-cli/grammar'

/** 主进程 → 检查进程 */
export interface ExtCheckRequest {
  type: 'check'
  /** 原样带回，主进程用它对上请求 */
  requestId: number
  /** 要检查的 zip（上传的字节；主进程已限制在 10 MB + 1 字节以内） */
  bytes: Uint8Array
  /** 临时 zip 写到这个目录下（store/.tmp），检查完删掉；目录由检查进程自己建 */
  tmpDir: string
}

/**
 * 可经 IPC 传的检查报告：CheckReport 去掉带函数的 files，input 去掉本机的临时路径。
 * 其余字段（check / grammar / grammarSkipped / verdict …）和 checkInput 的结果一样。
 */
export type ExtCheckReport = Omit<CheckReport, 'files' | 'input'> & {
  input: { kind: CheckReport['input']['kind']; bytes: number | null }
}

/** 检查进程 → 主进程。进程启动好发一次 ready；每个请求回一条 result 或 failed（超时由主进程管，见 7.5b） */
export type ExtCheckMessage =
  | { type: 'ready' }
  | { type: 'result'; requestId: number; report: ExtCheckReport }
  | { type: 'failed'; requestId: number; error: string }

export interface ExtCheckDeps {
  check: (path: string, opts: CheckInputOptions) => Promise<CheckReport>
  /** 语法 worker 线程跑哪个文件：就是本文件打包后的样子 */
  workerUrl: URL
  randomName: () => string
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 写临时 zip → checkInput（上传档、语法全跑、worker 线程）→ 去掉带函数的字段 → 删临时 zip */
export async function handleCheck(
  bytes: Uint8Array,
  tmpDir: string,
  deps: Partial<ExtCheckDeps> = {},
): Promise<ExtCheckReport> {
  const check = deps.check ?? checkInput
  const workerUrl = deps.workerUrl ?? pathToFileURL(__filename)
  const name = (deps.randomName ?? randomUUID)()
  await mkdir(tmpDir, { recursive: true })
  const zip = join(tmpDir, `${name}.zip`)
  try {
    await writeFile(zip, bytes, { flag: 'wx' })
    const {
      files: _files,
      input,
      ...rest
    } = await check(zip, {
      level: 'upload',
      grammar: 'full',
      runner: 'worker',
      workerUrl,
    })
    return { ...rest, input: { kind: input.kind, bytes: input.bytes } }
  } finally {
    await rm(zip, { force: true }).catch(() => undefined)
  }
}

function serve(port: NonNullable<typeof process.parentPort>): void {
  port.on('message', ({ data }: { data: unknown }) => {
    const m = data as Partial<ExtCheckRequest> | null
    if (!m || m.type !== 'check' || typeof m.requestId !== 'number') return
    const requestId = m.requestId
    const reply = (msg: ExtCheckMessage): void => port.postMessage(msg)
    if (!(m.bytes instanceof Uint8Array) || typeof m.tmpDir !== 'string') {
      reply({ type: 'failed', requestId, error: 'bad request' })
      return
    }
    handleCheck(m.bytes, m.tmpDir).then(
      report => reply({ type: 'result', requestId, report }),
      e => reply({ type: 'failed', requestId, error: errText(e) }),
    )
  })
  port.postMessage({ type: 'ready' } satisfies ExtCheckMessage)
}

if (!isMainThread && (workerData as { kind?: string } | null)?.kind === GRAMMAR_WORKER_KIND) {
  void grammarWorkerMain()
} else if (process.parentPort) {
  serve(process.parentPort)
}
