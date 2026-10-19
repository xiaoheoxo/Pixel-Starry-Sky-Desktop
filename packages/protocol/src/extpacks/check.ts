// 扩展的完整检查流程：清单 → 文件表 → 文件检查 → 内容检查 → 语法引擎的结果。
// 桌面加载器和命令行（pixelsky-ext）调用同一个函数，同一个文件夹得到同一个结果。纯函数，永远不抛错。
import { EXT_ZIP_FATAL } from './codes'
import { manifestJsoncIssue, mk } from './issue'
import {
  forSource,
  inactiveContributions,
  loaderIssue,
  packStatus,
  validateContributions,
  validateManifest,
  validatePackFiles,
} from './validate'
import { checkSvg, parseJsonc } from './text'
import { EXT_LIMITS, EXT_MANIFEST } from './types'
import type {
  CheckPackOptions,
  ExtPackCheck,
  ExtPackFiles,
  ExtPackIssue,
  ExtPackManifest,
  ExtPackReader,
  ExtPackSkillInfo,
} from './types'

// 协议包不带 DOM / node 类型；TextDecoder 在主进程、渲染进程和 node 里都有
declare const TextDecoder: new (label: string, opts?: { fatal?: boolean }) => { decode(input: Uint8Array): string }

/** 去重：同一个代码 / 路径 / 贡献 / 中文说明只留第一条 */
export function dedupeIssues(issues: ExtPackIssue[]): ExtPackIssue[] {
  const seen = new Set<string>()
  return issues.filter(i => {
    const k = `${i.code}|${i.path ?? ''}|${i.contribution?.kind ?? ''}|${i.contribution?.index ?? ''}|${i.message.zh}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 校验器用的只读视图：只认文件表里的普通文件，读不到、太大、不是 UTF-8 都返回 null */
export function readerFromFiles(files: Map<string, number>, read: ExtPackFiles['read']): ExtPackReader {
  const strict = new TextDecoder('utf-8', { fatal: true })
  return {
    exists: path => files.has(path),
    size: path => files.get(path) ?? null,
    readText(path) {
      const size = files.get(path)
      if (size === undefined || size > EXT_LIMITS.fileBytes) return null
      const bytes = read(path, EXT_LIMITS.fileBytes)
      if (!bytes) return null
      try {
        const text = strict.decode(bytes)
        return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
      } catch {
        return null
      }
    },
    readBytes(path, maxBytes) {
      if (!files.has(path)) return null
      return read(path, Math.min(maxBytes, EXT_LIMITS.fileBytes))
    },
    list: prefix => [...files.keys()].filter(path => path.startsWith(prefix)),
  }
}

/** 技能的 frontmatter（只取 name / description 两个单行字段） */
function skillMeta(text: string): { name: string; description: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  if (!m) return null
  const field = (key: string): string => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(m[1])
    return line ? line[1].trim().replace(/^(['"])(.*)\1$/, '$2') : ''
  }
  const name = field('name')
  return name ? { name, description: field('description') } : null
}

/** 校验器没给技能信息时（或只给了一部分），按清单自己补：每个没停用的技能读一次 SKILL.md */
function fillSkills(
  manifest: ExtPackManifest,
  reader: ExtPackReader,
  have: ExtPackSkillInfo[],
  inactive: number[],
): ExtPackSkillInfo[] {
  const list = manifest.contributes?.skills
  if (!Array.isArray(list)) return have
  const out = [...have]
  list.forEach((skill, index) => {
    if (out.some(s => s.index === index) || inactive.includes(index)) return
    const base = typeof skill?.path === 'string' ? skill.path.replace(/\/+$/, '') : ''
    const text = base ? reader.readText(`${base}/SKILL.md`) : null
    const meta = text ? skillMeta(text) : null
    if (!meta) return
    out.push({
      name: meta.name,
      description: meta.description,
      engines: skill.engines && skill.engines.length > 0 ? [...skill.engines] : ['claude', 'codex'],
      index,
    })
  })
  return out.sort((a, b) => a.index - b.index)
}

function packError(
  code: 'manifest.parse' | 'pack.validate',
  zh: string,
  en: string,
  path?: string,
  loc?: ExtPackIssue['loc'],
): ExtPackIssue {
  const issue = mk('error', 'pack', code, zh, en, { path })
  if (loc) issue.loc = loc
  return issue
}

/** 从 JSON.parse 的报错里取出行列（V8 写「(line 1 column 13)」或「at position 12」） */
function parseErrorLoc(text: string, e: unknown): { line: number; column: number } | undefined {
  const msg = e instanceof Error ? e.message : String(e)
  const lc = /\(line (\d+) column (\d+)\)/.exec(msg)
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) }
  const pos = /position (\d+)/.exec(msg)
  if (!pos) return undefined
  const lines = text.slice(0, Number(pos[1])).split(/\r\n|\r|\n/)
  return { line: lines.length, column: lines[lines.length - 1].length + 1 }
}

type ManifestRead = { raw: unknown; issues: ExtPackIssue[] } | { fail: ExtPackIssue }

/** 先按严格 JSON 读清单；严格读不了但带注释 / 结尾逗号能读，就读出来并给一条警告 */
function readManifest(src: ExtPackFiles): ManifestRead {
  const size = src.stat(EXT_MANIFEST)
  if (size === null) return { fail: loaderIssue('manifest.missing', { path: EXT_MANIFEST }) }
  if (size > EXT_LIMITS.manifestBytes)
    return {
      fail: packError('manifest.parse', '清单文件超过 256 KB', 'The manifest is larger than 256 KB', EXT_MANIFEST),
    }
  const bytes = src.read(EXT_MANIFEST, size)
  if (!bytes) return { fail: loaderIssue('manifest.missing', { path: EXT_MANIFEST }) }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return {
      fail: packError('manifest.parse', '清单文件不是 UTF-8 编码', 'The manifest is not UTF-8 encoded', EXT_MANIFEST),
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return { raw: JSON.parse(text), issues: [] }
  } catch (strict) {
    try {
      return { raw: parseJsonc(text), issues: [manifestJsoncIssue(EXT_MANIFEST)] }
    } catch {
      const detail = strict instanceof Error ? strict.message : String(strict)
      const at = parseErrorLoc(text, strict)
      return {
        fail: packError(
          'manifest.parse',
          `清单不是合法的 JSON：${detail}`,
          `The manifest is not valid JSON: ${detail}`,
          EXT_MANIFEST,
          at ? { file: EXT_MANIFEST, ...at } : undefined,
        ),
      }
    }
  }
}

/**
 * 检查一个扩展。顺序和桌面加载器一致：先清单（读不了就到此为止），再文件表（符号链接 / 超出扫描上限），
 * 再文件检查、内容检查；最后并入语法引擎的结果（没给就报 grammar.regexUnchecked）。
 * 内置扩展只留 error、不扫 svg 内容。
 */
export function checkPack(src: ExtPackFiles, opts: CheckPackOptions): ExtPackCheck {
  const { source } = opts
  const pre = [...(src.preIssues ?? [])]
  const issues: ExtPackIssue[] = [...pre]
  const files = new Map<string, number>()
  let manifest: ExtPackManifest | null = null
  let inactive: ExtPackCheck['inactive'] = {}
  let skills: ExtPackSkillInfo[] = []

  const finish = (): ExtPackCheck => {
    const out = dedupeIssues(forSource(issues, source))
    return {
      id: typeof manifest?.id === 'string' ? manifest.id : null,
      manifest,
      files,
      issues: out,
      status: packStatus(out),
      inactive,
      skills,
    }
  }

  try {
    if (pre.some(i => (EXT_ZIP_FATAL as readonly string[]).includes(i.code))) return finish()

    const read = readManifest(src)
    if ('fail' in read) {
      issues.push(read.fail)
      return finish()
    }
    issues.push(...read.issues)

    for (const f of src.entries) {
      if (f.kind === 'file') files.set(f.path, f.size)
      else issues.push(loaderIssue('files.symlink', { path: f.path }))
    }
    if (src.truncated) issues.push(loaderIssue('files.scanLimit'))

    try {
      const checked = validateManifest(read.raw, { appVersion: opts.appVersion, source })
      issues.push(...checked.issues)
      manifest = checked.manifest && typeof checked.manifest === 'object' ? checked.manifest : null
    } catch (e) {
      issues.push(packError('pack.validate', '清单检查出错', `Manifest validation failed: ${(e as Error).message}`))
    }
    // zip 层的非致命问题（error / pack）不拦住后面的检查，所以只看这一步之后新增的
    const own = issues.slice(pre.length)
    if (!manifest || src.truncated || own.some(i => i.severity === 'error' && i.scope === 'pack')) return finish()

    try {
      issues.push(...validatePackFiles(src.entries, manifest, { source }))
      // 内置扩展不扫 svg 内容（随包发行，已审过）；商店扩展启动加载时也可以不扫（安装时扫过）
      if (opts.scanSvg ?? source !== 'builtin') {
        const lenient = new TextDecoder('utf-8')
        for (const [path, size] of files) {
          if (!path.toLowerCase().endsWith('.svg') || size > EXT_LIMITS.fileBytes) continue
          const bytes = src.read(path, EXT_LIMITS.fileBytes)
          if (bytes && checkSvg(lenient.decode(bytes)) !== null) issues.push(loaderIssue('svg.unsafe', { path }))
        }
      }
      const reader = readerFromFiles(files, src.read)
      const checked = validateContributions(manifest, reader, { source })
      issues.push(...checked.issues)
      if (opts.grammar) issues.push(...opts.grammar)
      else if (Array.isArray(manifest.contributes?.grammars) && manifest.contributes.grammars.length > 0)
        issues.push(
          mk(
            'warning',
            'pack',
            'grammar.regexUnchecked',
            '语法里的 Oniguruma 正则和分词速度软件里不检查，用 pixelsky-ext validate 检查（上传时也会测）',
            'Oniguruma regexes and tokenizing speed are not checked in the app; use pixelsky-ext validate (they are also tested on upload)',
            { upload: 'hint' },
          ),
        )
      inactive = inactiveContributions(manifest, forSource(dedupeIssues(issues), source))
      skills = fillSkills(manifest, reader, checked.skills, inactive.skills ?? [])
    } catch (e) {
      issues.push(
        packError('pack.validate', '扩展内容检查出错', `Contribution validation failed: ${(e as Error).message}`),
      )
    }
  } catch (e) {
    // 理论上走不到：上面每一步都有自己的保护；兜底保证永远不抛
    issues.push(packError('pack.validate', '扩展检查出错', `Pack check failed: ${(e as Error).message}`))
  }
  return finish()
}
