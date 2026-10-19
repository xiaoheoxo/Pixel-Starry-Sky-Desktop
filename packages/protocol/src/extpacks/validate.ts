// 扩展包校验（方案 §5 / authoring-spec §2–§9）。纯函数：文件内容通过 ExtPackReader 读，不碰文件系统。
// 严重度（开发者模式）：error/pack = 整个扩展不加载；error/contribution = 只停用那一条；error/file = 该文件不使用；
// warning = 照常加载。upload 是以后上传检查对它的处理。所有函数都不抛异常，对畸形输入也一样。
import type { ExtIssueCode } from './codes'
import { manifestJsoncIssue, mk } from './issue'
import { EXT_FIRST_LINE_MAX, packDir, resolvePackPath } from './match'
import { EXT_BUILTIN_SCOPES, EXT_LIMITS, EXT_MANIFEST } from './types'
import type {
  ExtPackContributionKind,
  ExtPackFileEntry,
  ExtPackInactive,
  ExtPackInfo,
  ExtPackIssue,
  ExtPackManifest,
  ExtPackReader,
  ExtPackSkillInfo,
  ExtPackSource,
} from './types'
import { hasAmbiguousQuantifiers, hasNestedQuantifier, hasQuantifiedAlternation, validateTaskTemplate } from './tasks'
import { contrastRatio, parseHexColor, parseJsonc, satisfiesEngine } from './text'

type Rec = Record<string, unknown>

// 协议包不带 DOM / node 类型；TextDecoder 在主进程和渲染进程里都有
declare const TextDecoder: new (label: string, opts: { fatal: boolean }) => { decode(input: Uint8Array): string }

