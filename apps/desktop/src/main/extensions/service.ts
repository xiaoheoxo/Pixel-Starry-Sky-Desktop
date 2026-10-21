import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import {
  contentVersion,
  digest,
  effective,
  expandedMcp,
  extensionName,
  files,
  input,
  inside,
  jsonFile,
  MASKED_SECRET,
  mcpConfig,
  object,
  pluginDirectory,
  scope,
  skillFile,
  text,
} from '@pixelsky/engine'
import type {
  ExtensionCheck,
  ExtensionEntry,
  ExtensionImport,
  ExtensionLaunch,
  ExtensionScope,
  ExtensionState,
  McpConfig,
  SkillCommand,
} from '@pixelsky/protocol'
import { checkMcp, launcher, program, runProgram } from './check'
import { nativeEntries } from './native'
import { Secrets, type Cipher } from './secrets'

/** 原生扩展扫描结果的缓存时长：扫描要同步遍历磁盘，输入框 / 设置页会连着请求；窗口重新获得焦点、增删改时会提前作废 */
const NATIVE_TTL = 10_000
const NATIVE_CACHE_MAX = 16
interface Config {
  version: 1
  revision: number
  entries: ExtensionEntry[]
}
/** 像素星空命令行里的 MCP 服务器名（和 packages/cli/src/extensions/mcp.ts 的 piServerName 一致），比较时不分大小写 */
const mcpServerKey = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_').toLowerCase()

