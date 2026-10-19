import { readdirSync, readFileSync, statSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import type { ExtPackInfo, ExtPackOptions, ExtPackState, SkillCommand } from '@pixelsky/protocol'
import {
  codedError,
  computeLive,
  EXT_LIMITS,
  EXT_MANIFEST,
  loaderIssue,
  packStatus,
  parseJsonc,
  resolvePackPath,
} from '@pixelsky/protocol'
import { addPackIssue, hasManifest, loadPack, packKey, type LoadedPack } from './loader'
import { emptyBlocklist, matchBlocklist, readBlocklistFile, type BlocklistFile } from './market/blocklist'
import { cleanStoreDir, removeStoreFiles } from './market/cleanup'
import { keyStatus as storeKeyStatus, type StoreKeyStatus } from './market/keys'
import {
  loadStore,
  loadStorePack,
  readStoreEntries,
  readStoreRecord,
  REVOKED_KEY_REASON,
  storeBlock,
} from './market/store-load'
import type { StoreInstallRecord, StoreTasks } from './market/types'
import { applyWinners } from './market/winner'
import { ensureClaudeWrappers, gcClaudeWrappers, packSkillCommands, packSkillLaunch } from './skills'
import { readStateFile, writeStateFile, emptyState, type PackStateFile } from './store'

export interface ExtPacksOptions {
  dataDir: string
  builtinDir: string
  appVersion: string
  /** 钥匙在某个站点上的状态（loadStore 遇到已作废的钥匙就设 blocked）；不传用 market/keys.ts 的钥匙表，测试可以注入 */
  keyStatus?: (keyId: string, site: string) => StoreKeyStatus | 'unknown'
  /** 卸载商店扩展时删它的图标缓存（cache/icons/<id>@*）；不传就不删。market 的 storeIcons().remove 由 initExtensionPacks 传进来 */
  removeIcons?: (id: string) => Promise<void>
}

type Engine = 'claude' | 'codex' | 'pixel'

/** 目录名列表（内置扩展目录：<builtinDir>/<扩展 id>/） */
function builtinDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
  } catch {
    return []
  }
}

/** 只为估算“启动时要不要等扩展技能”：清单里 contributes.skills 非空，读不了就当没有 */
function declaresSkills(root: string): boolean {
  try {
    const file = join(root, EXT_MANIFEST)
    if (statSync(file).size > EXT_LIMITS.manifestBytes) return false
    const text = readFileSync(file, 'utf8')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      raw = parseJsonc(text)
    }
    const skills = (raw as { contributes?: { skills?: unknown } } | null)?.contributes?.skills
    return Array.isArray(skills) && skills.length > 0
  } catch {
    return false
  }
}

/** packs 数组里的来源顺序：内置、商店、文件夹（同 id 的「后到」按这个顺序算） */
const SOURCE_ORDER = ['builtin', 'store', 'folder'] as const

const TEXT_FILE = /\.(md|txt)$/i
const LICENSE_FILE = /^LICENSE/i

/** 扩展包的主进程服务：加载内置和文件夹扩展、保存开关、把技能并进引擎启动（见 docs 计划 §1） */
export class ExtensionPacks {
  private started = false
  private ready_ = false
  private loading = true
  private revision = 0
  /** 扩展实例版本号：整个进程内只增不减，重新添加同一目录也不会和旧实例撞号（渲染层按 key+版本号缓存文件） */
  private packRevision = 0
  private preKey = ''
  private data: PackStateFile = emptyState()
  /** 启动时同步读的停用名单（上次存的；定时从网络读是 7.3a） */
  private blocklist: BlocklistFile = emptyBlocklist()
  private packs: LoadedPack[] = []
  private wrappers = new Map<string, string>()
  /** 商店 installer 挂上来的能力（卸载前取消这个 id 正在进行的下载）；没挂上就跳过 */
  private storeTasks: StoreTasks | null = null
  private phase1: Promise<void> = Promise.resolve()
  private phase2: Promise<void> = Promise.resolve()
  private chain: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(readonly opts: ExtPacksOptions) {}

