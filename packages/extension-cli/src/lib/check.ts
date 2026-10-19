import { open, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkPack, checkVerdict, EXT_LIMITS, readerFromFiles } from '@pixelsky/protocol/extpacks'
import type { ExtCheckLevel, ExtCheckVerdict, ExtPackCheck, ExtPackFiles } from '@pixelsky/protocol/extpacks'
import { folderPackFiles } from './folder'
import { checkGrammars } from './grammar/run'
import type { GrammarResult } from './grammar/run'
import { readPackZip } from './zip-read'

export type GrammarOption = 'full' | 'regex' | 'off'

/** 语法引擎没跑的原因：dev 档不跑、--grammar off、静态检查有错误所以跳过 */
export type GrammarSkipped = 'dev' | 'off' | 'staticErrors'

export interface CheckReport {
  input: { kind: 'folder' | 'zip'; path: string; bytes: number | null }
  level: ExtCheckLevel
  grammarMode: GrammarOption
  appVersion: string | null
  strict: boolean
  files: ExtPackFiles
  skipped: string[]
  check: ExtPackCheck
  grammar: GrammarResult[] | null
  /** 引擎没跑的原因；跑了、或没有语法可测时为 null（dev / off 总会给出） */
  grammarSkipped: GrammarSkipped | null
  verdict: ExtCheckVerdict
}

/** 用法错误（退出码 2）。zh 是 message，en 是可选的英文版 */
export class UsageError extends Error {
  readonly en: string | undefined
  constructor(zh: string, en?: string) {
    super(zh)
    this.name = 'UsageError'
    this.en = en
  }
}

/** 工具自己出错（退出码 3） */
export class ToolError extends Error {
  readonly en: string | undefined
  constructor(zh: string, en?: string) {
    super(zh)
    this.name = 'ToolError'
    this.en = en
  }
}

/** 取错误的指定语言文案 */
export function errorText(e: unknown, lang: 'zh' | 'en'): string {
  if (e instanceof UsageError || e instanceof ToolError) return lang === 'en' && e.en ? e.en : e.message
  return e instanceof Error ? e.message : String(e)
}

export interface CheckInputOptions {
  level: ExtCheckLevel
  grammar: GrammarOption
  appVersion?: string
  strict?: boolean
  /** 语法引擎在哪跑；默认 worker（源码里直接跑的测试用 inline） */
  runner?: 'inline' | 'worker'
  /** runner 为 worker 时 worker 线程跑哪个文件（默认是本文件所在的包）；被打进别的程序时要指到那个程序自己的入口 */
  workerUrl?: URL
}

/** 只读前 limit 字节：超大的 zip 不整个读进内存 */
async function readHead(path: string, limit: number): Promise<Uint8Array> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(limit)
    let got = 0
    while (got < limit) {
      const { bytesRead } = await fh.read(buf, got, limit - got, got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, got)
  } finally {
    await fh.close()
  }
}

/** 文件夹或 zip → 静态检查 → 语法引擎 → 结论（plan §4.5） */
export async function checkInput(path: string, opts: CheckInputOptions): Promise<CheckReport> {
  const { level, grammar } = opts
  const abs = resolve(path)
  let st
  try {
    st = await stat(abs)
  } catch {
    throw new UsageError(`路径不存在：${abs}`, `Path does not exist: ${abs}`)
  }
  let kind: 'folder' | 'zip'
  if (st.isDirectory()) kind = 'folder'
  else if (st.isFile() && /\.zip$/i.test(abs)) kind = 'zip'
  else throw new UsageError(`路径既不是文件夹也不是 .zip：${abs}`, `Path is neither a folder nor a .zip file: ${abs}`)
  if (kind === 'zip' && level === 'dev') {
    throw new UsageError(
      '--level dev 不检查 zip（软件现在不装 zip），请用文件夹，或去掉 --level dev',
      '--level dev does not check zip files (the app does not install zips); pass a folder or drop --level dev',
    )
  }
  if (level === 'dev' && grammar !== 'off') {
    throw new UsageError(
      '--level dev 不跑语法引擎，--grammar 只能是 off',
      '--level dev does not run the grammar engine; --grammar must be off',
    )
  }

  let files: ExtPackFiles
  let skipped: string[] = []
  let bytes: number | null = null
  if (kind === 'folder') {
    const f = await folderPackFiles(abs)
    files = f
    skipped = f.skipped
  } else {
    bytes = st.size
    // 多读 1 字节就够让 readPackZip 报 zip.tooLarge
    files = readPackZip(await readHead(abs, Math.min(st.size, EXT_LIMITS.packBytes + 1)))
  }

  const appVersion = level === 'dev' ? opts.appVersion : undefined
  const staticCheck = checkPack(files, { source: 'folder', appVersion })

  let check = staticCheck
  let grammarResults: GrammarResult[] | null = null
  const grammars = staticCheck.manifest?.contributes?.grammars
  if (
    level === 'upload' &&
    grammar !== 'off' &&
    staticCheck.manifest !== null &&
    staticCheck.status !== 'error' &&
    Array.isArray(grammars) &&
    grammars.length > 0
  ) {
    const reader = readerFromFiles(staticCheck.files, files.read)
    const engine = await checkGrammars(staticCheck.manifest, reader, {
      inactive: staticCheck.inactive.grammars ?? [],
      mode: grammar,
      runner: opts.runner ?? 'worker',
      ...(opts.workerUrl ? { workerUrl: opts.workerUrl } : {}),
    })
    grammarResults = engine.results
    check = checkPack(files, { source: 'folder', grammar: engine.issues })
  }

  let grammarSkipped: GrammarSkipped | null = null
  if (grammarResults === null) {
    if (level === 'dev') grammarSkipped = 'dev'
    else if (grammar === 'off') grammarSkipped = 'off'
    else if (Array.isArray(grammars) && grammars.length > 0) grammarSkipped = 'staticErrors'
  }
  // 上传档没跑引擎时，grammar.regexUnchecked 换成对作者有用的文案（dev 档保持和软件一致）
  if (level === 'upload' && grammarSkipped !== null && grammarSkipped !== 'dev') {
    const message =
      grammarSkipped === 'off'
        ? {
            zh: '语法里的 Oniguruma 正则和分词速度没有检查（--grammar off）；去掉 --grammar off 再查（上传时也会测）',
            en: 'Oniguruma regexes and tokenizing speed were not checked (--grammar off); drop --grammar off to check them (they are also tested on upload)',
          }
        : {
            zh: '语法里的 Oniguruma 正则和分词速度没有检查：上面有错误，语法引擎没有运行；先改好错误（上传时也会测）',
            en: 'Oniguruma regexes and tokenizing speed were not checked: the grammar engine did not run because of the errors above; fix them first (they are also tested on upload)',
          }
    check = { ...check, issues: check.issues.map(i => (i.code === 'grammar.regexUnchecked' ? { ...i, message } : i)) }
  }

  const strict = opts.strict === true
  return {
    input: { kind, path: abs, bytes },
    level,
    grammarMode: grammar,
    appVersion: appVersion ?? null,
    strict,
    files,
    skipped,
    check,
    grammar: grammarResults,
    grammarSkipped,
    verdict: checkVerdict(check.issues, { level, strict }),
  }
}
