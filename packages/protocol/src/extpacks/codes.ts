// 扩展检查会产生的全部问题代码。校验器里的 mk() 只接受这里登记过的代码，写错或漏登记编译不过。
// 新增代码要同时：加到这里（保持排序）、在共享用例（corpus）里加一个用例、必要时升 EXT_RULES_VERSION。
import { mk } from './issue'
import type { ExtPackIssue } from './types'

export const EXT_ISSUE_CODES = [
  'files.count',
  'files.encoding',
  'files.hidden',
  'files.license',
  'files.path',
  'files.readme',
  'files.samples',
  'files.scanLimit',
  'files.size',
  'files.symlink',
  'files.total',
  'files.type',
  'files.unused',
  'grammar.configIgnored',
  'grammar.configuration',
  'grammar.fields',
  'grammar.file',
  'grammar.firstLine',
  'grammar.hang',
  'grammar.includeBuiltinScope',
  'grammar.injectBuiltin',
  'grammar.load',
  'grammar.perfNearLimit',
  'grammar.perfUnchecked',
  'grammar.regex',
  'grammar.regexUnchecked',
  'grammar.samples',
  'grammar.slowLine',
  'grammar.slowTotal',
  'iconTheme.default',
  'iconTheme.fields',
  'iconTheme.file',
  'iconTheme.fonts',
  'iconTheme.iconPath',
  'manifest.contributes',
  'manifest.description',
  'manifest.engineRange',
  'manifest.engineUnmet',
  'manifest.engines',
  'manifest.icon',
  'manifest.id',
  'manifest.jsonc',
  'manifest.keywords',
  'manifest.l10n',
  'manifest.license',
  'manifest.main',
  'manifest.missing',
  'manifest.name',
  'manifest.notObject',
  'manifest.parse',
  'manifest.permissions',
  'manifest.price',
  'manifest.publisherMismatch',
  'manifest.unknownField',
  'manifest.url',
  'manifest.version',
  'pack.duplicateId',
  'pack.storeBlocked',
  'pack.validate',
  'prompt.body',
  'prompt.fields',
  'skill.engines',
  'skill.files',
  'skill.frontmatter',
  'skill.path',
  'snippets.entry',
  'snippets.fields',
  'snippets.file',
  'svg.unsafe',
  'task.command',
  'task.cwd',
  'task.extract',
  'task.fields',
  'task.fileReserved',
  'task.files',
  'task.icon',
  'task.id',
  'task.idReserved',
  'task.label',
  'task.nameDropped',
  'task.noTasks',
  'task.regexNested',
  'task.runner',
  'task.tooMany',
  'task.when',
  'theme.color',
  'theme.contrast',
  'theme.fields',
  'theme.file',
  'theme.requiredColors',
  'validate.internal',
  'zip.corrupt',
  'zip.duplicate',
  'zip.entryName',
  'zip.invalid',
  'zip.nameEncoding',
  'zip.nested',
  'zip.tooLarge',
  'zip.unsupported',
] as const
export type ExtIssueCode = (typeof EXT_ISSUE_CODES)[number]

/** 语法引擎（Oniguruma 编译 / 分词性能）产生的代码；只有 pixelsky-ext 的上传级别会产生 */
export const EXT_ENGINE_CODES = [
  'grammar.regex',
  'grammar.load',
  'grammar.hang',
  'grammar.slowLine',
  'grammar.slowTotal',
  'grammar.perfNearLimit',
  'grammar.perfUnchecked',
] as const satisfies readonly ExtIssueCode[]
export type ExtEngineCode = (typeof EXT_ENGINE_CODES)[number]

/** zip 读取层的代码 */
export const EXT_ZIP_CODES = [
  'zip.invalid',
  'zip.tooLarge',
  'zip.nested',
  'zip.entryName',
  'zip.nameEncoding',
  'zip.duplicate',
  'zip.unsupported',
  'zip.corrupt',
] as const satisfies readonly ExtIssueCode[]
export type ExtZipCode = (typeof EXT_ZIP_CODES)[number]

/** 出现就不再往下检查的 zip 问题 */
export const EXT_ZIP_FATAL: readonly ExtIssueCode[] = ['zip.invalid', 'zip.tooLarge', 'zip.nested']

/** zip 层的问题：全部 error / pack / 上传拒绝 */
export function zipIssue(code: ExtZipCode, p?: { path?: string; detail?: string; dir?: string }): ExtPackIssue {
  const path = p?.path
  const detail = p?.detail
  const at = path ? `：${path}` : ''
  const atEn = path ? `: ${path}` : ''
  const why = detail ? `（${detail}）` : ''
  const whyEn = detail ? ` (${detail})` : ''
  let zh: string
  let en: string
  switch (code) {
    case 'zip.invalid':
      zh = `不是有效的 zip 文件${why}`
      en = `Not a valid zip file${whyEn}`
      break
    case 'zip.tooLarge':
      zh = `zip 超过 10 MB 的上限${why}`
      en = `The zip is larger than the 10 MB limit${whyEn}`
      break
    case 'zip.nested':
      zh = `zip 第一层没有 pixelsky-extension.json，它在文件夹 ${p?.dir ?? ''} 里：不要多套一层文件夹，用 pixelsky-ext pack 重新打包`
      en = `The zip has no pixelsky-extension.json at its top level; it is inside the folder ${p?.dir ?? ''}. Do not add an extra folder level; repack with pixelsky-ext pack`
      break
    case 'zip.entryName':
      zh = `zip 里的文件名不安全${at}${why}`
      en = `Unsafe file name in the zip${atEn}${whyEn}`
      break
    case 'zip.nameEncoding':
      zh = `zip 里的文件名不是 UTF-8 编码${at}${why}：用 pixelsky-ext pack 重新打包`
      en = `A file name in the zip is not UTF-8 encoded${atEn}${whyEn}; repack with pixelsky-ext pack`
      break
    case 'zip.duplicate':
      zh = `zip 里有重复的文件名${at}`
      en = `Duplicate file name in the zip${atEn}`
      break
    case 'zip.unsupported':
      zh = `zip 里的文件用了不支持的压缩方式或加密${at}${why}`
      en = `A file in the zip uses an unsupported compression method or encryption${atEn}${whyEn}`
      break
    case 'zip.corrupt':
      zh = `zip 里的文件内容损坏（长度或校验和对不上）${at}`
      en = `A file in the zip is corrupt (length or checksum mismatch)${atEn}`
      break
  }
  return mk('error', 'pack', code, zh, en, { path, upload: 'reject' })
}