  private get stateFile(): string {
    return join(this.opts.dataDir, 'state.json')
  }

  /** <dataDir>/store：store/<id>/install.json 和解压后的扩展 */
  get storeDir(): string {
    return join(this.opts.dataDir, 'store')
  }

  private get blocklistFile(): string {
    return join(this.opts.dataDir, 'blocklist.json')
  }

  private get runtimeDir(): string {
    return join(this.opts.dataDir, 'runtime')
  }

  /** 幂等：同步预读（状态文件、停用名单）+ 清理 Claude 包装目录 + 开始异步加载 */
  start(): void {
    if (this.started) return
    this.started = true
    this.data = readStateFile(this.stateFile)
    this.blocklist = readBlocklistFile(this.blocklistFile)
    this.preKey = this.preReadKey()
    gcClaudeWrappers(this.runtimeDir)
    // 内置和商店一起第一次 commit（loadStore 末尾），第一次推出去的状态里就有商店扩展
    this.phase1 = this.loadBuiltin()
      .then(() => cleanStoreDir(this.storeDir, message => console.warn('[extension-packs]', message)))
      .then(() => this.loadStore())
      .catch(e => console.error('[extension-packs] builtin/store load failed', e))
    this.phase2 = this.phase1
      .then(() => this.loadFolders())
      .catch(e => console.error('[extension-packs] folder load failed', e))
      .then(() => {
        this.loading = false
        this.ready_ = true
        this.commit()
      })
  }

  /** 内置扩展加载完（必要时先 start） */
  builtinReady(): Promise<void> {
    this.start()
    return this.phase1
  }

  /** 所有扩展加载完（必要时先 start） */
  ready(): Promise<void> {
    this.start()
    return this.phase2
  }

  state(): ExtPackState {
    return { revision: this.revision, loading: this.loading, packs: this.packs.map(p => p.info) }
  }

  // ---------- 加载 ----------

  private builtinEnabled(id: string): { enabled: boolean; options: ExtPackOptions } {
    return this.data.builtin[id] ?? { enabled: true, options: {} }
  }

  /** ready 之前的技能 key：状态文件和各清单里一个带技能的都没有就是 ''，否则 'loading'（会话在加载期间启动，下一轮会重新启动一次） */
  private preReadKey(): string {
    for (const name of builtinDirs(this.opts.builtinDir))
      if (this.builtinEnabled(name).enabled && declaresSkills(join(this.opts.builtinDir, name))) return 'loading'
    for (const { record, root } of readStoreEntries(this.storeDir))
      if (
        this.data.store[record.id]?.enabled !== false &&
        declaresSkills(root) &&
        !storeBlock(record, this.blocklist, this.keyStatus)
      )
        return 'loading'
    for (const f of this.data.folders) if (f.enabled && declaresSkills(resolve(f.path))) return 'loading'
    return ''
  }

  private get keyStatus(): (keyId: string, site: string) => StoreKeyStatus | 'unknown' {
    return this.opts.keyStatus ?? ((keyId, site) => storeKeyStatus(keyId, site))
  }

  /** 把某个来源的扩展整批换掉，别的来源原样保留，顺序固定为内置、商店、文件夹 */
  private replaceSource(source: (typeof SOURCE_ORDER)[number], packs: LoadedPack[]): void {
    const all = [...this.packs.filter(p => p.info.source !== source), ...packs]
    this.packs = SOURCE_ORDER.flatMap(s => all.filter(p => p.info.source === s))
  }

