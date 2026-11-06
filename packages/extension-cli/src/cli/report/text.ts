import { issueOutcome, EXT_RULES_VERSION, packName } from '@pixelsky/protocol/extpacks'
import type { ExtPackContributes, ExtPackIssue } from '@pixelsky/protocol/extpacks'
import type { CheckReport } from '../../lib/check'
import type { GrammarResult } from '../../lib/grammar/run'
import { t } from '../i18n'
import type { Lang } from '../i18n'
import { APP_VERSION, TOOL_VERSION } from '../version'

export interface PackOutput {
  /** --dry-run 时为 null */
  path: string | null
  bytes: number
  sha256: string
  files: Array<{ path: string; size: number }>
  dryRun: boolean
}

const LOC_MAX = 48
const MSG_MAX = 64
const SKIPPED_MAX = 20
const KIND_ORDER: Array<keyof ExtPackContributes> = [
  'grammars',
  'themes',
  'snippets',
  'iconThemes',
  'taskTemplates',
  'skills',
  'prompts',
  'uiThemes',
]

/** 显示宽度：CJK 和全角算 2 */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      c >= 0x1f300
        ? 2
        : 1
  }
  return w
}

function pad(s: string, width: number): string {
  const w = displayWidth(s)
  return w >= width ? s : s + ' '.repeat(width - w)
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 毫秒：>= 100 取整，否则 1 位小数；带千分位 */
function ms(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 10) / 10)
}

function num(n: number): string {
  return n.toLocaleString('en-US')
}

type Painter = (code: string, s: string) => string

function painter(color: boolean): Painter {
  return color ? (code, s) => `\u001b[${code}m${s}\u001b[0m` : (_c, s) => s
}

function locOf(i: ExtPackIssue, lang: Lang): string {
  if (i.loc) {
    let s = i.loc.file
    if (i.loc.line !== undefined) {
      s += `:${i.loc.line}`
      if (i.loc.column !== undefined) s += `:${i.loc.column}`
    }
    return s
  }
  return i.path ?? t(lang, 'loc.pack')
}

/** 符号跟着分组走：上传档的「提示 / 仅本地」一律 ·，其余按严重度（✗ 错误，! 警告） */
/** 位置列和文案：文案末尾已经带着这个路径（「…：路径」）时去掉那一截，不重复（文案本身不改，软件里照旧） */
function viewOf(i: ExtPackIssue, lang: Lang): { loc: string; msg: string } {
  const loc = locOf(i, lang)
  const msg = i.message[lang]
  const base = i.loc?.file ?? i.path
  if (!base) return { loc, msg }
  // 开头就是路径（「路径 不是合法的 JSON…」）且位置列写的正是这个路径：去掉文案开头那一截
  if (loc === base && msg.startsWith(base + ' ') && msg.length > base.length + 1)
    return { loc, msg: msg.slice(base.length + 1) }
  if (msg.endsWith(base)) {
    const head = msg.slice(0, msg.length - base.length)
    for (const sep of ['：', ': ']) {
      if (head.endsWith(sep) && head.length > sep.length) return { loc, msg: head.slice(0, head.length - sep.length) }
    }
  }
  return { loc, msg }
}

function symbolOf(i: ExtPackIssue, p: Painter, upload: boolean): string {
  if (upload && issueOutcome(i) !== 'reject') return p('2', '·')
  if (i.severity === 'error') return p('31', '✗')
  if (i.severity === 'warning') return p('33', '!')
  return p('2', '·')
}

function ctxOf(i: ExtPackIssue): string {
  return i.contribution ? ` · ${i.contribution.kind}[${i.contribution.index}]` : ''
}

function grammarLines(g: GrammarResult, r: CheckReport, lang: Lang): string[] {
  const bad = r.check.issues.filter(i => i.code === 'grammar.regex' && i.contribution?.index === g.index).length
  const summary =
    g.regexes === null
      ? t(lang, 'grammar.regexUnknown')
      : bad > 0
        ? t(lang, 'grammar.regexBad', { n: g.regexes, bad })
        : t(lang, r.grammarMode === 'regex' ? 'grammar.regexOkNoPerf' : 'grammar.regexOk', { n: g.regexes })
  const label = t(lang, 'grammar.label')
  const head = `${label}  ${g.scopeName}  ${summary}`
  const indent = ' '.repeat(displayWidth(label) + 2)
  const lines = [head]
  for (const s of g.samples) {
    const text = t(lang, s.sourceLines < s.lines ? 'grammar.sampleRepeat' : 'grammar.sampleOrig', {
      src: num(s.sourceLines),
      lines: num(s.lines),
      total: ms(s.totalMs),
      budget: ms(s.budgetMs),
      slowest: ms(s.slowestMs),
      line: s.slowestLine,
      limit: 30,
    })
    lines.push(`${indent}${s.path}  ${text}`)
  }
  return lines
}