/** 语法引擎问题的参数 */
export interface GrammarIssueParams {
  /** 语法在清单里的下标 */
  index: number
  /** 语法文件或样例的路径 */
  path?: string
  /** 语法文件内的 JSON 指针 */
  pointer?: string
  line?: number
  column?: number
  /** 引擎给的原话 / 补充说明 */
  detail?: string
  ms?: number
  limitMs?: number
}

const fmtMs = (n: number | undefined): string => (n === undefined ? '?' : String(Math.round(n * 10) / 10))

/** 语法引擎的问题；loc 在知道行号 / 指针时填上 */
export function grammarIssue(code: ExtEngineCode, p: GrammarIssueParams): ExtPackIssue {
  const where = p.pointer ? `（${p.pointer}）` : ''
  const whereEn = p.pointer ? ` (${p.pointer})` : ''
  const d = p.detail ?? ''
  const ex = p.path ? `（示例 ${p.path}）` : ''
  const exEn = p.path ? ` (sample ${p.path})` : ''
  const line = p.line !== undefined ? `第 ${p.line} 行` : ''
  const lineEn = p.line !== undefined ? `line ${p.line}` : ''
  let severity: ExtPackIssue['severity'] = 'error'
  let scope: ExtPackIssue['scope'] = 'contribution'
  let upload: ExtPackIssue['upload'] = 'reject'
  let zh: string
  let en: string
  switch (code) {
    case 'grammar.regex':
      zh = `正则编译不了${where}：${d}`
      en = `The regex does not compile${whereEn}: ${d}`
      break
    case 'grammar.load':
      zh = `语法加载不了：${d}`
      en = `The grammar cannot be loaded: ${d}`
      break
    case 'grammar.hang':
      {
        const ms = p.limitMs ?? 10_000
        const secEn = ms < 1000 ? `${Math.round(ms)} ms` : `${Number((ms / 1000).toFixed(1))} s`
        const secZh = ms < 1000 ? `${Math.round(ms)} 毫秒` : `${Number((ms / 1000).toFixed(1))} 秒`
        const forFile = p.detail === 'compile' && p.path
        zh = `分词超过 ${secZh}还没完成，可能有回溯爆炸的正则${forFile ? `（语法文件 ${p.path}）` : ex}`
        en = `Tokenizing did not finish within ${secEn}; a regex may backtrack catastrophically${forFile ? ` (grammar file ${p.path})` : exEn}`
      }
      break
    case 'grammar.slowLine':
      severity = 'warning'
      zh = `${line}分词用了 ${fmtMs(p.ms)} 毫秒，超过 ${fmtMs(p.limitMs)} 毫秒的上限，软件会放弃这一行的高亮${ex}`
      en = `${lineEn ? lineEn + ': tokenizing' : 'Tokenizing'} took ${fmtMs(p.ms)} ms, over the ${fmtMs(p.limitMs)} ms limit; the app drops highlighting for that line${exEn}`
      break
    case 'grammar.slowTotal':
      severity = 'warning'
      zh = `样例整体分词用了 ${fmtMs(p.ms)} 毫秒，超过 ${fmtMs(p.limitMs)} 毫秒的预算${ex}`
      en = `Tokenizing the whole sample took ${fmtMs(p.ms)} ms, over the ${fmtMs(p.limitMs)} ms budget${exEn}`
      break
    case 'grammar.perfNearLimit':
      severity = 'warning'
      upload = 'hint'
      zh = `最慢的一行用了 ${fmtMs(p.ms)} 毫秒，已经接近 ${fmtMs(p.limitMs)} 毫秒的上限，慢一点的机器上可能超限${ex}`
      en = `The slowest line took ${fmtMs(p.ms)} ms, close to the ${fmtMs(p.limitMs)} ms limit; slower machines may exceed it${exEn}`
      break
    case 'grammar.perfUnchecked':
      severity = 'warning'
      scope = 'pack'
      upload = 'hint'
      zh = '这次只检查了正则能否编译，分词速度没有测（--grammar regex）；上传时会测'
      en = 'Only regex compilation was checked, not tokenizing speed (--grammar regex); speed is tested on upload'
      break
  }
  const issue = mk(severity, scope, code, zh, en, {
    path: p.path,
    upload,
    contribution: scope === 'contribution' ? { kind: 'grammars', index: p.index } : undefined,
  })
  if (p.path && (p.pointer !== undefined || p.line !== undefined)) {
    issue.loc = { file: p.path }
    if (p.pointer !== undefined) issue.loc.pointer = p.pointer
    if (p.line !== undefined) issue.loc.line = p.line
    if (p.column !== undefined) issue.loc.column = p.column
  }
  return issue
}