const CONTRIBUTION_KINDS: readonly ExtPackContributionKind[] = [
  'grammars',
  'themes',
  'snippets',
  'iconThemes',
  'taskTemplates',
  'skills',
  'prompts',
]

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\.[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])$/
const PUBLISHER_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^:*?"<>|]+$/
const LOCAL_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const LANGUAGE_RE = /^[a-z0-9][a-z0-9+#.-]*$/
const SCOPE_NAME_RE = /^[a-z0-9][a-z0-9.+-]*$/

/** 扩展 id：发布者.名字（和云端一样，总长另由正则限定） */
export function isExtId(s: unknown): s is string {
  return typeof s === 'string' && ID_RE.test(s)
}
/** 扩展版本号：主.次.修订，可带预发布后缀；总长不超过 64 个字符 */
export function isExtVersion(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 64 && VERSION_RE.test(s)
}
/** 发布者名：3–32 个字符，首尾不能是 - */
export function isPublisherName(s: unknown): s is string {
  return typeof s === 'string' && PUBLISHER_RE.test(s)
}

/** F1：允许的文件名（samples/ 下不限）。商店安装时解压前用它再查一遍 */
export const EXT_ALLOWED_FILE_RE = /\.(json|md|png|svg|txt)$/i
/** F1：LICENSE 开头的文件名（LICENSE、LICENSE.txt、LICENSE-MIT …） */
export const EXT_LICENSE_FILE_RE = /^license/i
/**
 * F4：Windows 保留设备名（带不带扩展名都是；按路径的每一段查）。
 * 含上标数字的 COM¹²³ / LPT¹²³、CONIN$ / CONOUT$；Windows 先去扩展名再去结尾空格，所以 "nul .json" 也算
 */
export const EXT_WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[\d¹²³]|lpt[\d¹²³]|conin\$|conout\$) *(\..*)?$/i
/** F4：Windows 文件名里不能出现的字符（冒号单独处理，因为它在 NTFS 上是备用数据流） */
const EXT_WINDOWS_BAD_CHARS_RE = /[*?"<>|]/

/** 各层允许的字段；其余（除 x- 开头和 $schema）都算未知字段 */
const KEYS = {
  manifest: [
    'id',
    'name',
    'version',
    'publisher',
    'description',
    'icon',
    'keywords',
    'license',
    'repository',
    'homepage',
    'engines',
    'l10n',
    'contributes',
    'main',
    'permissions',
    'price',
  ],
  engines: ['pixelsky'],
  l10n: ['en'],
  l10nEn: ['name', 'description'],
  contributes: CONTRIBUTION_KINDS as readonly string[],
  text: ['zh', 'en'],
  grammars: [
    'language',
    'aliases',
    'extensions',
    'filenames',
    'filenamePatterns',
    'firstLine',
    'scopeName',
    'path',
    'configuration',
    'embeddedLanguages',
    'injectTo',
    'samples',
  ],
  themes: ['id', 'label', 'uiTheme', 'path'],
  snippets: ['language', 'path'],
  iconThemes: ['id', 'label', 'path', 'partial'],
  taskTemplates: ['id', 'label', 'icon', 'files', 'tasks', 'extract', 'runner', 'command', 'cwd'],
  taskDef: ['name', 'description', 'when'],
  taskExtract: ['pattern', 'flags', 'name', 'description'],
  taskExtractDescription: ['commentBefore'],
  taskRunner: ['windows', 'default', 'fallback', 'when'],
  skills: ['path', 'engines'],
  prompts: ['id', 'title', 'description', 'path', 'where', 'requires'],
} as const

/** 语言设置文件第一期生效的字段（§4.3） */
const CONFIG_KEYS = ['comments', 'brackets', 'autoClosingPairs', 'surroundingPairs', 'indentationRules', 'wordPattern']

const TEXT_EXTS = /\.(json|md|txt)$/i
const SKILL_FILE_EXTS = /\.(md|png|jpe?g|gif|webp|svg)$/i
const MAX_PER_CODE = 20

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isStr(v: unknown): v is string {
  return typeof v === 'string'
}
function validPath(v: unknown): v is string {
  return isStr(v) && v.length <= EXT_LIMITS.pathChars && PATH_RE.test(v)
}
function validText(v: unknown): boolean {
  if (isStr(v)) return v.length > 0
  if (!isRec(v)) return false
  return isStr(v.zh) && v.zh.length > 0 && (v.en === undefined || (isStr(v.en) && v.en.length > 0))
}

function unknownKeys(obj: Rec, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter(k => !allowed.includes(k) && !k.startsWith('x-') && k !== '$schema')
}

// ---------------------------------------------------------------------------
// 清单
// ---------------------------------------------------------------------------

export function validateManifest(
  raw: unknown,
  opts: { appVersion?: string; source: ExtPackSource },
): { manifest: ExtPackManifest | null; issues: ExtPackIssue[] } {
  const issues: ExtPackIssue[] = []
  const add = (
    severity: 'error' | 'warning',
    scope: 'pack' | 'file',
    code: ExtIssueCode,
    zh: string,
    en: string,
    path?: string,
  ) => issues.push(mk(severity, scope, code, zh, en, { path, upload: 'reject' }))
  const warn = (code: ExtIssueCode, zh: string, en: string, path?: string) => add('warning', 'pack', code, zh, en, path)
  const fatal = (code: ExtIssueCode, zh: string, en: string, path?: string) => add('error', 'pack', code, zh, en, path)

  // M1：调用方也可以直接传清单原文；严格 JSON 失败但 JSONC 能解析时给警告并继续
  let value: unknown = raw
  if (isStr(raw)) {
    try {
      value = JSON.parse(raw.replace(/^\uFEFF/, ''))
    } catch (e) {
      try {
        value = parseJsonc(raw)
        issues.push(manifestJsoncIssue(EXT_MANIFEST))
      } catch {
        const detail = e instanceof Error ? e.message : String(e)
        fatal(
          'manifest.parse',
          `${EXT_MANIFEST} 不是合法的 JSON：${detail}`,
          `${EXT_MANIFEST} is not valid JSON: ${detail}`,
        )
        return { manifest: null, issues }
      }
    }
  }
  // M2
  if (!isRec(value)) {
    fatal(
      'manifest.notObject',
      `${EXT_MANIFEST} 的最外层必须是对象`,
      `The top level of ${EXT_MANIFEST} must be an object`,
    )
    return { manifest: null, issues }
  }
  const m = value

  // M16：顶层未知字段
  for (const k of unknownKeys(m, KEYS.manifest)) {
    warn(
      'manifest.unknownField',
      `不认识的字段「${k}」，会被忽略（上传时拒绝）`,
      `Unknown field "${k}" is ignored (rejected on upload)`,
      k,
    )
  }
  // M3
  const id = m.id
  if (!isStr(id) || !ID_RE.test(id)) {
    fatal(
      'manifest.id',
      'id 必须是「发布者.名字」，全小写，只能用 a-z 0-9 -',
      'id must be "publisher.name" in lowercase, using only a-z 0-9 -',
      'id',
    )
  }
  // M4
  if (!isStr(m.publisher) || !PUBLISHER_RE.test(m.publisher)) {
    warn(
      'manifest.publisherMismatch',
      'publisher 必须是 3–32 个字符的发布者名',
      'publisher must be a 3–32 character publisher name',
      'publisher',
    )
  } else if (isStr(id) && id.split('.')[0] !== m.publisher) {
    warn(
      'manifest.publisherMismatch',
      'publisher 必须等于 id 点前面的部分',
      'publisher must equal the part of id before the dot',
      'publisher',
    )
  }
  // M5
  if (!isStr(m.name) || m.name.length < 1 || m.name.length > 40) {
    warn('manifest.name', 'name 必须是 1–40 个字符', 'name must be 1–40 characters', 'name')
  } else if (opts.source !== 'builtin' && /官方|像素星空/.test(m.name)) {
    warn('manifest.name', 'name 不能含「官方」「像素星空」字样', 'name must not contain 官方 or 像素星空', 'name')
  }
  // M6
  if (!isStr(m.version) || !VERSION_RE.test(m.version)) {
    warn(
      'manifest.version',
      'version 必须是语义化版本，如 1.0.0',
      'version must be a semantic version such as 1.0.0',
      'version',
    )
  }
  // M7
  if (!isStr(m.description) || m.description.length < 1 || m.description.length > 120) {
    warn(
      'manifest.description',
      'description 必须是 1–120 个字符',
      'description must be 1–120 characters',
      'description',
    )
  }
  // M8（只查写法；文件是否存在、大小、尺寸在 validateContributions 里查）
  if (m.icon !== undefined && !(validPath(m.icon) && /\.(png|svg)$/.test(m.icon))) {
    warn(
      'manifest.icon',
      'icon 必须是包内的 .png 或 .svg 路径',
      'icon must be a .png or .svg path inside the pack',
      'icon',
    )
  }
  // M9
  if (m.keywords !== undefined) {
    const k = m.keywords
    const ok =
      Array.isArray(k) &&
      k.length <= 10 &&
      new Set(k).size === k.length &&
      k.every(x => isStr(x) && x.length >= 1 && x.length <= 20)
    if (!ok)
      warn(
        'manifest.keywords',
        'keywords 最多 10 个，不能重复，每个 1–20 个字符',
        'keywords: at most 10, unique, 1–20 characters each',
        'keywords',
      )
  }
  // M10
  if (!isStr(m.license) || m.license.length === 0) {
    warn(
      'manifest.license',
      'license 必须是 SPDX 许可证标识，如 MIT',
      'license must be an SPDX identifier such as MIT',
      'license',
    )
  }
  // M11
  for (const key of ['repository', 'homepage'] as const) {
    const v = m[key]
    if (v !== undefined && v !== null && !(isStr(v) && v.startsWith('https://'))) {
      warn('manifest.url', `${key} 必须是 https 地址或 null`, `${key} must be an https URL or null`, key)
    }
  }
  // M12
  const engines = m.engines
  if (!isRec(engines) || !isStr(engines.pixelsky) || engines.pixelsky.trim() === '') {
    warn(
      'manifest.engines',
      'engines.pixelsky 必须写需要的软件版本范围，如 >=0.4.0',
      'engines.pixelsky must state the required app version range, e.g. >=0.4.0',
      'engines',
    )
  } else {
    for (const k of unknownKeys(engines, KEYS.engines)) {
      warn('manifest.unknownField', `engines 里不认识的字段「${k}」`, `Unknown field "${k}" in engines`, `engines.${k}`)
    }
    // 没给 appVersion（上传级别）只查写法，不判断软件版本够不够
    const ok = satisfiesEngine(engines.pixelsky, opts.appVersion ?? '0.0.0')
    if (ok === null) {
      warn(
        'manifest.engineRange',
        `engines.pixelsky 的写法解析不了：${engines.pixelsky}`,
        `Cannot parse engines.pixelsky: ${engines.pixelsky}`,
        'engines.pixelsky',
      )
    } else if (!ok && opts.appVersion !== undefined) {
      fatal(
        'manifest.engineUnmet',
        `需要像素星空 ${engines.pixelsky}（当前 ${opts.appVersion}）`,
        `Requires PixelSky ${engines.pixelsky} (current ${opts.appVersion})`,
        'engines.pixelsky',
      )
    }
  }
  // M13
  if (m.l10n !== undefined) {
    const l = m.l10n
    if (!isRec(l)) {
      warn('manifest.l10n', 'l10n 必须是对象', 'l10n must be an object', 'l10n')
    } else {
      for (const k of unknownKeys(l, KEYS.l10n)) {
        warn(
          'manifest.unknownField',
          `l10n 里不认识的字段「${k}」（目前只支持 en）`,
          `Unknown field "${k}" in l10n (only en is supported)`,
          `l10n.${k}`,
        )
      }
      const en = l.en
      if (en !== undefined) {
        if (!isRec(en)) {
          warn('manifest.l10n', 'l10n.en 必须是对象', 'l10n.en must be an object', 'l10n.en')
        } else {
          for (const k of unknownKeys(en, KEYS.l10nEn)) {
            warn(
              'manifest.unknownField',
              `l10n.en 里不认识的字段「${k}」`,
              `Unknown field "${k}" in l10n.en`,
              `l10n.en.${k}`,
            )
          }
          if (en.name !== undefined && !(isStr(en.name) && en.name.length <= 40)) {
            warn(
              'manifest.l10n',
              'l10n.en.name 最多 40 个字符',
              'l10n.en.name is at most 40 characters',
              'l10n.en.name',
            )
          }
          if (en.description !== undefined && !(isStr(en.description) && en.description.length <= 160)) {
            warn(
              'manifest.l10n',
              'l10n.en.description 最多 160 个字符',
              'l10n.en.description is at most 160 characters',
              'l10n.en.description',
            )
          }
        }
      }
    }
  }
  // M14
  const contributes = m.contributes
  if (!isRec(contributes)) {
    fatal(
      'manifest.contributes',
      'contributes 必须是对象，并且至少有一项贡献',
      'contributes must be an object with at least one contribution',
      'contributes',
    )
  } else {
    let nonEmpty = 0
    for (const k of Object.keys(contributes)) {
      if (!(KEYS.contributes as readonly string[]).includes(k)) {
        if (!k.startsWith('x-')) {
          warn(
            'manifest.unknownField',
            `contributes 里不认识的字段「${k}」，会被忽略`,
            `Unknown field "${k}" in contributes is ignored`,
            `contributes.${k}`,
          )
        }
        continue
      }
      const list = contributes[k]
      if (!Array.isArray(list)) {
        fatal(
          'manifest.contributes',
          `contributes.${k} 必须是数组`,
          `contributes.${k} must be an array`,
          `contributes.${k}`,
        )
      } else if (list.length > 0) nonEmpty++
    }
    if (nonEmpty === 0 && !issues.some(i => i.code === 'manifest.contributes')) {
      fatal(
        'manifest.contributes',
        'contributes 至少要有一项不为空的贡献',
        'contributes needs at least one non-empty contribution',
        'contributes',
      )
    }
  }
  // M15
  if (m.main !== null) {
    if (m.main === undefined) warn('manifest.main', 'main 必须写成 null', 'main must be written as null', 'main')
    else
      fatal(
        'manifest.main',
        '第一期扩展不能带代码，main 必须是 null',
        'Phase-1 extensions cannot contain code; main must be null',
        'main',
      )
  }
  if (!Array.isArray(m.permissions) || m.permissions.length > 0) {
    warn('manifest.permissions', 'permissions 第一期必须是 []', 'permissions must be [] in phase 1', 'permissions')
  }
  if (m.price !== null) warn('manifest.price', 'price 第一期必须是 null', 'price must be null in phase 1', 'price')

  return { manifest: m as unknown as ExtPackManifest, issues }
}

// ---------------------------------------------------------------------------
// 文件清单
// ---------------------------------------------------------------------------

/** 同一个代码最多报 MAX_PER_CODE 条，多出来的合成一条 */
class Capped {
  readonly issues: ExtPackIssue[] = []
  private readonly counts = new Map<string, number>()
  private readonly extra = new Map<
    string,
    {
      zh: string
      en: string
      severity: ExtPackIssue['severity']
      scope: ExtPackIssue['scope']
      upload?: ExtPackIssue['upload']
    }
  >()
  add(issue: ExtPackIssue): void {
    const n = (this.counts.get(issue.code) ?? 0) + 1
    this.counts.set(issue.code, n)
    if (n <= MAX_PER_CODE) this.issues.push(issue)
    else
      this.extra.set(issue.code, { zh: '', en: '', severity: issue.severity, scope: issue.scope, upload: issue.upload })
  }
  flush(): ExtPackIssue[] {
    for (const [code, e] of this.extra) {
      const rest = (this.counts.get(code) ?? 0) - MAX_PER_CODE
      this.issues.push(
        mk(
          e.severity,
          e.scope,
          code as ExtIssueCode,
          `还有 ${rest} 处同类问题没有列出`,
          `${rest} more of the same problem not listed`,
          { upload: e.upload },
        ),
      )
    }
    return this.issues
  }
}

export function validatePackFiles(
  files: ExtPackFileEntry[],
  manifest: ExtPackManifest | null,
  _opts: { source: ExtPackSource },
): ExtPackIssue[] {
  const out = new Capped()
  const warn = (code: ExtIssueCode, zh: string, en: string, path?: string) =>
    out.add(mk('warning', 'file', code, zh, en, { path, upload: 'reject' }))
  const real = files.filter(f => f.kind === 'file')
  const hasIconThemes = Array.isArray(manifest?.contributes?.iconThemes) && manifest.contributes.iconThemes.length > 0
  const seen = new Map<string, string>()
  let total = 0
  let samples = 0
  for (const f of real) {
    const p = f.path
    const inSamples = p.startsWith('samples/')
    const base = p.slice(p.lastIndexOf('/') + 1)
    total += f.size
    if (inSamples) samples += f.size
    // F4
    if (p.length > EXT_LIMITS.pathChars) {
      warn(
        'files.path',
        `路径超过 ${EXT_LIMITS.pathChars} 个字符：${p}`,
        `Path longer than ${EXT_LIMITS.pathChars} characters: ${p}`,
        p,
      )
    } else if (p.includes('\\')) {
      warn('files.path', `路径里只能用 /：${p}`, `Paths may only use /: ${p}`, p)
    }
    // NFC 归一后再比：macOS APFS 把 NFC / NFD 写法当同一个文件
    const lower = p.normalize('NFC').toLowerCase()
    const prev = seen.get(lower)
    if (prev !== undefined && prev !== p) {
      warn(
        'files.path',
        `只有大小写（或 Unicode 写法）不同的两个文件：${prev} 和 ${p}`,
        `Two files differ only in case or Unicode form: ${prev} and ${p}`,
        p,
      )
    }
    seen.set(lower, p)
    if (p.includes(':')) {
      warn(
        'files.path',
        `路径里不能有冒号（Windows 上会变成备用数据流）：${p}`,
        `Paths may not contain ":" (it becomes an alternate data stream on Windows): ${p}`,
        p,
      )
    }
    if (EXT_WINDOWS_BAD_CHARS_RE.test(p)) {
      warn(
        'files.path',
        `路径里不能有 * ? " < > | （Windows 文件名不允许）：${p}`,
        `Paths may not contain any of * ? " < > | (not allowed in Windows file names): ${p}`,
        p,
      )
    }
    const segs = p.split('/')
    const reserved = segs.find(seg => EXT_WINDOWS_RESERVED_RE.test(seg))
    if (reserved !== undefined) {
      warn(
        'files.path',
        `路径里有 Windows 保留名「${reserved}」：${p}`,
        `Path contains the Windows reserved name "${reserved}": ${p}`,
        p,
      )
    }
    // "." / ".." 段由来源层拒绝（zip.entryName），这里只查真正的名字
    const trailing = segs.find(seg => seg !== '.' && seg !== '..' && /[. ]$/.test(seg))
    if (trailing !== undefined) {
      warn(
        'files.path',
        `路径的每一段都不能以 . 或空格结尾（Windows 会把它去掉）：${p}`,
        `No path segment may end with "." or a space (Windows strips it): ${p}`,
        p,
      )
    }
    // F2
    if (!inSamples && p.split('/').some(seg => seg.startsWith('.'))) {
      warn('files.hidden', `不要放隐藏文件：${p}`, `Hidden files are not allowed: ${p}`, p)
    }
    // F1
    const allowed = inSamples || EXT_ALLOWED_FILE_RE.test(base) || EXT_LICENSE_FILE_RE.test(base)
    if (!allowed) {
      warn(
        'files.type',
        `不允许的文件类型（不会被执行）：${p}`,
        `File type not allowed (it is never executed): ${p}`,
        p,
      )
    }
    // F5
    if (f.size > EXT_LIMITS.fileBytes) {
      out.add(
        mk(
          'error',
          'file',
          'files.size',
          `文件超过 2 MB，不会被读取：${p}`,
          `File larger than 2 MB will not be read: ${p}`,
          { path: p, upload: 'reject' },
        ),
      )
    }
  }
  // F6
  const maxFiles = hasIconThemes ? EXT_LIMITS.filesWithIcons : EXT_LIMITS.files
  if (real.length > maxFiles) {
    out.add(
      mk(
        'warning',
        'pack',
        'files.count',
        `文件数 ${real.length} 超过上限 ${maxFiles}`,
        `${real.length} files exceed the limit of ${maxFiles}`,
        { upload: 'reject' },
      ),
    )
  }
  if (total > EXT_LIMITS.packBytes) {
    out.add(
      mk('warning', 'pack', 'files.total', '整个扩展超过 10 MB', 'The pack exceeds 10 MB in total', {
        upload: 'reject',
      }),
    )
  }
  if (samples > EXT_LIMITS.samplesBytes) {
    out.add(
      mk('warning', 'pack', 'files.samples', 'samples/ 合计超过 200 KB', 'samples/ exceeds 200 KB in total', {
        upload: 'reject',
      }),
    )
  }
  // F9
  if (!real.some(f => /^license(\.md|\.txt)?$/i.test(f.path))) {
    out.add(
      mk(
        'warning',
        'pack',
        'files.license',
        '缺少 LICENSE（也可以叫 LICENSE.md / LICENSE.txt）',
        'LICENSE is missing (LICENSE.md / LICENSE.txt also work)',
        { upload: 'reject' },
      ),
    )
  }
  if (!real.some(f => /^readme\.md$/i.test(f.path))) {
    out.add(mk('warning', 'pack', 'files.readme', '缺少 README.md', 'README.md is missing', { upload: 'reject' }))
  }
  return out.flush()
}

// ---------------------------------------------------------------------------
// 贡献
// ---------------------------------------------------------------------------

/** 一个 PNG 的宽高（从 IHDR 读）；不是 PNG 返回 null */
function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null
  const u32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0
  return { w: u32(16), h: u32(20) }
}