export class ExtensionService {
  private config: Config = { version: 1, revision: 0, entries: [] }
  private readonly secrets: Secrets
  private warnings: string[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private readonly retired: string[] = []
  // 按 CLAUDE_CONFIG_DIR + 项目缓存原生扩展扫描；扫描是同步的，同一时刻到的请求依次排队，后面的直接命中缓存
  private readonly nativeCache = new Map<string, { at: number; value: ReturnType<typeof nativeEntries> }>()
  constructor(
    readonly dir: string,
    private readonly cipher: Cipher,
    private readonly env: () => NodeJS.ProcessEnv = () => process.env,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'config.json')
    if (existsSync(file)) {
      // 读不了（断电写坏成空文件、版本不对）时不抛：抛了每轮对话前的 prepare 都会失败、消息全发不出去。
      // 原文件留成 config.json.bad-<时间>，从空配置开始，扩展页显示提示
      let c: Record<string, unknown> | null = null
      try {
        c = jsonFile(file)
      } catch {
        c = null
      }
      if (c && c.version === 1 && Array.isArray(c.entries)) this.config = c as unknown as Config
      else {
        const backup = `${file}.bad-${now()}`
        renameSync(file, backup)
        this.warnings.push(`扩展配置读不了，已改为从空配置开始；原文件留在 ${backup}`)
      }
    }
    this.secrets = new Secrets(dir, cipher)
    // 只清理由本服务创建的运行配置，遗留包由条目引用关系决定。
    const runtime = join(dir, 'runtime')
    mkdirSync(runtime, { recursive: true })
    for (const name of readdirSync(runtime))
      if (/^mcp-[a-f0-9-]+\.json$/.test(name)) rmSync(inside(runtime, join(runtime, name)), { force: true })
  }
  private save(): void {
    const next = { ...this.config, revision: this.config.revision + 1 },
      file = join(this.dir, 'config.json'),
      temp = file + '.tmp'
    writeFileSync(temp, JSON.stringify(next, null, 2))
    renameSync(temp, file)
    this.config = next
  }
  mutate<T>(fn: () => T | Promise<T>): Promise<T> {
    // 增删改前后都作废：冲突检查要看到用户刚在终端里装的原生内容，改完后列表也要是新的
    const work = this.chain.then(() => {
      this.invalidateNative()
      return fn()
    })
    this.chain = work.then(
      () => this.invalidateNative(),
      () => this.invalidateNative(),
    )
    return work
  }
  /** 原生扩展缓存作废：窗口重新获得焦点、扩展包变化、设置页增删改时调用 */
  invalidateNative(): void {
    this.nativeCache.clear()
  }
  private entry(id: string): ExtensionEntry {
    const e = this.config.entries.find(e => e.id === id)
    if (!e) throw new Error('配置已不存在')
    return e
  }
  private native(project: string | null): ReturnType<typeof nativeEntries> {
    const env = this.env(),
      key = (env.CLAUDE_CONFIG_DIR ?? '') + '|' + (project ?? ''),
      now = this.now(),
      hit = this.nativeCache.get(key)
    if (hit && now >= hit.at && now - hit.at < NATIVE_TTL) return hit.value
    const value = nativeEntries(project, env)
    this.nativeCache.delete(key)
    if (this.nativeCache.size >= NATIVE_CACHE_MAX) this.nativeCache.delete(this.nativeCache.keys().next().value!)
    this.nativeCache.set(key, { at: now, value })
    return value
  }
  state(project: string | null): ExtensionState {
    const native = this.native(project)
    const entries = [
      ...this.config.entries.filter(
        e =>
          e.scope.kind === 'global' ||
          (project && resolve(e.scope.path).toLowerCase() === resolve(project).toLowerCase()),
      ),
      ...native.entries,
    ]
    const redacted = entries.map(e => ({
      ...e,
      components: e.components.map(c => ({ ...c, mcp: c.mcp ? this.hide(c.mcp) : undefined })),
      mcp: e.mcp ? this.hide(e.mcp) : undefined,
    }))
    return {
      entries: redacted,
      warnings: [...this.warnings, ...(this.secrets.warning ? [this.secrets.warning] : []), ...native.warnings],
      revision: this.config.revision,
      secretsPersistent: this.secrets.persistent,
    }
  }
  private hide(c: McpConfig): McpConfig {
    return {
      ...c,
      env: Object.fromEntries(Object.keys(c.env ?? {}).map(k => [k, MASKED_SECRET])),
      headers: Object.fromEntries(Object.keys(c.headers ?? {}).map(k => [k, MASKED_SECRET])),
    }
  }
  private conflict(name: string, kind: ExtensionEntry['kind'], s: ExtensionScope, exclude?: string): void {
    const same = (e: ExtensionEntry): boolean =>
      e.id !== exclude && e.kind === kind && e.name.toLowerCase() === name.toLowerCase()
    if (this.config.entries.some(e => same(e) && JSON.stringify(e.scope) === JSON.stringify(s)))
      throw new Error('该范围已有同名配置，请修改名称')
    // 像素星空命令行把 MCP 服务器名里字母、数字、_、- 以外的字符换成 _（packages/cli/src/extensions/mcp.ts 的 piServerName），
    // alpha.beta 和 alpha_beta 到那边就是同一个，后一个会盖掉前一个；保存时就拦下
    if (kind === 'mcp') {
      const key = mcpServerKey(name)
      const clash = this.config.entries.find(
        e =>
          e.id !== exclude &&
          e.kind === 'mcp' &&
          e.name.toLowerCase() !== name.toLowerCase() &&
          mcpServerKey(e.name) === key &&
          // 全局的和任何项目的会一起传给引擎；不同项目的不会同时出现
          (e.scope.kind === 'global' || s.kind === 'global' || JSON.stringify(e.scope) === JSON.stringify(s)),
      )
      if (clash)
        throw new Error(`和已有的 MCP 服务器「${clash.name}」只差符号，像素星空引擎会把它们当成同一个，请修改名称`)
    }
    const native = this.native(s.kind === 'project' ? s.path : null).entries
    if (native.some(same)) throw new Error('Claude Code 原生安装已有同名内容，请修改应用副本名称')
  }
  private packageDir(): string {
    const path = join(this.dir, 'packages', randomUUID())
    mkdirSync(path, { recursive: true })
    return path
  }
  private skillPackage(root: string, name: string, source: string): ExtensionEntry['components'] {
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name, description: '像素星空管理的技能' }))
    const path = join(root, 'skills', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'SKILL.md'), source)
    const c = skillFile(join(path, 'SKILL.md'))
    return [c]
  }
  upsert(raw: unknown): ExtensionEntry {
    const data = input(raw),
      existing = data.id ? this.entry(data.id) : null
    if (existing && existing.kind !== data.kind) throw new Error('不能修改配置类型')
    this.conflict(data.name, data.kind, data.scope, data.id)
    const e: ExtensionEntry = {
      id: existing?.id ?? randomUUID(),
      kind: data.kind,
      name: data.name,
      description: data.description ?? '',
      scope: data.scope,
      enabled: data.enabled ?? existing?.enabled ?? true,
      origin: 'managed',
      source: existing?.source ?? { kind: 'created', location: '' },
      sourceDigest: existing?.sourceDigest,
      edited: existing?.edited,
      components: [],
      revision: this.config.revision + 1,
      engines: data.engines ?? existing?.engines ?? ['claude'],
    }
    if (data.kind === 'mcp') e.mcp = this.secrets.put(e.id, data.mcp!)
    if (data.kind === 'cli') {
      e.command = data.command
      e.args = data.args
      e.check =
        existing && existing.command === e.command && JSON.stringify(existing.args) === JSON.stringify(e.args)
          ? existing.check
          : undefined
    }
    // 技能改写成新包：保存成功后旧包才进待删列表；保存失败删掉新包，旧包原样留着（配置回滚后还指向它）
    let created: string | undefined
    if (data.kind === 'skill') {
      const old = existing?.components.find(c => c.kind === 'skill')?.path
      if (old && data.expectedVersion !== contentVersion(readFileSync(old, 'utf8')))
        throw new Error('技能文件已被外部修改，请重新打开后再保存，当前输入已保留')
      const root = this.packageDir(),
        previous = old ? readFileSync(old, 'utf8') : null
      if (previous && data.text !== previous && existing?.source.kind !== 'created') e.edited = true
      let source = data.text!
      if (previous) {
        source = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
        if (previous.includes('\r\n')) source = source.replace(/\n/g, '\r\n')
        if (previous.startsWith('\uFEFF')) source = '\uFEFF' + source
      }
      try {
        if (old) this.copy(dirname(old), join(root, 'skills', e.name))
        e.components = this.skillPackage(root, e.name, source)
        e.path = root
        e.description = e.description || e.components[0].description
        e.digest = digest(root)
      } catch (error) {
        rmSync(inside(this.dir, root), { recursive: true, force: true })
        throw error
      }
      created = root
    }
    const before = this.config.entries
    this.config.entries = [...before.filter(x => x.id !== e.id), e]
    try {
      this.save()
    } catch (error) {
      this.config.entries = before
      if (created) rmSync(inside(this.dir, created), { recursive: true, force: true })
      throw error
    }
    if (created && existing?.path) this.retired.push(existing.path)
    return e
  }
  skillText(id: string, project: string | null): { text: string; version: string; readOnly: boolean } {
    const e = this.state(project).entries.find(e => e.id === id),
      path = e?.components.find(c => c.kind === 'skill')?.path
    if (!e || !path) throw new Error('找不到技能正文')
    if (e.origin === 'managed') inside(join(this.dir, 'packages'), realpathSync(path))
    if (statSync(path).size > 2 * 1024 * 1024) throw new Error('文件过大')
    const source = readFileSync(path, 'utf8')
    return { text: source, version: contentVersion(source), readOnly: e.origin === 'native' || e.kind === 'plugin' }
  }
  toggle(id: string, enabled: boolean): void {
    const e = this.entry(id)
    e.enabled = enabled
    this.save()
  }
  remove(id: string): void {
    const e = this.entry(id),
      before = this.config.entries
    this.config.entries = before.filter(x => x.id !== id)
    try {
      this.save()
    } catch (error) {
      this.config.entries = before
      throw error
    }
    this.secrets.remove(id)
    if (e.path) this.retired.push(inside(join(this.dir, 'packages'), e.path))
  }
  private copy(source: string, target: string): void {
    files(source)
    cpSync(source, target, {
      recursive: true,
      filter: p =>
        !relative(source, p)
          .split(/[\\/]/)
          .some(x => ['.git', 'node_modules'].includes(x)),
    })
  }
  private async fetch(
    source: ExtensionImport['source'],
    location: string,
    subdir: string,
    stage: string,
  ): Promise<string> {
    if (source === 'local') {
      const path = realpathSync(location)
      if (!statSync(path).isDirectory()) throw new Error('选择插件或技能所在目录')
      this.copy(inside(path, join(path, subdir)), stage)
      return ''
    }
    if (!/^https:\/\//i.test(location) && !/^git@[\w.-]+:[\w./-]+$/.test(location) && !existsSync(location))
      throw new Error('Git 来源使用 HTTPS 地址、SSH 仓库地址或本地仓库路径')
    if (location.startsWith('https://')) {
      const u = new URL(location)
      if (u.username || u.password) throw new Error('仓库地址不要包含凭据')
    }
    const clone = join(this.dir, 'downloads', randomUUID())
    mkdirSync(dirname(clone), { recursive: true })
    try {
      await runProgram(
        'git',
        ['-c', 'core.hooksPath=', 'clone', '--depth', '1', '--', location, clone],
        this.dir,
        this.env(),
        90000,
      )
      const revision = await runProgram('git', ['-C', clone, 'rev-parse', 'HEAD'], this.dir, this.env())
      this.copy(inside(clone, join(clone, subdir)), stage)
      return revision
    } finally {
      if (existsSync(clone)) {
        const target = inside(join(this.dir, 'downloads'), clone)
        // Windows Git 对象为只读文件；仅处理本服务下载目录内的临时副本。
        const writable = (p: string): void => {
          const stat = lstatSync(p)
          if (stat.isSymbolicLink()) return
          if (stat.isDirectory()) for (const child of readdirSync(p)) writable(join(p, child))
          chmodSync(p, stat.isDirectory() ? 0o700 : 0o600)
        }
        writable(target)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  }
  async import(raw: unknown): Promise<ExtensionEntry> {
    const o = object(raw),
      kind = o.kind,
      source = o.source
    if ((kind !== 'plugin' && kind !== 'skill') || (source !== 'local' && source !== 'git'))
      throw new Error('导入类型不正确')
    const data: ExtensionImport = {
      kind,
      source,
      location: text(o.location, '来源'),
      subdir: typeof o.subdir === 'string' ? o.subdir : '',
      scope: scope(o.scope),
      name: typeof o.name === 'string' && o.name ? extensionName(o.name) : undefined,
    }
    if (data.subdir && (/^[\\/]/.test(data.subdir) || data.subdir.split(/[\\/]/).includes('..')))
      throw new Error('子目录必须位于来源目录内')
    // 先校验再建包目录：校验失败不留空目录
    let engines: Array<'claude' | 'codex' | 'pixel'> | undefined
    if (o.engines !== undefined) {
      if (
        !Array.isArray(o.engines) ||
        !o.engines.length ||
        o.engines.some(engine => engine !== 'claude' && engine !== 'codex' && engine !== 'pixel')
      )
        throw new Error('适用引擎不正确')
      engines = kind === 'plugin' ? ['claude'] : (o.engines as Array<'claude' | 'codex' | 'pixel'>)
    }
    const root = this.packageDir()
    /** 技能另建的包：后面出错（含保存配置失败）时连它一起删，不留孤儿目录 */
    let pack: string | undefined
    try {
      const revision = await this.fetch(source, data.location, data.subdir ?? '', root)
      const sourceDigest = digest(root)
      let e: ExtensionEntry
      if (kind === 'plugin') {
        const p = pluginDirectory(root),
          name = data.name ?? p.name
        this.conflict(name, kind, data.scope)
        if (name !== p.name) {
          const file = join(root, '.claude-plugin/plugin.json')
          writeFileSync(file, JSON.stringify({ ...jsonFile(file), name }, null, 2))
        }
        e = {
          id: randomUUID(),
          kind,
          name,
          description: p.description,
          version: p.version,
          scope: data.scope,
          enabled: true,
          origin: 'managed',
          source: { kind: source, location: data.location, subdir: data.subdir, revision },
          path: root,
          components: pluginDirectory(root).components,
          digest: digest(root),
        }
      } else {
        const path = join(root, 'SKILL.md')
        if (!existsSync(path)) throw new Error('选择含 SKILL.md 的目录，可填写仓库内子目录')
        const c = skillFile(path),
          name = data.name ?? c.name
        this.conflict(name, kind, data.scope)
        pack = this.packageDir()
        const skillDir = join(pack, 'skills', name)
        this.copy(root, skillDir)
        mkdirSync(join(pack, '.claude-plugin'), { recursive: true })
        writeFileSync(join(pack, '.claude-plugin/plugin.json'), JSON.stringify({ name }))
        c.path = join(skillDir, 'SKILL.md')
        e = {
          id: randomUUID(),
          kind,
          name,
          description: c.description,
          scope: data.scope,
          enabled: true,
          origin: 'managed',
          source: { kind: source, location: data.location, subdir: data.subdir, revision },
          path: pack,
          components: [c],
          digest: digest(pack),
        }
        rmSync(inside(join(this.dir, 'packages'), root), { recursive: true, force: true })
      }
      if (engines) e.engines = engines
      e.sourceDigest = sourceDigest
      const before = this.config.entries
      this.config.entries = [...before, e]
      try {
        this.save()
      } catch (error) {
        this.config.entries = before
        throw error
      }
      return e
    } catch (error) {
      for (const dir of [root, pack])
        if (dir && existsSync(dir)) rmSync(inside(join(this.dir, 'packages'), dir), { recursive: true, force: true })
      throw error
    }
  }
  async update(id: string, apply: boolean): Promise<{ changed: boolean; message: string }> {
    const e = this.entry(id)
    if (!e.path || !['local', 'git'].includes(e.source.kind)) throw new Error('该条目没有可更新来源')
    if (e.edited || digest(e.path) !== e.digest) throw new Error('存在本地编辑，已保留；先处理修改后再更新')
    const stage = this.packageDir()
    try {
      const revision = await this.fetch(
        e.source.kind as 'local' | 'git',
        e.source.location,
        e.source.subdir ?? '',
        stage,
      )
      const sourceDigest = digest(stage)
      if (e.kind === 'skill') {
        const file = join(stage, 'SKILL.md'),
          c = skillFile(file),
          source = readFileSync(file, 'utf8')
        // 保留导入后的命名与所有支持文件。
        const pack = this.packageDir(),
          target = join(pack, 'skills', e.name)
        this.copy(stage, target)
        this.skillPackage(pack, e.name, source)
        rmSync(inside(this.dir, stage), { recursive: true, force: true })
        this.copy(pack, stage)
        rmSync(inside(this.dir, pack), { recursive: true, force: true })
        void c
      } else {
        const file = join(stage, '.claude-plugin/plugin.json')
        writeFileSync(file, JSON.stringify({ ...jsonFile(file), name: e.name }, null, 2))
      }
      const parsed = pluginDirectory(stage),
        nextDigest = digest(stage),
        changed = e.sourceDigest ? sourceDigest !== e.sourceDigest : nextDigest !== e.digest
      if (apply && changed) {
        const next = {
          ...e,
          path: stage,
          digest: nextDigest,
          sourceDigest,
          version: parsed.version,
          description: parsed.description,
          components: parsed.components,
          source: { ...e.source, revision },
        }
        this.config.entries = this.config.entries.map(x => (x.id === id ? next : x))
        this.save()
        this.retired.push(e.path)
        return { changed, message: '已更新，下一轮生效' }
      }
      return { changed, message: changed ? '发现更新，可点击应用更新' : '已是最新版本' }
    } finally {
      if (this.config.entries.every(e => e.path !== stage) && existsSync(stage))
        rmSync(inside(this.dir, stage), { recursive: true, force: true })
    }
  }
  importMcp(raw: string, s: ExtensionScope): number {
    const data = object(JSON.parse(raw)),
      servers = object(data.mcpServers ?? data),
      pairs = Object.entries(servers)
    if (!pairs.length || pairs.length > 100) throw new Error('JSON 需要包含 MCP 服务器配置')
    const validated = pairs.map(([name, mcp]) => ({
      kind: 'mcp' as const,
      name: extensionName(name),
      scope: s,
      mcp: mcpConfig(mcp),
    }))
    for (const d of validated) this.conflict(d.name, 'mcp', s)
    const before = this.config.entries.slice()
    try {
      for (const d of validated) this.upsert(d)
    } catch (error) {
      this.config.entries = before
      this.save()
      throw error
    }
    return validated.length
  }
  async check(id: string, project: string | null): Promise<ExtensionCheck> {
    const e = this.entry(id),
      cwd = e.scope.kind === 'project' ? e.scope.path : (project ?? this.dir)
    let result: ExtensionCheck
    if (e.kind === 'mcp') {
      try {
        const env = this.runtimeEnv(e.scope.kind === 'project' ? e.scope.path : project)
        result = await checkMcp(expandedMcp(this.secrets.resolve(id, e.mcp!), env), cwd, 12000, env)
      } catch (error) {
        result = { status: 'error', message: (error as Error).message, at: Date.now() }
      }
    } else if (e.kind === 'cli') {
      try {
        const output = await runProgram(e.command!, e.args ?? ['--version'], cwd, this.env())
        result = { status: 'ready', message: output.slice(0, 1200) || '程序可用', at: Date.now() }
      } catch (error) {
        result = { status: 'error', message: (error as Error).message, at: Date.now() }
      }
    } else throw new Error('该类型无需连接检测')
    e.check = result
    this.save()
    return result
  }
  commands(project: string | null): SkillCommand[] {
    const managed = effective(this.config.entries, project),
      native = this.native(project).entries,
      commands: SkillCommand[] = []
    for (const e of [...managed, ...native.filter(e => e.enabled)])
      for (const c of e.components.filter(c => c.kind === 'skill' && c.invocable !== false)) {
        const name = e.origin === 'managed' || e.kind === 'plugin' ? e.name.split('@')[0] + ':' + c.name : c.name
        if (!commands.some(x => x.name === name))
          commands.push({ name, description: c.description, source: 'configured' })
      }
    return commands
  }
  launch(
    project: string,
    engine: 'claude' | 'codex' | 'pixel' = 'claude',
    extraEnv: Record<string, string> = {},
    extraServers: Record<string, McpConfig> = {},
  ): ExtensionLaunch {
    project = realpathSync(project)
    const env = { ...this.runtimeEnv(project), ...extraEnv }
    const entries = effective(
        this.config.entries.filter(e => (e.engines ?? ['claude']).includes(engine)),
        project,
      ),
      pluginDirs: string[] = [],
      pathDirs: string[] = [],
      servers: Record<string, McpConfig> = {},
      skillRoots: string[] = []
    for (const e of entries) {
      if (e.path && (e.kind === 'plugin' || e.kind === 'skill')) {
        if (engine === 'claude') pluginDirs.push(e.path)
        else if (e.kind === 'skill')
          skillRoots.push(...e.components.filter(c => c.kind === 'skill' && c.path).map(c => dirname(c.path!)))
      }
      if (e.kind === 'mcp') {
        const c = expandedMcp(this.secrets.resolve(e.id, e.mcp!), env)
        if (c.type === 'stdio') {
          const l = launcher(c.command!, c.args ?? [], { ...env, ...c.env })
          c.command = l.command
          c.args = l.args
        }
        servers[e.name] = c
      }
      if (e.kind === 'cli' && e.check?.status === 'ready') pathDirs.push(dirname(program(e.command!, this.env())))
      for (const c of e.components.filter(c => c.kind === 'cli' && c.path)) pathDirs.push(c.path!)
    }
    // 应用自己提供的 MCP 服务器（对话历史等）：不进扩展配置，也不能被同名的扩展盖掉；key 带上地址，变了就换进程（令牌不进 key）
    Object.assign(servers, structuredClone(extraServers))
    const extraKey = Object.entries(extraServers)
      .map(([name, c]) => `|${name}:${c.url ?? c.command ?? ''}`)
      .join('')
    let file: string | undefined
    if (engine === 'codex') {
      const { codexConfig, env: secretEnv } = codexMcp(servers, env)
      return {
        key:
          JSON.stringify(entries.map(e => [e.id, e.revision, e.digest, e.enabled, e.mcp, e.command, e.args])) +
          extraKey,
        pluginDirs: [],
        pathDirs: [...new Set(pathDirs)],
        skillRoots,
        codexConfig,
        env: secretEnv,
      }
    }
    if (Object.keys(servers).length) {
      file = join(this.dir, 'runtime', 'mcp-' + randomUUID() + '.json')
      writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 })
    }
    return {
      key:
        JSON.stringify(
          entries.map(e => [
            e.id,
            e.revision,
            e.digest,
            e.enabled,
            e.mcp,
            e.command,
            e.args,
            e.kind === 'cli' ? e.check?.status : null,
          ]),
        ) + extraKey,
      pluginDirs,
      pathDirs: [...new Set(pathDirs)],
      // 像素星空：MCP 也走这个文件（命令行的 MCP 扩展注册），技能每个目录一个 --skill
      ...(engine === 'pixel' ? { skillRoots: [...new Set(skillRoots)] } : {}),
      mcpFile: file,
      dispose: () => {
        if (file) rmSync(inside(join(this.dir, 'runtime'), file), { force: true })
      },
    }
  }
  location(id: string, project: string | null): string {
    const e = this.state(project).entries.find(e => e.id === id)
    if (!e) throw new Error('配置已不存在')
    return e.path ?? this.dir
  }
  private runtimeEnv(project: string | null): NodeJS.ProcessEnv {
    const env = this.env(),
      dirs: string[] = []
    for (const entry of effective(this.config.entries, project)) {
      if (entry.kind === 'cli' && entry.check?.status === 'ready') dirs.push(dirname(program(entry.command!, env)))
      for (const component of entry.components.filter(c => c.kind === 'cli' && c.path)) dirs.push(component.path!)
    }
    return { ...env, PATH: [...new Set(dirs), env.PATH ?? env.Path ?? ''].join(delimiter) }
  }
  close(): void {
    // 退出时（will-quit）调用：Windows 上旧包被占用删不掉时不抛，后面的旧包照样删
    for (const path of this.retired)
      try {
        if (existsSync(path)) rmSync(inside(join(this.dir, 'packages'), path), { recursive: true, force: true })
      } catch {
        // 删不掉的留着（配置里已不引用它，不影响使用），不能让退出流程因为它中断
      }
  }
}