  private async loadBuiltin(): Promise<void> {
    const packs: LoadedPack[] = []
    for (const name of builtinDirs(this.opts.builtinDir)) {
      const st = this.builtinEnabled(name)
      packs.push(
        await loadPack({
          key: packKey('builtin', name),
          root: join(this.opts.builtinDir, name),
          source: 'builtin',
          enabled: st.enabled,
          addedAt: 0,
          options: st.options,
          revision: ++this.packRevision,
          appVersion: this.opts.appVersion,
        }),
      )
    }
    this.replaceSource('builtin', packs)
  }

  private storeLoadInput() {
    return {
      state: this.data.store,
      blocklist: this.blocklist,
      keyStatus: this.keyStatus,
      appVersion: this.opts.appVersion,
      revision: () => ++this.packRevision,
      log: (message: string) => console.warn('[extension-packs]', message),
    }
  }

  /** 加载商店扩展，然后算同 id 的生效关系、刷新包装、第一次 commit（内置的同步和这里合成一次） */
  private async loadStore(): Promise<void> {
    const packs = await loadStore({ storeDir: this.storeDir, ...this.storeLoadInput() })
    this.replaceSource('store', packs)
    applyWinners(this.packs)
    await this.refreshWrappers()
    this.commit()
  }

  private async loadFolders(): Promise<void> {
    const folders: LoadedPack[] = []
    for (const f of this.data.folders) {
      const root = resolve(f.path)
      folders.push(
        await loadPack({
          key: packKey('folder', root),
          root,
          source: 'folder',
          enabled: f.enabled,
          addedAt: f.addedAt,
          options: f.options,
          revision: ++this.packRevision,
          appVersion: this.opts.appVersion,
        }),
      )
    }
    this.replaceSource('folder', folders)
    this.markBlocked()
    applyWinners(this.packs)
    await this.refreshWrappers()
  }

  private async refreshWrappers(): Promise<void> {
    this.wrappers = await ensureClaudeWrappers(
      this.runtimeDir,
      this.packs.filter(p => p.info.live),
    )
  }