/** 图片文件检查：存在、大小、PNG 尺寸；有问题返回 {zh,en} */
function checkImage(reader: ExtPackReader, path: string, maxBytes: number): { zh: string; en: string } | null {
  if (!reader.exists(path)) return { zh: `图片不存在：${path}`, en: `Image not found: ${path}` }
  const size = reader.size(path)
  if (size !== null && size > maxBytes) {
    return {
      zh: `图片超过 ${Math.round(maxBytes / 1024)} KB：${path}`,
      en: `Image larger than ${Math.round(maxBytes / 1024)} KB: ${path}`,
    }
  }
  if (path.toLowerCase().endsWith('.png')) {
    const head = reader.readBytes(path, 32)
    const dim = head ? pngSize(head) : null
    if (!dim) return { zh: `不是有效的 PNG：${path}`, en: `Not a valid PNG: ${path}` }
    if (dim.w > 1024 || dim.h > 1024) {
      return {
        zh: `PNG 尺寸 ${dim.w}×${dim.h} 超过 1024×1024：${path}`,
        en: `PNG is ${dim.w}×${dim.h}, larger than 1024×1024: ${path}`,
      }
    }
  }
  return null
}

function decodeIssue(bytes: Uint8Array): 'bom' | 'invalid' | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'bom'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return null
  } catch {
    return 'invalid'
  }
}

