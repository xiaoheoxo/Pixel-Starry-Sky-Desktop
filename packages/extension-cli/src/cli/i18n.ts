export type Lang = 'zh' | 'en'

function fromLocale(s: string | undefined): Lang | null {
  if (!s) return null
  const v = s.trim()
  if (!v || v === 'C' || v === 'POSIX') return null
  return /^zh/i.test(v) ? 'zh' : 'en'
}

/** --lang > PIXELSKY_LANG > LC_ALL / LC_MESSAGES / LANG > 系统区域；zh 开头用中文，否则英文 */
export function pickLang(flag: string | undefined, env: NodeJS.ProcessEnv, locale: string): Lang {
  if (flag === 'zh' || flag === 'en') return flag
  for (const key of ['PIXELSKY_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const l = fromLocale(env[key])
    if (l) return l
  }
  return fromLocale(locale) ?? 'en'
}

type Msg = { zh: string; en: string }

const MESSAGES: Record<string, Msg> = {
  // 用法错误
  'err.noCommand': { zh: '缺少命令（validate / pack / help）', en: 'Missing command (validate / pack / help)' },
  'err.unknownCommand': { zh: '不认识的命令：{name}', en: 'Unknown command: {name}' },
  'err.badOption': { zh: '参数不对：{detail}', en: 'Bad option: {detail}' },
  'err.extraArg': { zh: '多出来的参数：{name}', en: 'Unexpected argument: {name}' },
  'err.badValue': { zh: '{flag} 的值只能是 {allowed}，收到 {got}', en: '{flag} must be one of {allowed}, got {got}' },
  'err.notFor': { zh: '{flag} 不适用于 {command}', en: '{flag} does not apply to {command}' },
  'err.devGrammar': {
    zh: '--level dev 不跑语法引擎，--grammar 只能是 off',
    en: '--level dev does not run the grammar engine; --grammar must be off',
  },
  'err.uploadAppVersion': {
    zh: '--app-version 只在 --level dev 时有用',
    en: '--app-version only applies with --level dev',
  },
  'err.badAppVersion': {
    zh: '--app-version 要写成 x.y.z，收到 {got}',
    en: '--app-version must look like x.y.z, got {got}',
  },
  'err.packNeedsFolder': {
    zh: 'pack 要的是扩展文件夹，不是文件：{path}',
    en: 'pack needs an extension folder, not a file: {path}',
  },
  'err.outParent': { zh: '--out 的上级文件夹不存在：{path}', en: 'The parent folder of --out does not exist: {path}' },
  'err.outNotZip': {
    zh: '--out 要写成 .zip 结尾的文件路径，或一个已有的文件夹：{path}',
    en: '--out must be a path ending in .zip, or an existing folder: {path}',
  },
  'err.outInside': {
    zh: '--out 在扩展文件夹的子文件夹里（下次打包会把 zip 打进去）：{path}。放到别处，或直接放在扩展根目录',
    en: '--out is inside a subfolder of the extension (the next pack would include the zip): {path}. Put it elsewhere, or directly in the extension root',
  },
  'err.hint': { zh: '用 pixelsky-ext help 查看用法', en: 'Run pixelsky-ext help for usage' },
  'err.packMismatch': {
    zh: '打包后回读核对不一致（{detail}）：没有写出 zip。这是工具的问题，请反馈',
    en: 'Read-back check of the packed zip disagrees ({detail}): no zip was written. This is a tool bug, please report it',
  },
  'err.writeFailed': { zh: '写出 zip 失败：{detail}', en: 'Failed to write the zip: {detail}' },
  // 文字报告
  ver: {
    zh: 'pixelsky-ext {tool}（规则 v{rules}，同像素星空 {app}）',
    en: 'pixelsky-ext {tool} (rules v{rules}, matches PixelSky {app})',
  },
  'head.folder.upload': { zh: '检查 {path}（文件夹，按上传标准）', en: 'Checking {path} (folder, upload level)' },
  'head.folder.dev': { zh: '检查 {path}（文件夹，按开发者模式）', en: 'Checking {path} (folder, dev level)' },
  'head.zip.upload': { zh: '检查 {path}（zip，按上传标准）', en: 'Checking {path} (zip, upload level)' },
  'head.pack': {
    zh: '打包 {path}（文件夹，先按上传标准检查）',
    en: 'Packing {path} (folder, checked at upload level first)',
  },
  'pack.counts': { zh: '{files} 个文件，{size}', en: '{files} files, {size}' },
  'kind.grammars': { zh: '语法高亮', en: 'grammars' },
  'kind.themes': { zh: '主题', en: 'themes' },
  'kind.snippets': { zh: '代码片段', en: 'snippets' },
  'kind.iconThemes': { zh: '图标主题', en: 'icon themes' },
  'kind.taskTemplates': { zh: '任务模板', en: 'task templates' },
  'kind.skills': { zh: '技能', en: 'skills' },
  'kind.prompts': { zh: '提示词', en: 'prompts' },
  'kind.uiThemes': { zh: '界面主题', en: 'UI themes' },
  noIssues: { zh: '没有问题。', en: 'No issues.' },
  'group.reject': { zh: '会被拒绝', en: 'Will be rejected' },
  'group.hint': { zh: '提示', en: 'Hints' },
  'group.note': { zh: '仅本地', en: 'Local only' },
  'group.error': { zh: '错误', en: 'Errors' },
  'group.warning': { zh: '警告', en: 'Warnings' },
  'loc.pack': { zh: '（扩展）', en: '(pack)' },
  'grammar.label': { zh: '语法', en: 'grammar' },
  'grammar.regexOk': { zh: '{n} 条正则都能编译', en: 'all {n} regexes compile' },
  'grammar.regexOkNoPerf': { zh: '{n} 条正则都能编译（没有测速）', en: 'all {n} regexes compile (speed not measured)' },
  'grammar.regexUnknown': { zh: '没有检查（编译超时或失败）', en: 'not checked (compile hung or failed)' },
  'grammar.regexBad': { zh: '{n} 条正则，其中 {bad} 条编译不了', en: '{n} regexes, {bad} do not compile' },
  'grammar.sampleRepeat': {
    zh: '{src} 行重复到 {lines} 行，共 {total} ms（上限 {budget} ms）；最慢一行 {slowest} ms（第 {line} 行，上限 {limit} ms）',
    en: '{src} lines repeated to {lines} lines, {total} ms total (limit {budget} ms); slowest line {slowest} ms (line {line}, limit {limit} ms)',
  },
  'grammar.sampleOrig': {
    zh: '{lines} 行，共 {total} ms（上限 {budget} ms）；最慢一行 {slowest} ms（第 {line} 行，上限 {limit} ms）',
    en: '{lines} lines, {total} ms total (limit {budget} ms); slowest line {slowest} ms (line {line}, limit {limit} ms)',
  },
  'grammar.skippedErrors': {
    zh: '语法引擎没有运行：上面有错误，先改好再查正则和分词速度',
    en: 'The grammar engine did not run because of the errors above; fix them first, then regexes and tokenizing speed get checked',
  },
  skipped: { zh: '略过：{list}', en: 'Skipped: {list}' },
  'skipped.more': { zh: '{list} 等共 {n} 项', en: '{list} and more ({n} in total)' },
  'result.pass': { zh: '结果：通过', en: 'Result: pass' },
  'result.fail': { zh: '结果：不通过', en: 'Result: fail' },
  'result.reject': { zh: '{n} 个会被拒绝', en: '{n} will be rejected' },
  'result.hint': { zh: '{n} 个提示', en: '{n} hints' },
  'result.error': { zh: '{n} 个错误', en: '{n} errors' },
  'result.warning': { zh: '{n} 个警告', en: '{n} warnings' },
  'result.sep': { zh: '，', en: ', ' },
  notChecked: {
    zh: '上传时云端另外检查：发布者名是不是你的、版本号是否比已上传的大、和已上架的扩展有没有冲突',
    en: 'The cloud also checks at upload: that the publisher name is yours, that the version is higher than any uploaded one, and conflicts with listed extensions',
  },
  'out.path': { zh: '输出：{v}', en: 'Output: {v}' },
  'out.size': { zh: '大小：{v}', en: 'Size: {v}' },
  'out.files': { zh: '文件：{v} 个', en: 'Files: {v}' },
  'out.sha256': { zh: 'sha256：{v}', en: 'sha256: {v}' },
  'dry.title': {
    zh: '--dry-run：会打进去 {n} 个文件（没有写 zip）',
    en: '--dry-run: {n} files would be packed (no zip written)',
  },
  'dry.size': { zh: '打出来的 zip 约 {v}，sha256 {sha}', en: 'The zip would be about {v}, sha256 {sha}' },
  'dry.notPacked': { zh: '没有打包：检查没通过', en: 'Not packed: the check failed' },
}

export function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const m = MESSAGES[key]
  if (!m) return key
  const s = m[lang]
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))
}