  private commit(): void {
    this.revision++
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 监听者出错不影响别的
      }
    }
  }

  private save(): void {
    writeStateFile(this.stateFile, this.data)
  }

  /** 所有变更串行执行，并等加载完再开始 */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => this.ready()).then(fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // ---------- 商店扩展（market/install.ts 经 market/ipc.ts 拼的 StoreHost 调这里） ----------

  /** 排进串行队列：里面改状态不会和启停、卸载、别的安装交叉（给 installer 的「换上」用） */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutate(fn)
  }

  /** installer 取消任务的入口挂在这里；不用 export let，由 market/ipc.ts 接线 */
  attachStoreTasks(tasks: StoreTasks): void {
    this.storeTasks = tasks
  }

  /** 本机装的这份商店扩展的回执（读 store/<id>/install.json）；没装是 null */
  storeInfo(id: string): StoreInstallRecord | null {
    return readStoreRecord(this.storeDir, id)
  }

  /** 这个站点的停用名单里有没有这个版本；有就给原因（安装前、换上前再查一遍用） */
  storeBlocked(site: string, id: string, version: string): { reason: string; at: string } | null {
    return matchBlocklist(this.blocklist, site, id, version)
  }

  /**
   * 换上一份商店扩展（新装、更新、换回）：必须在 runExclusive 里调。回执和解压目录已经写好。
   * 第一次装（state.json.store 里还没有这个 id）时继承同 id 内置版的开关和选项；更新和换回保留 store[id] 原样。
   */
  async replaceStorePack(record: StoreInstallRecord, root: string): Promise<ExtPackInfo> {
    const id = record.id
    if (!this.data.store[id]) {
      const inherited = this.data.builtin[id]
      this.data.store[id] = inherited
        ? { enabled: inherited.enabled, options: { ...inherited.options } }
        : { enabled: true, options: {} }
      this.save()
    }
    const pack = await loadStorePack(record, root, this.storeLoadInput())
    const rest = this.packs.filter(p => p.info.source === 'store' && p.info.key !== pack.info.key)
    this.replaceSource(
      'store',
      [...rest, pack].sort((a, b) => (a.info.key < b.info.key ? -1 : a.info.key > b.info.key ? 1 : 0)),
    )
    applyWinners(this.packs)
    await this.refreshWrappers()
    this.commit()
    return pack.info
  }

  /** 卸载的内存和设置那一半：去掉这一项、删 state.json.store[id]、让同 id 的内置版顶上、commit。必须在 runExclusive 里调；文件由调用方再删 */
  async removeStorePack(id: string): Promise<void> {
    this.packs = this.packs.filter(p => !(p.info.source === 'store' && p.info.key === packKey('store', id)))
    delete this.data.store[id]
    this.save()
    applyWinners(this.packs)
    await this.refreshWrappers()
    this.commit()
  }

  private find(key: string): LoadedPack {
    const pack = this.packs.find(p => p.info.key === key)
    if (!pack) throw codedError('extpacks.unknownPack')
    return pack
  }

  private folderEntry(pack: LoadedPack): PackStateFile['folders'][number] | undefined {
    return this.data.folders.find(f => packKey('folder', resolve(f.path)) === pack.info.key)
  }

  /** 把开关 / 选项写回状态文件里这个扩展的那一项 */
  private persist(pack: LoadedPack): void {
    const { enabled, options } = pack.info
    if (pack.info.source === 'builtin') this.data.builtin[basename(pack.root)] = { enabled, options }
    else if (pack.info.source === 'store') this.data.store[pack.info.key.slice(2)] = { enabled, options }
    else {
      const entry = this.folderEntry(pack)
      if (entry) {
        entry.enabled = enabled
        entry.options = options
      }
    }
    this.save()
  }

  // ---------- 变更 ----------

  addFolder(path: string): Promise<ExtPackInfo> {
    return this.mutate(async () => {
      const root = resolve(path)
      if (!hasManifest(root)) throw codedError('extpacks.noManifest')
      const key = packKey('folder', root)
      if (this.packs.some(p => p.info.key === key)) throw codedError('extpacks.duplicatePath')
      const addedAt = Date.now()
      const pack = await loadPack({
        key,
        root,
        source: 'folder',
        enabled: true,
        addedAt,
        options: {},
        revision: ++this.packRevision,
        appVersion: this.opts.appVersion,
      })
      const id = pack.info.id
      // 只有同 id 的已经是文件夹才拒绝；同 id 的内置或商店扩展照常加，文件夹这份生效、那份标 shadowedBy
      if (id && this.packs.some(p => p.info.source === 'folder' && p.info.id === id))
        throw codedError('extpacks.duplicateId', { id })
      this.data.folders.push({ path: root, enabled: true, addedAt, options: {} })
      this.save()
      this.packs.push(pack)
      this.markBlocked()
      applyWinners(this.packs)
      await this.refreshWrappers()
      this.commit()
      return pack.info
    })
  }

  setEnabled(key: string, enabled: boolean): Promise<void> {
    return this.mutate(async () => {
      const pack = this.find(key)
      if (enabled && pack.info.blocked) throw codedError('extpacks.blocked')
      pack.info.enabled = enabled
      this.persist(pack)
      applyWinners(this.packs)
      await this.refreshWrappers()
      this.commit()
    })
  }

  async remove(key: string): Promise<void> {
    // 商店扩展：先取消这个 id 正在进行的下载并等它退出，再进队列卸载（等加载完再找，免得启动时找不到）
    await this.ready()
    const pre = this.packs.find(p => p.info.key === key)
    if (pre?.info.source === 'store') await this.storeTasks?.cancel(key.slice(2))
    return this.mutate(async () => {
      const pack = this.find(key)
      if (pack.info.source === 'builtin') throw codedError('extpacks.builtinRemove')
      if (pack.info.source === 'store') {
        const id = key.slice(2)
        // 先让贡献马上消失（去内存、删设置、让同 id 的内置版顶上、commit），再删文件；
        // 文件在队列里删（不会和同 id 的下一次安装交叉），删不掉的留给下次启动的 cleanStoreDir
        await this.removeStorePack(id)
        const log = (message: string): void => console.warn('[extension-packs]', message)
        await removeStoreFiles(this.storeDir, id, log)
        await this.opts.removeIcons?.(id).catch(() => undefined)
        return
      }
      this.data.folders = this.data.folders.filter(f => packKey('folder', resolve(f.path)) !== key)
      this.save()
      this.packs = this.packs.filter(p => p !== pack)
      applyWinners(this.packs)
      await this.refreshWrappers()
      this.commit()
    })
  }

  reload(key: string | null): Promise<void> {
    return this.mutate(async () => {
      const targets =
        key === null
          ? [...this.packs]
          : [
              this.find(key),
              ...this.packs.filter(p => p.info.key !== key && p.info.issues.some(i => i.code === 'pack.duplicateId')),
            ]
      for (const old of targets) {
        const fresh = await loadPack({
          key: old.info.key,
          root: old.root,
          source: old.info.source,
          enabled: old.info.enabled,
          addedAt: old.info.addedAt,
          options: old.info.options,
          revision: ++this.packRevision,
          appVersion: this.opts.appVersion,
          scanSvg: old.info.source === 'store' ? false : undefined,
        })
        // 商店扩展的回执信息和停用状态不在文件夹里，重新加载时带过去
        if (old.info.store) fresh.info.store = old.info.store
        if (old.info.blocked) fresh.info.blocked = old.info.blocked
        this.packs = this.packs.map(p => (p === old ? fresh : p))
      }
      this.markBlocked()
      applyWinners(this.packs)
      await this.refreshWrappers()
      this.commit()
    })
  }

  /**
   * 停用名单变了（market/blocklist-sync.ts 读到新名单后调）：重算每份商店扩展的 blocked（命中设上、解除清掉，
   * 开关状态没动过所以解除后回到原样），文件夹扩展同 id 同版本命中时只加一条警告，然后重算生效关系并 commit。
   */
  applyBlocklist(list: BlocklistFile): Promise<void> {
    return this.mutate(async () => {
      this.blocklist = list
      this.markBlocked()
      applyWinners(this.packs)
      await this.refreshWrappers()
      this.commit()
    })
  }

  /** 按当前名单重算商店扩展的 blocked 和文件夹扩展的 pack.storeBlocked 警告（不 commit） */
  private markBlocked(): void {
    for (const pack of this.packs) {
      const info = pack.info
      if (info.source === 'store' && info.store) {
        const hit = info.id ? matchBlocklist(this.blocklist, info.store.site, info.id, info.store.version) : null
        const block =
          hit ??
          (this.keyStatus(info.store.keyId, info.store.site) === 'revoked'
            ? { reason: REVOKED_KEY_REASON, at: new Date().toISOString() }
            : null)
        if (block) info.blocked = block
        else delete info.blocked
        info.live = computeLive(info)
      } else if (info.source === 'folder') {
        if (info.issues.some(i => i.code === 'pack.storeBlocked')) {
          info.issues = info.issues.filter(i => i.code !== 'pack.storeBlocked')
          info.status = packStatus(info.issues)
        }
        const version = info.manifest?.version
        const reason = info.id && version ? this.folderBlockReason(info.id, version) : null
        if (reason !== null) addPackIssue(pack, loaderIssue('pack.storeBlocked', { reason }))
        else info.live = computeLive(info)
      }
    }
  }

  /** 文件夹扩展不属于哪个站点，任何站点的名单命中都算 */
  private folderBlockReason(id: string, version: string): string | null {
    for (const site of Object.keys(this.blocklist.sites)) {
      const hit = matchBlocklist(this.blocklist, site, id, version)
      if (hit) return hit.reason
    }
    return null
  }

  setOptions(key: string, patch: ExtPackOptions): Promise<void> {
    return this.mutate(async () => {
      const pack = this.find(key)
      pack.info.options = { ...pack.info.options, ...patch }
      this.persist(pack)
      this.commit()
    })
  }

  // ---------- 读文件 ----------

  /** 路径合法 + 在文件表里（普通文件）+ 没有文件级错误；读取那一刻再核对一次“不是链接、真实路径在扩展目录内” */
  private async locate(key: string, path: string): Promise<{ pack: LoadedPack; rel: string; file: string } | null> {
    await this.ready()
    const pack = this.packs.find(p => p.info.key === key)
    if (!pack) return null
    const rel = resolvePackPath('', path)
    if (!rel || !pack.files.has(rel)) return null
    if (pack.info.issues.some(i => i.severity === 'error' && i.scope === 'file' && i.path === rel)) return null
    const file = join(pack.root, rel)
    try {
      if (!(await lstat(file)).isFile()) return null
      const [r, f] = await Promise.all([realpath(pack.root), realpath(file)])
      if (!f.startsWith(r.endsWith(sep) ? r : r + sep)) return null
    } catch {
      return null
    }
    return { pack, rel, file }
  }

  /** 只读 .json，≤2 MB，限制在扩展目录内，允许注释和结尾逗号 */
  async readJson(key: string, path: string): Promise<unknown> {
    await this.ready()
    this.find(key)
    if (!/\.json$/i.test(path)) throw codedError('extpacks.badPath')
    const hit = await this.locate(key, path)
    if (!hit || (hit.pack.files.get(hit.rel) ?? 0) > EXT_LIMITS.fileBytes) throw codedError('extpacks.badPath')
    try {
      return parseJsonc(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(hit.file)))
    } catch {
      throw codedError('extpacks.badPath')
    }
  }

  /** 只读 .md / .txt / LICENSE*，≤256 KB */
  async readText(key: string, path: string): Promise<string> {
    await this.ready()
    this.find(key)
    const name = path.split('/').pop() ?? ''
    if (!TEXT_FILE.test(name) && !LICENSE_FILE.test(name)) throw codedError('extpacks.badPath')
    const hit = await this.locate(key, path)
    if (!hit || (hit.pack.files.get(hit.rel) ?? 0) > EXT_LIMITS.textBytes) throw codedError('extpacks.badPath')
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(hit.file))
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    } catch {
      throw codedError('extpacks.badPath')
    }
  }

  /** 给资源协议用：svg / png，≤2 MB，扩展要生效（扩展自己的图标例外：停用的扩展在列表里也要显示图标） */
  async assetFile(key: string, path: string): Promise<{ file: string; mime: 'image/svg+xml' | 'image/png' } | null> {
    const mime = /\.svg$/i.test(path) ? 'image/svg+xml' : /\.png$/i.test(path) ? 'image/png' : null
    if (!mime) return null
    const hit = await this.locate(key, path)
    if (!hit) return null
    const { pack, rel } = hit
    if (!pack.info.live && !(pack.info.manifest && pack.info.manifest.icon === rel)) return null
    if ((pack.files.get(rel) ?? 0) > EXT_LIMITS.fileBytes) return null
    return { file: hit.file, mime }
  }

  location(key: string): string {
    return this.find(key).root
  }

  // ---------- 技能 ----------

  /** 同步；ready 之前只给一个 key（'' 或 'loading'），不给目录 */
  skillLaunch(engine: Engine): { key: string; pluginDirs: string[]; skillRoots: string[] } {
    if (engine === 'pixel') return { key: '', pluginDirs: [], skillRoots: [] }
    if (!this.ready_) return { key: this.preKey, pluginDirs: [], skillRoots: [] }
    return packSkillLaunch(
      this.packs.filter(p => p.info.live),
      this.wrappers,
      engine,
    )
  }

  skillCommands(): SkillCommand[] {
    return packSkillCommands(this.packs.filter(p => p.info.live))
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