/**
 * Codex 的 MCP 配置经 `-c` 进命令行，进程列表、崩溃报告都看得到；凭据（stdio 的 env、HTTP 的请求头）
 * 改成放进 Codex 进程的环境，配置里只写变量名（`env_vars` / `env_http_headers`）。
 * stdio 的变量名必须和服务要的一致：和别的服务或已有环境同名不同值时，这一个仍写在配置里，不去改别人看到的值。
 */
export function codexMcp(
  servers: Record<string, McpConfig>,
  base: NodeJS.ProcessEnv,
): { codexConfig: Record<string, unknown>; env: Record<string, string> } {
  const codexConfig: Record<string, unknown> = {},
    env: Record<string, string> = {},
    owner = new Map<string, string>()
  const existing = (name: string): string | undefined => {
    const key = Object.keys(base).find(k =>
      process.platform === 'win32' ? k.toUpperCase() === name.toUpperCase() : k === name,
    )
    return key === undefined ? undefined : base[key]
  }
  // 同名变量的值在所有服务里都一样、也不和已有环境冲突，才能放进环境
  for (const c of Object.values(servers))
    for (const [name, value] of Object.entries(c.type === 'stdio' ? (c.env ?? {}) : {})) {
      const seen = owner.get(name)
      owner.set(name, seen === undefined || seen === value ? value : '\0conflict')
    }
  let header = 0
  for (const [name, c] of Object.entries(servers)) {
    if (c.type === 'sse') throw new Error('Codex MCP 仅支持 stdio 或 HTTP，请修改传输方式')
    if (c.type === 'stdio') {
      const inline: Record<string, string> = {},
        forwarded: string[] = []
      for (const [k, v] of Object.entries(c.env ?? {})) {
        const now = existing(k)
        if (owner.get(k) === v && (now === undefined || now === v)) {
          env[k] = v
          forwarded.push(k)
        } else inline[k] = v
      }
      codexConfig[`mcp_servers.${JSON.stringify(name)}`] = {
        command: c.command,
        args: c.args ?? [],
        env: inline,
        ...(forwarded.length ? { env_vars: forwarded } : {}),
      }
    } else {
      // 变量名带 SECRET：Codex 默认不把名字含 KEY / SECRET / TOKEN 的变量传给它跑的命令
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(c.headers ?? {})) {
        const variable = `PIXELSKY_MCP_SECRET_${header++}`
        env[variable] = v
        headers[k] = variable
      }
      codexConfig[`mcp_servers.${JSON.stringify(name)}`] = {
        url: c.url,
        ...(Object.keys(headers).length ? { env_http_headers: headers } : {}),
      }
    }
  }
  return { codexConfig, env }
}