export function renderText(
  r: CheckReport,
  o: { lang: Lang; color: boolean; command: 'validate' | 'pack'; output?: PackOutput },
): string {
  const { lang } = o
  const p = painter(o.color)
  const upload = r.level === 'upload'
  const out: string[] = []

  out.push(p('1', t(lang, 'ver', { tool: TOOL_VERSION, rules: EXT_RULES_VERSION, app: APP_VERSION })))
  const headKey = o.command === 'pack' ? 'head.pack' : `head.${r.input.kind}.${r.level}`
  out.push(t(lang, headKey, { path: r.input.path }))
  out.push('')

  const m = r.check.manifest
  if (m) {
    out.push(`${p('1', `${m.id} ${m.version}`)}  ${packName(m, lang === 'en' ? 'en-US' : 'zh-CN')}`)
    let total = 0
    for (const n of r.check.files.values()) total += n
    const kinds: string[] = []
    for (const k of KIND_ORDER) {
      const list = m.contributes?.[k]
      if (Array.isArray(list) && list.length > 0) kinds.push(`${t(lang, `kind.${k}`)} ${list.length}`)
    }
    const sep = lang === 'zh' ? '；' : '; '
    const sep2 = lang === 'zh' ? '，' : ', '
    out.push(
      `  ${t(lang, 'pack.counts', { files: r.check.files.size, size: formatSize(total) })}${kinds.length ? sep + kinds.join(sep2) : ''}`,
    )
    out.push('')
  }

  // 问题：上传档按「会被拒绝 / 提示 / 仅本地」，dev 档按「错误 / 警告」
  const issues = r.check.issues
  if (issues.length === 0) {
    out.push(t(lang, 'noIssues'))
    out.push('')
  } else {
    const groups: Array<{ key: string; list: ExtPackIssue[] }> = upload
      ? [
          { key: 'reject', list: issues.filter(i => issueOutcome(i) === 'reject') },
          { key: 'hint', list: issues.filter(i => issueOutcome(i) === 'hint') },
          { key: 'note', list: issues.filter(i => issueOutcome(i) === 'note') },
        ]
      : [
          { key: 'error', list: issues.filter(i => i.severity === 'error') },
          { key: 'warning', list: issues.filter(i => i.severity !== 'error') },
        ]
    const views = new Map(issues.map(i => [i, viewOf(i, lang)]))
    const locs = [...views.values()].map(v => displayWidth(v.loc))
    const msgs = [...views.values()].map(v => displayWidth(v.msg))
    const locW = Math.min(LOC_MAX, Math.max(...locs))
    const msgW = Math.min(MSG_MAX, Math.max(...msgs))
    for (const g of groups) {
      if (g.list.length === 0) continue
      const sorted = [...g.list].sort((a, b) => {
        const la = locOf(a, lang)
        const lb = locOf(b, lang)
        return la < lb ? -1 : la > lb ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0
      })
      const title = t(lang, `group.${g.key}`)
      out.push(p('1', lang === 'zh' ? `${title}（${g.list.length}）` : `${title} (${g.list.length})`))
      for (const i of sorted) {
        const v = views.get(i)!
        const line = `  ${symbolOf(i, p, upload)} ${pad(v.loc, locW)}  ${pad(v.msg, msgW)}  ${p('2', i.code + ctxOf(i))}`
        out.push(line.trimEnd())
      }
    }
    out.push('')
  }

  if (r.grammar) {
    for (const g of r.grammar) out.push(...grammarLines(g, r, lang))
    if (r.grammar.length > 0) out.push('')
  }

  if (r.grammarSkipped === 'staticErrors') {
    out.push(t(lang, 'grammar.skippedErrors'))
    out.push('')
  }

  // 结果行
  const c = r.verdict.counts
  const parts: string[] = []
  if (upload) {
    if (c.reject > 0) parts.push(t(lang, 'result.reject', { n: c.reject }))
    if (c.hint > 0) parts.push(t(lang, 'result.hint', { n: c.hint }))
  } else {
    if (c.error > 0) parts.push(t(lang, 'result.error', { n: c.error }))
    if (c.warning > 0) parts.push(t(lang, 'result.warning', { n: c.warning }))
  }
  const detail = parts.length ? (lang === 'zh' ? `（${parts.join('，')}）` : ` (${parts.join(', ')})`) : ''
  const pass = r.verdict.pass
  out.push(p(pass ? '32' : '31', t(lang, pass ? 'result.pass' : 'result.fail')) + detail)
  if (upload) out.push(t(lang, 'notChecked'))

  const po = o.output
  if (po) {
    out.push('')
    if (po.dryRun) {
      out.push(t(lang, 'dry.title', { n: po.files.length }))
      const w = Math.max(0, ...po.files.map(f => displayWidth(f.path)))
      for (const f of po.files) out.push(`  ${pad(f.path, w)}  ${formatSize(f.size)}`)
      out.push(t(lang, 'dry.size', { v: formatSize(po.bytes), sha: po.sha256 }))
    } else {
      out.push(t(lang, 'out.path', { v: po.path ?? '' }))
      out.push(t(lang, 'out.size', { v: `${formatSize(po.bytes)} (${num(po.bytes)} B)` }))
      out.push(t(lang, 'out.files', { v: po.files.length }))
      out.push(t(lang, 'out.sha256', { v: po.sha256 }))
    }
  }
  // 被略过的文件永远是最后一行
  if (r.skipped.length > 0) {
    const sep = lang === 'zh' ? '、' : ', '
    const shown = r.skipped.slice(0, SKIPPED_MAX).join(sep)
    out.push(
      t(lang, 'skipped', {
        list: r.skipped.length > SKIPPED_MAX ? t(lang, 'skipped.more', { list: shown, n: r.skipped.length }) : shown,
      }),
    )
  }
  return out.join('\n') + '\n'
}