/** 递归找语法里的 include，返回第一个指向内置作用域的 */
function findBuiltinInclude(node: unknown, depth = 0): string | null {
  if (depth > 64 || node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findBuiltinInclude(n, depth + 1)
      if (r) return r
    }
    return null
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'include' && isStr(v)) {
      const scope = v.split('#')[0]
      if (scope && EXT_BUILTIN_SCOPES.includes(scope)) return scope
    } else if (typeof v === 'object') {
      const r = findBuiltinInclude(v, depth + 1)
      if (r) return r
    }
  }
  return null
}

/** SKILL.md 的 frontmatter：只认 `key: value` 的简单写法 */
function parseFrontmatter(text: string): Record<string, string> | null {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!m) return null
  const out: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    let v = kv[2].trim()
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1)
    out[kv[1]] = v
  }
  return out
}

const THEME_MAX_DEPTH = 5

/** 读主题文件并展开 include 链；返回合并后的 colors / tokenColors，或错误原因 */
function loadTheme(
  reader: ExtPackReader,
  path: string,
  depth: number,
  chain: string[],
  refs: Set<string>,
): { colors: Rec; tokens: unknown[] } | { error: { zh: string; en: string } } {
  if (depth > THEME_MAX_DEPTH)
    return {
      error: { zh: `include 嵌套超过 ${THEME_MAX_DEPTH} 层`, en: `include nesting deeper than ${THEME_MAX_DEPTH}` },
    }
  if (chain.includes(path)) return { error: { zh: `include 循环：${path}`, en: `include cycle: ${path}` } }
  refs.add(path)
  const size = reader.size(path)
  if (!reader.exists(path)) return { error: { zh: `文件不存在：${path}`, en: `File not found: ${path}` } }
  if (size !== null && size > EXT_LIMITS.fileBytes)
    return { error: { zh: `文件超过 2 MB：${path}`, en: `File larger than 2 MB: ${path}` } }
  const text = reader.readText(path)
  if (text === null) return { error: { zh: `读不了文件：${path}`, en: `Cannot read file: ${path}` } }
  let json: unknown
  try {
    json = parseJsonc(text)
  } catch (e) {
    const d = e instanceof Error ? e.message : String(e)
    return { error: { zh: `${path} 不是合法的 JSON：${d}`, en: `${path} is not valid JSON: ${d}` } }
  }
  if (!isRec(json))
    return { error: { zh: `${path} 最外层必须是对象`, en: `${path} must be an object at the top level` } }
  let colors: Rec = {}
  let tokens: unknown[] = []
  if (json.include !== undefined) {
    const target = isStr(json.include) ? resolvePackPath(packDir(path), json.include) : null
    if (!target) return { error: { zh: `${path} 的 include 路径不对`, en: `Invalid include path in ${path}` } }
    const parent = loadTheme(reader, target, depth + 1, [...chain, path], refs)
    if ('error' in parent) return parent
    colors = parent.colors
    tokens = parent.tokens
  }
  if (isRec(json.colors)) colors = { ...colors, ...json.colors }
  if (Array.isArray(json.tokenColors)) tokens = [...tokens, ...json.tokenColors]
  return { colors, tokens }
}

export function validateContributions(
  manifest: ExtPackManifest,
  reader: ExtPackReader,
  _opts: { source: ExtPackSource },
): { issues: ExtPackIssue[]; skills: ExtPackSkillInfo[] } {
  const issues: ExtPackIssue[] = []
  const skills: ExtPackSkillInfo[] = []
  const refs = new Set<string>() // 被清单（直接或间接）引用的文件，给 files.unused 用
  const m = manifest as unknown as Rec
  const c = isRec(m.contributes) ? m.contributes : {}

  try {
    // M8：清单图标
    if (isStr(m.icon) && validPath(m.icon) && /\.(png|svg)$/.test(m.icon)) {
      refs.add(m.icon)
      const bad = checkImage(reader, m.icon, 200 * 1024)
      if (bad) issues.push(mk('warning', 'pack', 'manifest.icon', bad.zh, bad.en, { path: m.icon, upload: 'reject' }))
    }

    /** 某一条贡献的问题收集器 */
    const forItem = (kind: ExtPackContributionKind, index: number) => {
      const contribution = { kind, index }
      return {
        err: (code: ExtIssueCode, zh: string, en: string, path?: string) =>
          issues.push(mk('error', 'contribution', code, zh, en, { path, contribution, upload: 'reject' })),
        warn: (code: ExtIssueCode, zh: string, en: string, path?: string, upload: ExtPackIssue['upload'] = 'reject') =>
          issues.push(mk('warning', 'contribution', code, zh, en, { path, contribution, upload })),
        add: (i: ExtPackIssue) => issues.push({ ...i, contribution }),
        /** 检查这一条里的未知字段（M16） */
        unknown: (obj: Rec, allowed: readonly string[], base = '') => {
          for (const k of unknownKeys(obj, allowed)) {
            const p = base ? `${base}.${k}` : k
            issues.push(
              mk(
                'warning',
                'contribution',
                'manifest.unknownField',
                `不认识的字段「${p}」，会被忽略（上传时拒绝）`,
                `Unknown field "${p}" is ignored (rejected on upload)`,
                { path: p, contribution, upload: 'reject' },
              ),
            )
          }
        },
      }
    }
    const listOf = (kind: ExtPackContributionKind): unknown[] => (Array.isArray(c[kind]) ? (c[kind] as unknown[]) : [])
    /** 读 JSON / JSONC 文件；返回内容或失败原因 */
    const readJsonFile = (
      path: string,
      lenient: boolean,
    ): { value: unknown } | { error: { zh: string; en: string } } => {
      if (!reader.exists(path)) return { error: { zh: `文件不存在：${path}`, en: `File not found: ${path}` } }
      const size = reader.size(path)
      if (size !== null && size > EXT_LIMITS.fileBytes)
        return { error: { zh: `文件超过 2 MB：${path}`, en: `File larger than 2 MB: ${path}` } }
      const text = reader.readText(path)
      if (text === null)
        return { error: { zh: `读不了文件（不是 UTF-8？）：${path}`, en: `Cannot read file (not UTF-8?): ${path}` } }
      try {
        return { value: lenient ? parseJsonc(text) : JSON.parse(text) }
      } catch (e) {
        const d = e instanceof Error ? e.message : String(e)
        return { error: { zh: `${path} 不是合法的 JSON：${d}`, en: `${path} is not valid JSON: ${d}` } }
      }
    }

    // ---- 语法 ----
    const grammars = listOf('grammars')
    grammars.forEach((raw, i) => {
      const it = forItem('grammars', i)
      if (!isRec(raw)) return it.err('grammar.fields', '语法必须是对象', 'A grammar must be an object')
      it.unknown(raw, KEYS.grammars)
      // G1
      let ok = true
      const bad = (zh: string, en: string, path?: string) => {
        ok = false
        it.err('grammar.fields', zh, en, path)
      }
      if (!isStr(raw.scopeName) || !SCOPE_NAME_RE.test(raw.scopeName))
        bad('scopeName 写法不对', 'Invalid scopeName', 'scopeName')
      if (!validPath(raw.path) || !raw.path.endsWith('.tmLanguage.json'))
        bad('path 必须是包内的 .tmLanguage.json 文件', 'path must be a .tmLanguage.json file inside the pack', 'path')
      if (
        raw.language !== undefined &&
        !(isStr(raw.language) && raw.language.length <= 40 && LANGUAGE_RE.test(raw.language))
      ) {
        bad(
          'language 只能用小写字母、数字和 + # . -',
          'language may only use lowercase letters, digits and + # . -',
          'language',
        )
      }
      const strList = (v: unknown, re?: RegExp) => Array.isArray(v) && v.every(x => isStr(x) && (!re || re.test(x)))
      for (const [k, re] of [
        ['extensions', /^\.[^/\\]+$/],
        ['filenames', /^[^/\\]+$/],
        ['filenamePatterns', /^[^/\\]+$/],
      ] as const) {
        if (raw[k] !== undefined && !strList(raw[k], re)) bad(`${k} 写法不对`, `Invalid ${k}`, k)
      }
      if (raw.injectTo !== undefined && !(strList(raw.injectTo) && (raw.injectTo as unknown[]).length > 0))
        bad('injectTo 必须是非空的作用域列表', 'injectTo must be a non-empty list of scopes', 'injectTo')
      if (raw.firstLine !== undefined && raw.firstLine !== null && !isStr(raw.firstLine))
        bad('firstLine 必须是字符串或 null', 'firstLine must be a string or null', 'firstLine')
      if (raw.configuration !== undefined && !(validPath(raw.configuration) && raw.configuration.endsWith('.json')))
        bad(
          'configuration 必须是包内的 .json 文件',
          'configuration must be a .json file inside the pack',
          'configuration',
        )
      if (
        raw.embeddedLanguages !== undefined &&
        !(
          isRec(raw.embeddedLanguages) &&
          Object.values(raw.embeddedLanguages).every(v => isStr(v) && LANGUAGE_RE.test(v))
        )
      )
        bad('embeddedLanguages 写法不对', 'Invalid embeddedLanguages', 'embeddedLanguages')
      const hasMatcher =
        ['extensions', 'filenames', 'filenamePatterns', 'injectTo'].some(
          k => Array.isArray(raw[k]) && (raw[k] as unknown[]).length > 0,
        ) ||
        (isStr(raw.firstLine) && raw.firstLine !== '')
      if (!hasMatcher)
        bad(
          'extensions、filenames、filenamePatterns、firstLine、injectTo 至少写一个',
          'Provide at least one of extensions, filenames, filenamePatterns, firstLine, injectTo',
          'extensions',
        )
      if (raw.language === undefined && !Array.isArray(raw.injectTo))
        bad(
          '必须写 language（只有注入语法可以省略）',
          'language is required (only injection grammars may omit it)',
          'language',
        )
      // G3
      if (isStr(raw.firstLine) && raw.firstLine !== '') {
        try {
          new RegExp(raw.firstLine)
          if (hasNestedQuantifier(raw.firstLine)) {
            ok = false
            it.err(
              'grammar.firstLine',
              `firstLine 里有嵌套的量词（如 (a+)+），可能卡死编辑器：${raw.firstLine}`,
              `firstLine has nested quantifiers (e.g. (a+)+) that can hang the editor: ${raw.firstLine}`,
              'firstLine',
            )
          } else if (hasQuantifiedAlternation(raw.firstLine)) {
            ok = false
            it.err(
              'grammar.firstLine',
              `firstLine 里有被重复的分支组（如 (a|aa)+），可能卡死编辑器：${raw.firstLine}`,
              `firstLine has a repeated alternation group (e.g. (a|aa)+) that can hang the editor: ${raw.firstLine}`,
              'firstLine',
            )
          } else if (hasAmbiguousQuantifiers(raw.firstLine, EXT_FIRST_LINE_MAX)) {
            ok = false
            it.err(
              'grammar.firstLine',
              `firstLine 里有可以互相重叠的量词（如 a*a*a*a*b），可能卡死编辑器：${raw.firstLine}`,
              `firstLine has overlapping quantifiers (e.g. a*a*a*a*b) that can hang the editor: ${raw.firstLine}`,
              'firstLine',
            )
          }
        } catch {
          ok = false
          it.err(
            'grammar.firstLine',
            `firstLine 不是合法的正则：${raw.firstLine}`,
            `firstLine is not a valid regular expression: ${raw.firstLine}`,
            'firstLine',
          )
        }
      }
      // G10
      if (Array.isArray(raw.injectTo) && raw.injectTo.some(s => isStr(s) && EXT_BUILTIN_SCOPES.includes(s))) {
        it.warn(
          'grammar.injectBuiltin',
          '注入到内置语言暂时不生效（内置语言不是 TextMate 语法）',
          'Injecting into built-in languages has no effect yet (they are not TextMate grammars)',
          'injectTo',
          'hint',
        )
      }
      // G6
      const samples = Array.isArray(raw.samples) ? raw.samples.filter(isStr) : []
      for (const s of samples) refs.add(s)
      const existing = samples.filter(s => validPath(s) && s.startsWith('samples/') && reader.exists(s))
      if (existing.length === 0) {
        it.warn(
          'grammar.samples',
          '至少要有一个存在的示例文件（放在 samples/ 下）',
          'At least one existing sample file under samples/ is required',
          'samples',
        )
      } else if (existing.length < samples.length) {
        it.warn(
          'grammar.samples',
          '有的示例文件不存在，或不在 samples/ 下',
          'Some sample files are missing or not under samples/',
          'samples',
        )
      }
      if (!ok || !validPath(raw.path)) return
      refs.add(raw.path)
      // G2
      const file = readJsonFile(raw.path, false)
      if ('error' in file) {
        it.err('grammar.file', file.error.zh, file.error.en, raw.path)
        return
      }
      if (!isRec(file.value) || file.value.scopeName !== raw.scopeName) {
        it.err(
          'grammar.file',
          `语法文件的 scopeName 必须是 ${String(raw.scopeName)}`,
          `scopeName in the grammar file must be ${String(raw.scopeName)}`,
          raw.path,
        )
        return
      }
      // G9
      const builtin = findBuiltinInclude(file.value)
      if (builtin) {
        it.warn(
          'grammar.includeBuiltinScope',
          `include 了内置作用域 ${builtin}，暂时不生效`,
          `include of built-in scope ${builtin} has no effect yet`,
          raw.path,
          'hint',
        )
      }
      // G4 / G5
      if (isStr(raw.configuration) && validPath(raw.configuration)) {
        refs.add(raw.configuration)
        const cfg = readJsonFile(raw.configuration, true)
        if ('error' in cfg || !isRec(cfg.value)) {
          it.warn(
            'grammar.configuration',
            '语言设置文件不存在或不是合法的 JSON，会被忽略',
            'The language configuration is missing or not valid JSON and is ignored',
            raw.configuration,
          )
        } else {
          const ignored = Object.keys(cfg.value).filter(k => !CONFIG_KEYS.includes(k))
          if (ignored.length) {
            it.warn(
              'grammar.configIgnored',
              `这些字段暂不生效：${ignored.join('、')}`,
              `These fields have no effect yet: ${ignored.join(', ')}`,
              raw.configuration,
              'hint',
            )
          }
        }
      }
    })
    // ---- 主题 ----
    const themeIds = new Set<string>()
    listOf('themes').forEach((raw, i) => {
      const it = forItem('themes', i)
      if (!isRec(raw)) return it.err('theme.fields', '主题必须是对象', 'A theme must be an object')
      it.unknown(raw, KEYS.themes)
      let ok = true
      const bad = (zh: string, en: string, path?: string) => {
        ok = false
        it.err('theme.fields', zh, en, path)
      }
      if (!isStr(raw.id) || raw.id.length > 48 || !LOCAL_ID_RE.test(raw.id))
        bad('id 只能用小写字母、数字和 -', 'id may only use lowercase letters, digits and -', 'id')
      else if (themeIds.has(raw.id)) bad(`主题 id 重复：${raw.id}`, `Duplicate theme id: ${raw.id}`, 'id')
      else themeIds.add(raw.id)
      if (!validText(raw.label))
        bad('label 必须是非空文字或 { zh, en }', 'label must be non-empty text or { zh, en }', 'label')
      if (raw.uiTheme !== 'dark' && raw.uiTheme !== 'light')
        bad('uiTheme 必须是 dark 或 light', 'uiTheme must be dark or light', 'uiTheme')
      if (!validPath(raw.path) || !raw.path.endsWith('.json'))
        bad('path 必须是包内的 .json 文件', 'path must be a .json file inside the pack', 'path')
      if (!ok || !isStr(raw.path)) return
      const themeRefs = new Set<string>()
      const theme = loadTheme(reader, raw.path, 0, [], themeRefs)
      for (const r of themeRefs) refs.add(r)
      if ('error' in theme) return it.err('theme.file', theme.error.zh, theme.error.en, raw.path)
      // TH3
      const bg = theme.colors['editor.background']
      const fg = theme.colors['editor.foreground']
      if (!isStr(bg) || !isStr(fg)) {
        it.warn(
          'theme.requiredColors',
          '必须写 editor.background 和 editor.foreground',
          'editor.background and editor.foreground are required',
          raw.path,
        )
      }
      // TH4
      const badColors: string[] = []
      for (const [k, v] of Object.entries(theme.colors)) if (isStr(v) && !parseHexColor(v)) badColors.push(k)
      let commentFg: string | null = null
      for (const t of theme.tokens) {
        if (!isRec(t) || !isRec(t.settings)) continue
        const f = t.settings.foreground
        if (f === undefined) continue
        if (!isStr(f) || !parseHexColor(f)) badColors.push(`tokenColors(${isStr(f) ? f : '?'})`)
        else {
          const scopes = isStr(t.scope) ? t.scope.split(',') : Array.isArray(t.scope) ? t.scope : []
          if (scopes.some(s => isStr(s) && s.trim() === 'comment')) commentFg = f
        }
      }
      if (badColors.length) {
        it.warn(
          'theme.color',
          `这些颜色写法不对，已忽略：${badColors.slice(0, 5).join('、')}${badColors.length > 5 ? ' …' : ''}`,
          `Invalid colors are ignored: ${badColors.slice(0, 5).join(', ')}${badColors.length > 5 ? ' …' : ''}`,
          raw.path,
        )
      }
      // TH5
      if (isStr(bg) && isStr(fg)) {
        const r = contrastRatio(fg, bg)
        if (r !== null && r < 4.5) {
          it.warn(
            'theme.contrast',
            `文字和背景的对比度 ${r.toFixed(1)}:1，低于 4.5:1`,
            `Text/background contrast is ${r.toFixed(1)}:1, below 4.5:1`,
            raw.path,
            'hint',
          )
        }
        if (commentFg) {
          const rc = contrastRatio(commentFg, bg)
          if (rc !== null && rc < 3) {
            it.warn(
              'theme.contrast',
              `注释和背景的对比度 ${rc.toFixed(1)}:1，低于 3:1`,
              `Comment/background contrast is ${rc.toFixed(1)}:1, below 3:1`,
              raw.path,
              'hint',
            )
          }
        }
      }
    })

    // ---- 片段 ----
    listOf('snippets').forEach((raw, i) => {
      const it = forItem('snippets', i)
      if (!isRec(raw)) return it.err('snippets.fields', '片段配置必须是对象', 'A snippets entry must be an object')
      it.unknown(raw, KEYS.snippets)
      if (!isStr(raw.language) || raw.language.length > 40 || !LANGUAGE_RE.test(raw.language)) {
        return it.err(
          'snippets.fields',
          'language 只能用小写字母、数字和 + # . -',
          'language may only use lowercase letters, digits and + # . -',
          'language',
        )
      }
      if (!validPath(raw.path) || !raw.path.endsWith('.json')) {
        return it.err(
          'snippets.fields',
          'path 必须是包内的 .json 文件',
          'path must be a .json file inside the pack',
          'path',
        )
      }
      refs.add(raw.path)
      const file = readJsonFile(raw.path, true)
      if ('error' in file) return it.err('snippets.file', file.error.zh, file.error.en, raw.path)
      if (!isRec(file.value))
        return it.err(
          'snippets.file',
          '片段文件最外层必须是对象',
          'The snippets file must be an object at the top level',
          raw.path,
        )
      const entries = Object.entries(file.value)
      if (entries.length > EXT_LIMITS.snippetsPerFile) {
        it.warn(
          'snippets.entry',
          `片段超过 ${EXT_LIMITS.snippetsPerFile} 个，多出的被忽略`,
          `More than ${EXT_LIMITS.snippetsPerFile} snippets; the rest are ignored`,
          raw.path,
        )
      }
      const strOrList = (v: unknown) => isStr(v) || (Array.isArray(v) && v.length > 0 && v.every(isStr))
      let shown = 0
      for (const [name, def] of entries.slice(0, EXT_LIMITS.snippetsPerFile)) {
        const prefixes = isRec(def)
          ? isStr(def.prefix)
            ? [def.prefix]
            : Array.isArray(def.prefix)
              ? def.prefix
              : null
          : null
        const good =
          isRec(def) &&
          prefixes !== null &&
          prefixes.length > 0 &&
          prefixes.every(p => isStr(p) && p.length >= 1 && p.length <= EXT_LIMITS.snippetPrefixChars) &&
          strOrList(def.body)
        if (!good && shown++ < MAX_PER_CODE) {
          it.warn(
            'snippets.entry',
            `片段「${name}」的 prefix（≤30 个字符）或 body 写法不对，已忽略`,
            `Snippet "${name}" has an invalid prefix (up to 30 characters) or body and is ignored`,
            raw.path,
          )
        }
      }
    })

    // ---- 文件图标 ----
    const iconIds = new Set<string>()
    listOf('iconThemes').forEach((raw, i) => {
      const it = forItem('iconThemes', i)
      if (!isRec(raw)) return it.err('iconTheme.fields', '图标主题必须是对象', 'An icon theme must be an object')
      it.unknown(raw, KEYS.iconThemes)
      let ok = true
      const bad = (zh: string, en: string, path?: string) => {
        ok = false
        it.err('iconTheme.fields', zh, en, path)
      }
      if (!isStr(raw.id) || raw.id.length > 48 || !LOCAL_ID_RE.test(raw.id))
        bad('id 只能用小写字母、数字和 -', 'id may only use lowercase letters, digits and -', 'id')
      else if (iconIds.has(raw.id)) bad(`图标主题 id 重复：${raw.id}`, `Duplicate icon theme id: ${raw.id}`, 'id')
      else iconIds.add(raw.id)
      if (!validText(raw.label))
        bad('label 必须是非空文字或 { zh, en }', 'label must be non-empty text or { zh, en }', 'label')
      if (!validPath(raw.path) || !raw.path.endsWith('.json'))
        bad('path 必须是包内的 .json 文件', 'path must be a .json file inside the pack', 'path')
      if (raw.partial !== undefined && typeof raw.partial !== 'boolean')
        bad('partial 必须是 true 或 false', 'partial must be true or false', 'partial')
      if (!ok || !isStr(raw.path)) return
      refs.add(raw.path)
      const file = readJsonFile(raw.path, true)
      if ('error' in file) return it.err('iconTheme.file', file.error.zh, file.error.en, raw.path)
      const theme = file.value
      if (!isRec(theme) || !isRec(theme.iconDefinitions)) {
        return it.err(
          'iconTheme.file',
          '图标主题文件必须是带 iconDefinitions 的对象',
          'The icon theme file must be an object with iconDefinitions',
          raw.path,
        )
      }
      const defs = Object.entries(theme.iconDefinitions)
      // I3
      if (
        (Array.isArray(theme.fonts) && theme.fonts.length > 0) ||
        defs.some(([, d]) => isRec(d) && d.fontCharacter !== undefined)
      ) {
        return it.err(
          'iconTheme.fonts',
          '不支持字体图标（fonts / fontCharacter）',
          'Icon fonts (fonts / fontCharacter) are not supported',
          raw.path,
        )
      }
      // I4
      const themeDir = packDir(raw.path)
      let badCount = 0
      for (const [name, d] of defs) {
        if (!isRec(d) || !isStr(d.iconPath)) continue
        const target = resolvePackPath(themeDir, d.iconPath)
        let problem: { zh: string; en: string } | null = null
        if (!target || !/\.(svg|png)$/i.test(target))
          problem = {
            zh: `图标 ${name} 的路径不对或不是 .svg / .png：${d.iconPath}`,
            en: `Icon ${name} has an invalid path or is not .svg / .png: ${d.iconPath}`,
          }
        else {
          refs.add(target)
          if (!reader.exists(target))
            problem = { zh: `图标 ${name} 的文件不存在：${target}`, en: `Icon ${name} file not found: ${target}` }
          else {
            const size = reader.size(target)
            if (size !== null && size > EXT_LIMITS.iconBytes)
              problem = { zh: `图标 ${name} 超过 32 KB：${target}`, en: `Icon ${name} is larger than 32 KB: ${target}` }
          }
        }
        if (problem) {
          badCount++
          if (badCount <= MAX_PER_CODE) it.warn('iconTheme.iconPath', problem.zh, problem.en, raw.path)
        }
      }
      if (badCount > MAX_PER_CODE) {
        const rest = badCount - MAX_PER_CODE
        it.warn(
          'iconTheme.iconPath',
          `还有 ${rest} 个图标有同样的问题`,
          `${rest} more icons have the same problem`,
          raw.path,
        )
      }
      // I5
      if (raw.partial !== true && (!isStr(theme.file) || !isStr(theme.folder))) {
        it.warn(
          'iconTheme.default',
          '完整的图标主题要写 file 和 folder 默认图标',
          'A full icon theme needs default file and folder icons',
          raw.path,
        )
      }
    })

    // ---- 任务模板 ----
    listOf('taskTemplates').forEach((raw, i) => {
      const it = forItem('taskTemplates', i)
      if (isRec(raw)) {
        it.unknown(raw, KEYS.taskTemplates)
        if (Array.isArray(raw.tasks)) {
          raw.tasks.forEach((t, j) => isRec(t) && it.unknown(t, KEYS.taskDef, `tasks[${j}]`))
        }
        if (Array.isArray(raw.extract)) {
          raw.extract.forEach((e, j) => {
            if (!isRec(e)) return
            it.unknown(e, KEYS.taskExtract, `extract[${j}]`)
            if (isRec(e.description))
              it.unknown(e.description, KEYS.taskExtractDescription, `extract[${j}].description`)
          })
        }
        if (isRec(raw.runner)) it.unknown(raw.runner, KEYS.taskRunner, 'runner')
      }
      const { issues: found } = validateTaskTemplate(raw)
      for (const f of found) it.add(f)
      if (isRec(raw) && isStr(raw.icon) && validPath(raw.icon) && /\.(png|svg)$/.test(raw.icon)) {
        refs.add(raw.icon)
        const badIcon = checkImage(reader, raw.icon, EXT_LIMITS.iconBytes)
        if (badIcon) it.warn('task.icon', badIcon.zh, badIcon.en, raw.icon)
      }
    })

    // ---- 技能 ----
    const skillNames = new Set<string>()
    listOf('skills').forEach((raw, i) => {
      const it = forItem('skills', i)
      if (!isRec(raw)) return it.err('skill.path', '技能必须是对象', 'A skill must be an object')
      it.unknown(raw, KEYS.skills)
      if (!validPath(raw.path))
        return it.err(
          'skill.path',
          'path 必须是包内的技能文件夹',
          'path must be a skill folder inside the pack',
          'path',
        )
      const dir = raw.path.replace(/\/+$/, '')
      // SK4
      let engines: Array<'claude' | 'codex'> = ['claude', 'codex']
      if (raw.engines !== undefined) {
        const e = raw.engines
        const ok =
          Array.isArray(e) &&
          e.length > 0 &&
          new Set(e).size === e.length &&
          e.every(x => x === 'claude' || x === 'codex')
        if (!ok)
          return it.err(
            'skill.engines',
            'engines 只能是 claude、codex，不能重复',
            'engines may only be claude and codex, without duplicates',
            'engines',
          )
        engines = e as Array<'claude' | 'codex'>
      }
      // SK1
      const skillFile = `${dir}/SKILL.md`
      if (!reader.exists(skillFile))
        return it.err('skill.path', `文件夹里没有 SKILL.md：${dir}`, `SKILL.md not found in folder: ${dir}`, dir)
      // SK3
      const all = reader.list(`${dir}/`).filter(p => p.startsWith(`${dir}/`))
      for (const p of all) refs.add(p)
      const strange = all.filter(p => !SKILL_FILE_EXTS.test(p))
      if (strange.length) {
        return it.err(
          'skill.files',
          `技能文件夹里只能放 .md 和图片：${strange.slice(0, 3).join('、')}${strange.length > 3 ? ' …' : ''}`,
          `Only .md and images are allowed in a skill folder: ${strange.slice(0, 3).join(', ')}${strange.length > 3 ? ' …' : ''}`,
          dir,
        )
      }
      // SK2
      const text = reader.readText(skillFile)
      const fm = text === null ? null : parseFrontmatter(text)
      if (!fm)
        return it.err(
          'skill.frontmatter',
          'SKILL.md 开头要有 --- 包起来的 name 和 description',
          'SKILL.md must start with a --- block containing name and description',
          skillFile,
        )
      if (!/^[a-z0-9-]{1,64}$/.test(fm.name ?? ''))
        return it.err(
          'skill.frontmatter',
          'name 只能用小写字母、数字和 -，不超过 64 个字符',
          'name may only use lowercase letters, digits and -, up to 64 characters',
          skillFile,
        )
      if (skillNames.has(fm.name))
        return it.err('skill.frontmatter', `技能名重复：${fm.name}`, `Duplicate skill name: ${fm.name}`, skillFile)
      if (!fm.description || fm.description.length > 1024)
        return it.err(
          'skill.frontmatter',
          'description 必须是 1–1024 个字符',
          'description must be 1–1024 characters',
          skillFile,
        )
      skillNames.add(fm.name)
      skills.push({ name: fm.name, description: fm.description, engines, index: i })
    })

    // ---- 提示词 ----
    const promptIds = new Set<string>()
    listOf('prompts').forEach((raw, i) => {
      const it = forItem('prompts', i)
      if (!isRec(raw)) return it.err('prompt.fields', '提示词必须是对象', 'A prompt must be an object')
      it.unknown(raw, KEYS.prompts)
      let ok = true
      const bad = (zh: string, en: string, path?: string) => {
        ok = false
        it.err('prompt.fields', zh, en, path)
      }
      if (!isStr(raw.id) || raw.id.length > 48 || !LOCAL_ID_RE.test(raw.id))
        bad('id 只能用小写字母、数字和 -', 'id may only use lowercase letters, digits and -', 'id')
      else if (promptIds.has(raw.id)) bad(`提示词 id 重复：${raw.id}`, `Duplicate prompt id: ${raw.id}`, 'id')
      else promptIds.add(raw.id)
      if (!validText(raw.title))
        bad('title 必须是非空文字或 { zh, en }', 'title must be non-empty text or { zh, en }', 'title')
      if (raw.description !== undefined && !validText(raw.description))
        bad(
          'description 必须是非空文字或 { zh, en }',
          'description must be non-empty text or { zh, en }',
          'description',
        )
      if (!validPath(raw.path) || !raw.path.endsWith('.md'))
        bad('path 必须是包内的 .md 文件', 'path must be a .md file inside the pack', 'path')
      if (raw.where !== undefined) {
        const w = raw.where
        if (
          !(
            Array.isArray(w) &&
            w.length > 0 &&
            new Set(w).size === w.length &&
            w.every(x => x === 'composer' || x === 'editor')
          )
        )
          bad('where 只能是 composer、editor', 'where may only be composer and editor', 'where')
      }
      if (raw.requires !== undefined && raw.requires !== 'selection')
        bad('requires 只能是 selection', 'requires may only be selection', 'requires')
      if (!ok || !isStr(raw.path)) return
      refs.add(raw.path)
      if (!reader.exists(raw.path))
        return it.err('prompt.body', `文件不存在：${raw.path}`, `File not found: ${raw.path}`, raw.path)
      const text = reader.readText(raw.path)
      if (text === null)
        return it.err(
          'prompt.body',
          `读不了文件（不是 UTF-8？）：${raw.path}`,
          `Cannot read file (not UTF-8?): ${raw.path}`,
          raw.path,
        )
      if (text.length > EXT_LIMITS.promptChars)
        return it.err(
          'prompt.body',
          `正文超过 ${EXT_LIMITS.promptChars} 个字符`,
          `Body is longer than ${EXT_LIMITS.promptChars} characters`,
          raw.path,
        )
    })

    // ---- F11 编码 / F10 未使用的文件 ----
    const all = reader.list('')
    let encodingShown = 0
    let unusedShown = 0
    let unusedTotal = 0
    for (const p of all) {
      const base = p.slice(p.lastIndexOf('/') + 1)
      if (TEXT_EXTS.test(base) || /^license/i.test(base) || p.startsWith('samples/')) {
        const size = reader.size(p)
        if (size !== null && size <= EXT_LIMITS.fileBytes) {
          const bytes = reader.readBytes(p, EXT_LIMITS.fileBytes)
          const problem = bytes ? decodeIssue(bytes) : null
          if (problem && encodingShown++ < MAX_PER_CODE) {
            issues.push(
              problem === 'bom'
                ? mk(
                    'warning',
                    'file',
                    'files.encoding',
                    `文件带 BOM，请存成不带 BOM 的 UTF-8：${p}`,
                    `File has a BOM; save as UTF-8 without BOM: ${p}`,
                    { path: p, upload: 'reject' },
                  )
                : mk(
                    'warning',
                    'file',
                    'files.encoding',
                    `文件不是合法的 UTF-8：${p}`,
                    `File is not valid UTF-8: ${p}`,
                    { path: p, upload: 'reject' },
                  ),
            )
          }
        }
      }
      const exempt =
        p === EXT_MANIFEST ||
        p.startsWith('samples/') ||
        /^(readme|license|changelog)(\.[a-z]+)?$/i.test(p) ||
        refs.has(p)
      if (!exempt) {
        unusedTotal++
        if (unusedShown++ < MAX_PER_CODE) {
          issues.push(
            mk(
              'warning',
              'file',
              'files.unused',
              `清单没有引用这个文件：${p}`,
              `File is not referenced by the manifest: ${p}`,
              { path: p, upload: 'hint' },
            ),
          )
        }
      }
    }
    if (unusedTotal > MAX_PER_CODE) {
      issues.push(
        mk(
          'warning',
          'pack',
          'files.unused',
          `还有 ${unusedTotal - MAX_PER_CODE} 个没有引用的文件`,
          `${unusedTotal - MAX_PER_CODE} more unreferenced files`,
          { upload: 'hint' },
        ),
      )
    }
  } catch (e) {
    // 校验器自己出了意外：当作一条警告，不能让整个扩展加载崩掉
    const d = e instanceof Error ? e.message : String(e)
    issues.push(
      mk('warning', 'pack', 'validate.internal', `校验时出现意外：${d}`, `Unexpected error while validating: ${d}`),
    )
  }
  return { issues, skills }
}

/** 要停用的清单下标：每个带 scope:'contribution' 错误的条目（下标升序、去重） */
export function inactiveContributions(_manifest: ExtPackManifest, issues: ExtPackIssue[]): ExtPackInactive {
  const sets = new Map<ExtPackContributionKind, Set<number>>()
  for (const i of issues) {
    if (i.severity !== 'error' || i.scope !== 'contribution' || !i.contribution) continue
    const { kind, index } = i.contribution
    if (!CONTRIBUTION_KINDS.includes(kind)) continue
    if (!sets.has(kind)) sets.set(kind, new Set())
    sets.get(kind)!.add(index)
  }
  const out: ExtPackInactive = {}
  for (const [kind, set] of sets) out[kind] = [...set].sort((a, b) => a - b)
  return out
}

export function packStatus(issues: ExtPackIssue[]): ExtPackInfo['status'] {
  if (issues.some(i => i.severity === 'error' && i.scope === 'pack')) return 'error'
  return issues.length > 0 ? 'warning' : 'ok'
}

/** 加载器 / 服务自己产生的问题 */
export function loaderIssue(
  code:
    | 'manifest.missing'
    | 'files.scanLimit'
    | 'pack.duplicateId'
    | 'pack.storeBlocked'
    | 'svg.unsafe'
    | 'files.symlink',
  params?: { path?: string; id?: string; reason?: string },
): ExtPackIssue {
  const path = params?.path
  const id = params?.id ?? ''
  const reason = params?.reason ?? ''
  const where = path ? `：${path}` : ''
  const whereEn = path ? `: ${path}` : ''
  switch (code) {
    case 'manifest.missing':
      return mk(
        'error',
        'pack',
        code,
        `找不到清单文件 ${EXT_MANIFEST}，这个扩展没有加载`,
        `${EXT_MANIFEST} not found; the extension is not loaded`,
        { path, upload: 'reject' },
      )
    case 'files.scanLimit':
      return mk(
        'error',
        'pack',
        code,
        '文件太多或太大（超过 5000 个文件或 50 MB），这个扩展没有加载',
        'Too many or too large files (more than 5000 files or 50 MB); the extension is not loaded',
        { path, upload: 'reject' },
      )
    case 'pack.duplicateId':
      return mk(
        'error',
        'pack',
        code,
        `已经有另一个扩展用了 id「${id}」，这个没有加载`,
        `Another extension already uses the id "${id}"; this one is not loaded`,
        { path, upload: 'reject' },
      )
    case 'pack.storeBlocked':
      // 只在本机产生（停用名单命中文件夹扩展），不带 upload
      return mk(
        'warning',
        'pack',
        code,
        `这个版本在商店里已被平台停用：${reason}`,
        `This version has been disabled by the platform in the store: ${reason}`,
      )
    case 'svg.unsafe':
      return mk(
        'error',
        'file',
        code,
        `SVG 含有脚本或外部引用，不会被使用${where}`,
        `SVG contains scripts or external references and is not used${whereEn}`,
        { path, upload: 'reject' },
      )
    case 'files.symlink':
      return mk(
        'error',
        'file',
        code,
        `符号链接不会被读取或提供${where}`,
        `Symbolic links are never read or served${whereEn}`,
        { path, upload: 'reject' },
      )
  }
}

/** 内置扩展：只留 severity 'error'（作者提示对随包扩展没有意义） */
export function forSource(issues: ExtPackIssue[], source: ExtPackSource): ExtPackIssue[] {
  return source === 'builtin' ? issues.filter(i => i.severity === 'error') : issues
}
