import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { packKey, scanLimits } from './loader'
import { ExtensionPacks, type ExtPacksOptions } from './service'
import { readStateFile, writeStateFile } from './store'
import { FOLDER_SCAN } from '@pixelsky/extension-cli/folder'
import type { BlocklistFile } from './market/blocklist'
import { cleanTemp, copyFixture, FIXTURES, installStoreFixture, tempDir } from './testing'

afterEach(cleanTemp)

interface Env {
  base: string
  dataDir: string
  builtinDir: string
  folders: string
}

function env(builtin: string[] = []): Env {
  const base = tempDir()
  const builtinDir = join(base, 'builtin')
  const folders = join(base, 'folders')
  mkdirSync(builtinDir)
  mkdirSync(folders)
  for (const name of builtin) copyFixture(name, builtinDir)
  return { base, dataDir: join(base, 'data'), builtinDir, folders }
}

const make = (e: Env, keyStatus?: ExtPacksOptions['keyStatus']): ExtensionPacks =>
  new ExtensionPacks({ dataDir: e.dataDir, builtinDir: e.builtinDir, appVersion: '0.4.1-beta', keyStatus })

async function started(e: Env): Promise<ExtensionPacks> {
  const svc = make(e)
  svc.start()
  await svc.ready()
  return svc
}

const stateFile = (e: Env): string => join(e.dataDir, 'state.json')
const pack = (svc: ExtensionPacks, id: string) => svc.state().packs.find(p => p.id === id)!

function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path)
    return true
  } catch {
    return false
  }
}

describe('加载', () => {
  it('构造不做 I/O，start 之前什么都没发生；start 幂等', async () => {
    const e = env(['pixelsky.dotenv'])
    const svc = make(e)
    expect(svc.state()).toEqual({ revision: 0, loading: true, packs: [] })
    expect(existsSync(e.dataDir)).toBe(false)
    svc.start()
    svc.start()
    await svc.ready()
    expect(svc.state().packs).toHaveLength(1)
    expect(svc.state().loading).toBe(false)
  })

  it('内置扩展：key 是 b-<id>，来源 builtin，默认启用', async () => {
    const svc = await started(env(['pixelsky.dotenv']))
    const [p] = svc.state().packs
    expect(p).toMatchObject({
      key: 'b-pixelsky.dotenv',
      id: 'pixelsky.dotenv',
      source: 'builtin',
      enabled: true,
      live: true,
    })
  })

  it('内置目录不存在也能启动', async () => {
    const e = env()
    const svc = new ExtensionPacks({ dataDir: e.dataDir, builtinDir: join(e.base, 'nope'), appVersion: '0.4.1-beta' })
    svc.start()
    await svc.ready()
    expect(svc.state().packs).toEqual([])
  })

  it('addFolder：加载、保存、广播，目录原样不动', async () => {
    const e = env()
    const svc = await started(e)
    const changed = vi.fn()
    svc.onChange(changed)
    const dir = copyFixture('pixelsky.dotenv', e.folders)
    const before = readFileSync(join(dir, 'pixelsky-extension.json'), 'utf8')
    const info = await svc.addFolder(dir)
    expect(info).toMatchObject({ id: 'pixelsky.dotenv', source: 'folder', enabled: true, live: true })
    expect(info.key).toMatch(/^f-[0-9a-f]{12}$/)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(readStateFile(stateFile(e)).folders.map(f => f.path)).toEqual([dir])
    expect(readFileSync(join(dir, 'pixelsky-extension.json'), 'utf8')).toBe(before)
  })

  it('addFolder 拒绝：没有清单、重复路径、重复 id', async () => {
    const e = env()
    const svc = await started(e)
    await expect(svc.addFolder(join(e.folders, 'missing'))).rejects.toThrow('extpacks.noManifest')
    const a = copyFixture('pixelsky.dotenv', e.folders, 'a')
    await svc.addFolder(a)
    await expect(svc.addFolder(a)).rejects.toThrow('extpacks.duplicatePath')
    const b = copyFixture('pixelsky.dotenv', e.folders, 'b')
    await expect(svc.addFolder(b)).rejects.toThrow('extpacks.duplicateId')
    expect(svc.state().packs).toHaveLength(1)
  })

  it('addFolder 遇到同 id 的内置时允许（文件夹生效、内置被替代），遇到同 id 的文件夹时拒绝', async () => {
    const e = env(['pixelsky.dotenv'])
    const svc = await started(e)
    const info = await svc.addFolder(copyFixture('pixelsky.dotenv', e.folders, 'a'))
    expect(info).toMatchObject({ source: 'folder', live: true })
    expect(svc.state().packs.find(p => p.source === 'builtin')).toMatchObject({ live: false, shadowedBy: 'folder' })
    await expect(svc.addFolder(copyFixture('pixelsky.dotenv', e.folders, 'b'))).rejects.toThrow('extpacks.duplicateId')
    // 移除文件夹那份，内置顶上
    await svc.remove(info.key)
    expect(svc.state().packs[0]).toMatchObject({ live: true })
    expect(svc.state().packs[0].shadowedBy).toBeUndefined()
  })

  it('有错误的扩展照样加进来（status error），作者能看到问题', async () => {
    const e = env()
    const svc = await started(e)
    const info = await svc.addFolder(copyFixture('bad-manifest', e.folders))
    expect(info.status).toBe('error')
    expect(info.live).toBe(false)
    expect(svc.state().packs).toHaveLength(1)
  })

  it('状态文件里内置 + 同 id 文件夹：文件夹生效，内置标 shadowedBy，没有错误', async () => {
    const e = env(['pixelsky.dotenv'])
    const dir = copyFixture('pixelsky.dotenv', e.folders)
    writeStateFile(stateFile(e), {
      version: 1,
      folders: [{ path: dir, enabled: true, addedAt: 5, options: {} }],
      builtin: {},
      store: {},
    })
    const svc = await started(e)
    const [builtin, folder] = svc.state().packs
    expect(builtin).toMatchObject({ source: 'builtin', status: 'ok', live: false, shadowedBy: 'folder' })
    expect(folder).toMatchObject({ source: 'folder', live: true })
    expect(folder.status).not.toBe('error')
    expect(folder.shadowedBy).toBeUndefined()
    expect(svc.state().packs.flatMap(p => p.issues.map(i => i.code))).not.toContain('pack.duplicateId')
  })

  it('状态文件里两个文件夹同 id：后到的整个扩展报错', async () => {
    const e = env()
    const a = copyFixture('pixelsky.dotenv', e.folders, 'a')
    const b = copyFixture('pixelsky.dotenv', e.folders, 'b')
    writeStateFile(stateFile(e), {
      version: 1,
      folders: [
        { path: a, enabled: true, addedAt: 1, options: {} },
        { path: b, enabled: true, addedAt: 2, options: {} },
      ],
      builtin: {},
      store: {},
    })
    const svc = await started(e)
    const [first, second] = svc.state().packs
    expect(first.status).not.toBe('error')
    expect(second.status).toBe('error')
    expect(second.issues.map(i => i.code)).toContain('pack.duplicateId')
  })

  it('删掉先到的重复 id 扩展后，后到的那个恢复正常', async () => {
    const e = env()
    const a = copyFixture('pixelsky.dotenv', e.folders, 'a')
    const b = copyFixture('pixelsky.dotenv', e.folders, 'b')
    writeStateFile(stateFile(e), {
      version: 1,
      folders: [
        { path: a, enabled: true, addedAt: 1, options: {} },
        { path: b, enabled: true, addedAt: 2, options: {} },
      ],
      builtin: {},
      store: {},
    })
    const svc = await started(e)
    const [first, second] = svc.state().packs
    expect(second.status).toBe('error')
    await svc.remove(first.key)
    const left = svc.state().packs[0]
    expect(left.key).toBe(second.key)
    expect(left.issues.map(i => i.code)).not.toContain('pack.duplicateId')
    expect(left.status).not.toBe('error')
    expect(left.live).toBe(true)
  })

  it('state.json 读不出来（不是损坏）：原文件不动，也不会被空状态覆盖', async () => {
    const e = env(['pixelsky.dotenv'])
    mkdirSync(stateFile(e), { recursive: true }) // 当目录用，readFileSync 会抛 EISDIR
    const svc = await started(e)
    await svc.setEnabled('b-pixelsky.dotenv', false)
    expect(readdirSync(e.dataDir).filter(n => n.startsWith('state.json'))).toEqual(['state.json'])
    expect(readdirSync(stateFile(e))).toEqual([])
    const st = readStateFile(stateFile(e))
    expect(st.unreadable).toBe(true)
    expect(st.folders).toEqual([])
  })

  it('builtinReady 之后内置扩展已经在 state() 里，文件夹扩展还在加载（loading: true）', async () => {
    const e = env(['pixelsky.dotenv'])
    const dir = copyFixture('with-skill', e.folders)
    writeStateFile(stateFile(e), {
      version: 1,
      folders: [{ path: dir, enabled: true, addedAt: 5, options: {} }],
      builtin: {},
      store: {},
    })
    const svc = make(e)
    await svc.builtinReady()
    const mid = svc.state()
    expect(mid.loading).toBe(true)
    expect(mid.packs.map(p => p.source)).toEqual(['builtin'])
    await svc.ready()
    expect(svc.state().loading).toBe(false)
    expect(svc.state().packs.map(p => p.source)).toEqual(['builtin', 'folder'])
  })

  it('损坏的 state.json：留一份 .bad，用空状态启动', async () => {
    const e = env(['pixelsky.dotenv'])
    mkdirSync(e.dataDir, { recursive: true })
    writeFileSync(stateFile(e), '{ oops')
    const svc = await started(e)
    expect(svc.state().packs).toHaveLength(1)
    expect(readdirSync(e.dataDir).some(n => n.startsWith('state.json.bad-'))).toBe(true)
  })
})

describe('开关、移除、重新加载、选项', () => {
  it('启用 / 停用写进状态文件，换一个实例还在', async () => {
    const e = env(['pixelsky.dotenv'])
    const svc = await started(e)
    const key = svc.state().packs[0].key
    await svc.setEnabled(key, false)
    expect(svc.state().packs[0]).toMatchObject({ enabled: false, live: false })
    const second = await started(e)
    expect(second.state().packs[0]).toMatchObject({ enabled: false, live: false })
    await second.setEnabled(key, true)
    expect((await started(e)).state().packs[0].live).toBe(true)
  })

  it('文件夹扩展的开关和选项也跨实例保存', async () => {
    const e = env()
    const svc = await started(e)
    const info = await svc.addFolder(copyFixture('pixelsky.dotenv', e.folders))
    await svc.setEnabled(info.key, false)
    await svc.setOptions(info.key, { overrideBuiltin: ['dotenv'] })
    const again = await started(e)
    expect(again.state().packs[0]).toMatchObject({ enabled: false, options: { overrideBuiltin: ['dotenv'] } })
  })

  it('每次变更 revision 加一并通知监听者；取消监听后不再通知', async () => {
    const e = env(['pixelsky.dotenv'])
    const svc = await started(e)
    const r0 = svc.state().revision
    const listener = vi.fn()
    const off = svc.onChange(listener)
    await svc.setEnabled(svc.state().packs[0].key, false)
    expect(svc.state().revision).toBe(r0 + 1)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    await svc.setEnabled(svc.state().packs[0].key, true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('移除文件夹扩展：从列表和状态文件去掉，目录还在；内置不能移除', async () => {
    const e = env(['pixelsky.dotenv'])
    const svc = await started(e)
    const dir = copyFixture('with-skill', e.folders)
    const info = await svc.addFolder(dir)
    await svc.remove(info.key)
    expect(svc.state().packs.map(p => p.source)).toEqual(['builtin'])
    expect(readStateFile(stateFile(e)).folders).toEqual([])
    expect(existsSync(join(dir, 'pixelsky-extension.json'))).toBe(true)
    await expect(svc.remove('b-pixelsky.dotenv')).rejects.toThrow('extpacks.builtinRemove')
    await expect(svc.remove('f-nope')).rejects.toThrow('extpacks.unknownPack')
  })

  it('重新加载：扩展自己的 revision 加一并读到新内容', async () => {
    const e = env()
    const svc = await started(e)
    const dir = copyFixture('with-skill', e.folders)
    const info = await svc.addFolder(dir)
    const file = join(dir, 'pixelsky-extension.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('Two skills, one per engine mix', 'Edited description'))
    await svc.reload(info.key)
    const after = pack(svc, 'pixelsky.with-skill')
    expect(after.revision).toBe(info.revision + 1)
    expect(after.manifest?.description).toBe('Edited description')
    await svc.reload(null)
    expect(pack(svc, 'pixelsky.with-skill').revision).toBe(info.revision + 2)
  })

  it('重新加载能让坏扩展变好', async () => {
    const e = env()
    const svc = await started(e)
    const dir = copyFixture('bad-manifest', e.folders)
    const info = await svc.addFolder(dir)
    expect(info.status).toBe('error')
    writeFileSync(
      join(dir, 'pixelsky-extension.json'),
      readFileSync(join(FIXTURES, 'with-tasks/pixelsky-extension.json')),
    )
    await svc.reload(info.key)
    expect(svc.state().packs[0].id).toBe('pixelsky.with-tasks')
    expect(svc.state().packs[0].status).not.toBe('error')
  })

  it('串行执行：同时发起的变更都完成，状态一致', async () => {
    const e = env()
    const svc = await started(e)
    const a = copyFixture('with-skill', e.folders, 'a')
    const b = copyFixture('with-tasks', e.folders, 'b')
    await Promise.all([svc.addFolder(a), svc.addFolder(b)])
    expect(svc.state().packs).toHaveLength(2)
    expect(readStateFile(stateFile(e)).folders).toHaveLength(2)
  })
})

describe('readJson / readText / assetFile', () => {
  async function withDotenv(): Promise<{ svc: ExtensionPacks; key: string; dir: string; e: Env }> {
    const e = env()
    const svc = await started(e)
    const dir = copyFixture('pixelsky.dotenv', e.folders)
    const info = await svc.addFolder(dir)
    return { svc, key: info.key, dir, e }
  }

  it('readJson：读 .json，允许注释和结尾逗号', async () => {
    const { svc, key, dir } = await withDotenv()
    expect(await svc.readJson(key, 'syntaxes/dotenv.tmLanguage.json')).toMatchObject({ scopeName: 'source.dotenv' })
    writeFileSync(join(dir, 'snippets', 'extra.json'), '// 注释\n{ "a": 1, }')
    await svc.reload(key)
    expect(await svc.readJson(key, 'snippets/extra.json')).toEqual({ a: 1 })
  })

  it('readJson 拒绝：越界、绝对路径、反斜杠、非 json、不存在、未知扩展', async () => {
    const { svc, key, dir } = await withDotenv()
    writeFileSync(join(dir, '..', 'x.json'), '{}')
    for (const bad of [
      '../x.json',
      '/etc/passwd.json',
      'C:/x.json',
      'syntaxes\\dotenv.tmLanguage.json',
      'README.md',
      'nope.json',
    ])
      await expect(svc.readJson(key, bad)).rejects.toThrow('extpacks.badPath')
    await expect(svc.readJson('f-none', 'a.json')).rejects.toThrow('extpacks.unknownPack')
  })

  it('readText：只读 .md / .txt / LICENSE*', async () => {
    const { svc, key } = await withDotenv()
    expect(await svc.readText(key, 'README.md')).toContain('#')
    expect(await svc.readText(key, 'LICENSE')).toBeTruthy()
    await expect(svc.readText(key, 'pixelsky-extension.json')).rejects.toThrow('extpacks.badPath')
    await expect(svc.readText(key, '../README.md')).rejects.toThrow('extpacks.badPath')
  })

  it('readText 太大：拒绝（≤256 KB）', async () => {
    const { svc, key, dir } = await withDotenv()
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(300 * 1024))
    await svc.reload(key)
    await expect(svc.readText(key, 'big.md')).rejects.toThrow('extpacks.badPath')
  })

  it('readJson 不读符号链接', async () => {
    const { svc, key, dir, e } = await withDotenv()
    writeFileSync(join(e.base, 'outside.json'), '{"secret":1}')
    if (!trySymlink(join(e.base, 'outside.json'), join(dir, 'link.json'))) return
    await svc.reload(key)
    await expect(svc.readJson(key, 'link.json')).rejects.toThrow('extpacks.badPath')
  })

  it('assetFile：svg / png 给文件和类型，json、不存在、越界都是 null', async () => {
    const e = env()
    const svc = await started(e)
    const dir = copyFixture('unsafe-svg', e.folders)
    const key = (await svc.addFolder(dir)).key
    expect(await svc.assetFile(key, 'icons/good.svg')).toEqual({
      file: join(dir, 'icons/good.svg'),
      mime: 'image/svg+xml',
    })
    writeFileSync(join(dir, 'icons', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await svc.reload(key)
    expect((await svc.assetFile(key, 'icons/a.png'))?.mime).toBe('image/png')
    expect(await svc.assetFile(key, 'icons.json')).toBeNull()
    expect(await svc.assetFile(key, 'icons/none.svg')).toBeNull()
    expect(await svc.assetFile(key, '../x.svg')).toBeNull()
    expect(await svc.assetFile('f-none', 'icons/good.svg')).toBeNull()
  })

  it('assetFile 拒绝不安全的 svg（file 级错误）', async () => {
    const e = env()
    const svc = await started(e)
    const dir = copyFixture('unsafe-svg', e.folders)
    const info = await svc.addFolder(dir)
    expect(info.issues.some(i => i.code === 'svg.unsafe' && i.scope === 'file')).toBe(true)
    expect(await svc.assetFile(info.key, 'icons/bad.svg')).toBeNull()
  })

  it('assetFile 拒绝停用的扩展（扩展自己的图标除外）', async () => {
    const e = env()
    const svc = await started(e)
    const info = await svc.addFolder(copyFixture('unsafe-svg', e.folders))
    await svc.setEnabled(info.key, false)
    expect(await svc.assetFile(info.key, 'icons/good.svg')).toBeNull()
    await svc.setEnabled(info.key, true)
    expect(await svc.assetFile(info.key, 'icons/good.svg')).not.toBeNull()
  })

  it('assetFile 拒绝符号链接', async () => {
    const e = env()
    const svc = await started(e)
    const dir = copyFixture('unsafe-svg', e.folders)
    if (!trySymlink(join(dir, 'icons', 'good.svg'), join(dir, 'icons', 'link.svg'))) return
    const info = await svc.addFolder(dir)
    expect(await svc.assetFile(info.key, 'icons/link.svg')).toBeNull()
  })

  it('location：扩展目录；未知 key 抛 unknownPack', async () => {
    const { svc, key, dir } = await withDotenv()
    expect(svc.location(key)).toBe(dir)
    expect(() => svc.location('f-none')).toThrow('extpacks.unknownPack')
  })
})

describe('技能', () => {
  const skillState = (e: Env, dir: string): void =>
    writeStateFile(stateFile(e), {
      version: 1,
      folders: [{ path: dir, enabled: true, addedAt: 5, options: {} }],
      builtin: {},
      store: {},
    })

  it('ready 之前：没有带技能的扩展 key 为空，有就是 loading，且不给目录', async () => {
    const empty = env(['pixelsky.dotenv'])
    const a = make(empty)
    a.start()
    expect(a.skillLaunch('claude')).toEqual({ key: '', pluginDirs: [], skillRoots: [] })
    await a.ready()

    const e = env()
    skillState(e, copyFixture('with-skill', e.folders))
    const b = make(e)
    b.start()
    expect(b.skillLaunch('claude')).toEqual({ key: 'loading', pluginDirs: [], skillRoots: [] })
    expect(b.skillLaunch('codex').key).toBe('loading')
    expect(b.skillLaunch('pixel').key).toBe('')
    await b.ready()
    expect(b.skillLaunch('claude').key).not.toBe('loading')
  })

  it('claude：插件目录已建好；codex：技能目录；命令列表', async () => {
    const e = env()
    const svc = await started(e)
    const dir = copyFixture('with-skill', e.folders)
    await svc.addFolder(dir)
    const claude = svc.skillLaunch('claude')
    expect(claude.pluginDirs).toHaveLength(1)
    expect(existsSync(join(claude.pluginDirs[0], 'skills', 'hello', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(claude.pluginDirs[0], '.claude-plugin', 'plugin.json'))).toBe(true)
    const codex = svc.skillLaunch('codex')
    expect(codex.skillRoots).toEqual([join(dir, 'skills/hello'), join(dir, 'skills/hola')])
    expect(svc.skillCommands().map(c => c.name)).toEqual(['ext-pixelsky-with-skill:hello'])
  })

  it('无关扩展开关：claude key 不变，已有包装目录不动', async () => {
    const e = env(['pixelsky.dotenv'])
    const svc = await started(e)
    await svc.addFolder(copyFixture('with-skill', e.folders))
    const before = svc.skillLaunch('claude')
    const dirs = readdirSync(join(e.dataDir, 'runtime', 'claude'))
    await svc.setEnabled('b-pixelsky.dotenv', false)
    await svc.setEnabled('b-pixelsky.dotenv', true)
    const icon = await svc.addFolder(copyFixture('unsafe-svg', e.folders))
    await svc.setEnabled(icon.key, false)
    expect(svc.skillLaunch('claude')).toEqual(before)
    expect(readdirSync(join(e.dataDir, 'runtime', 'claude'))).toEqual(dirs)
  })

  it('停用带技能的扩展：key 变空；再启用恢复同一个目录', async () => {
    const e = env()
    const svc = await started(e)
    const info = await svc.addFolder(copyFixture('with-skill', e.folders))
    const on = svc.skillLaunch('claude')
    await svc.setEnabled(info.key, false)
    expect(svc.skillLaunch('claude').key).toBe('')
    expect(svc.skillCommands()).toEqual([])
    await svc.setEnabled(info.key, true)
    expect(svc.skillLaunch('claude')).toEqual(on)
  })

  it('重新加载后包装目录换名（内容寻址），旧的留到下次启动才清', async () => {
    const e = env()
    const svc = await started(e)
    const info = await svc.addFolder(copyFixture('with-skill', e.folders))
    const old = svc.skillLaunch('claude')
    await svc.reload(info.key)
    const fresh = svc.skillLaunch('claude')
    expect(fresh.pluginDirs[0]).not.toBe(old.pluginDirs[0])
    expect(existsSync(old.pluginDirs[0])).toBe(true)
    // 下次启动：start() 清空包装目录，再给带技能的扩展重建
    const next = await started(e)
    expect(existsSync(fresh.pluginDirs[0])).toBe(false)
    expect(next.skillLaunch('claude').pluginDirs).toHaveLength(1)
  })

  it('移除 → 改文件 → 重新添加同一目录：revision 不复用，读到新内容，Claude 包装是新的 SKILL.md', async () => {
    const e = env()
    const svc = await started(e)
    const dir = copyFixture('with-skill', e.folders)
    const first = await svc.addFolder(dir)
    const oldDir = svc.skillLaunch('claude').pluginDirs[0]
    await svc.remove(first.key)
    const skill = join(dir, 'skills', 'hello', 'SKILL.md')
    writeFileSync(
      skill,
      readFileSync(skill, 'utf8').replace('Say hello to the user.', 'New instructions after reinstall.'),
    )
    const second = await svc.addFolder(dir)
    expect(second.key).toBe(first.key)
    expect(second.revision).toBeGreaterThan(first.revision)
    const next = svc.skillLaunch('claude').pluginDirs[0]
    expect(next).not.toBe(oldDir)
    expect(readFileSync(join(next, 'skills', 'hello', 'SKILL.md'), 'utf8')).toContain(
      'New instructions after reinstall.',
    )
  })

  it('移除 → 改片段 → 重新添加：readJson 与 revision 都是新的', async () => {
    const e = env()
    const svc = await started(e)
    const dir = copyFixture('pixelsky.dotenv', e.folders)
    const snippets = join(dir, 'snippets', 'dotenv.json')
    writeFileSync(snippets, '{"example":{"prefix":"demo","body":"OLD"}}')
    const first = await svc.addFolder(dir)
    expect(await svc.readJson(first.key, 'snippets/dotenv.json')).toEqual({ example: { prefix: 'demo', body: 'OLD' } })
    await svc.remove(first.key)
    writeFileSync(snippets, '{"example":{"prefix":"demo","body":"NEW"}}')
    const second = await svc.addFolder(dir)
    expect(second.revision).not.toBe(first.revision)
    expect(await svc.readJson(second.key, 'snippets/dotenv.json')).toEqual({ example: { prefix: 'demo', body: 'NEW' } })
  })

  it('改 SKILL.md 后重新加载：包装目录换名并带新正文', async () => {
    const e = env()
    const svc = await started(e)
    const dir = copyFixture('with-skill', e.folders)
    const info = await svc.addFolder(dir)
    const old = svc.skillLaunch('claude').pluginDirs[0]
    const skill = join(dir, 'skills', 'hello', 'SKILL.md')
    writeFileSync(skill, readFileSync(skill, 'utf8') + '\nReloaded text.\n')
    await svc.reload(info.key)
    const fresh = svc.skillLaunch('claude').pluginDirs[0]
    expect(fresh).not.toBe(old)
    expect(readFileSync(join(fresh, 'skills', 'hello', 'SKILL.md'), 'utf8')).toContain('Reloaded text.')
  })

  it('GC 只在 start() 里跑：构造和其它调用不清包装目录', async () => {
    const e = env()
    const svc = await started(e)
    await svc.addFolder(copyFixture('with-skill', e.folders))
    const dir = svc.skillLaunch('claude').pluginDirs[0]
    const other = make(e)
    other.state()
    other.skillLaunch('claude')
    expect(existsSync(dir)).toBe(true)
    await svc.reload(null)
    expect(existsSync(dir)).toBe(true)
  })
})

describe('商店扩展：加载顺序和同 id 生效', () => {
  const SITE = 'https://auth.pixelstarrysky.xyz'
  type Snap = Array<{ key: string; source: string; live: boolean; shadowedBy?: string }>
  const storeDir = (e: Env): string => join(e.dataDir, 'store')
  /** 记下每次 commit 时 state().packs 的来源和 live */
  function recordCommits(svc: ExtensionPacks): Snap[] {
    const seen: Snap[] = []
    svc.onChange(() =>
      seen.push(svc.state().packs.map(p => ({ key: p.key, source: p.source, live: p.live, shadowedBy: p.shadowedBy }))),
    )
    return seen
  }
  const writeBlocklist = (e: Env, id: string, versions: '*' | string[], site: string = SITE): void => {
    mkdirSync(e.dataDir, { recursive: true })
    writeFileSync(
      join(e.dataDir, 'blocklist.json'),
      JSON.stringify({
        version: 1,
        sites: {
          [site]: {
            fetchedAt: '2026-10-16T00:00:00.000Z',
            updatedAt: '',
            items: [{ id, versions, reason: '含恶意代码' }],
          },
        },
      }),
    )
  }

  it('商店扩展启动后在列表里，loadFolders 不会把它丢掉；顺序是内置、商店、文件夹', async () => {
    const e = env(['pixelsky.dotenv'])
    installStoreFixture(storeDir(e), 'with-skill', 'pixelsky.with-skill', { version: '2.0.0' })
    const dir = copyFixture('with-tasks', e.folders)
    writeStateFile(stateFile(e), {
      version: 1,
      folders: [{ path: dir, enabled: true, addedAt: 5, options: {} }],
      builtin: {},
      store: {},
    })
    const svc = make(e)
    await svc.builtinReady()
    // builtinReady 返回时商店扩展已经在列表里，文件夹扩展还没加载
    expect(svc.state().loading).toBe(true)
    expect(svc.state().packs.map(p => p.source)).toEqual(['builtin', 'store'])
    await svc.ready()
    const packs = svc.state().packs
    expect(packs.map(p => p.source)).toEqual(['builtin', 'store', 'folder'])
    expect(packs[1]).toMatchObject({
      key: 's-pixelsky.with-skill',
      id: 'pixelsky.with-skill',
      live: true,
      addedAt: 1000,
      store: { version: '2.0.0', installedAt: 1000, keyId: '8273f03a', site: SITE },
    })
  })

  it('第一次 commit 就有商店扩展，没有只含内置的那一次；第二份加上文件夹', async () => {
    const e = env(['pixelsky.dotenv'])
    installStoreFixture(storeDir(e), 'with-skill', 'pixelsky.with-skill')
    const dir = copyFixture('with-tasks', e.folders)
    writeStateFile(stateFile(e), {
      version: 1,
      folders: [{ path: dir, enabled: true, addedAt: 5, options: {} }],
      builtin: {},
      store: {},
    })
    const svc = make(e)
    const seen = recordCommits(svc)
    await svc.ready()
    expect(seen.map(c => c.map(p => p.source))).toEqual([
      ['builtin', 'store'],
      ['builtin', 'store', 'folder'],
    ])
  })

  it('商店版 + 同 id 内置：第一次 commit 时内置那份已经是 shadowedBy（不闪）', async () => {
    const e = env(['pixelsky.dotenv'])
    installStoreFixture(storeDir(e), 'pixelsky.dotenv', 'pixelsky.dotenv')
    const svc = make(e)
    const seen = recordCommits(svc)
    await svc.ready()
    expect(seen[0]).toEqual([
      { key: 'b-pixelsky.dotenv', source: 'builtin', live: false, shadowedBy: 'store' },
      { key: 's-pixelsky.dotenv', source: 'store', live: true, shadowedBy: undefined },
    ])
    expect(svc.state().packs.flatMap(p => p.issues.map(i => i.code))).not.toContain('pack.duplicateId')
  })

  it('文件夹 > 商店 > 内置：三份同 id 时只有文件夹生效，两份被它替代；移除文件夹后商店顶上', async () => {
    const e = env(['pixelsky.dotenv'])
    installStoreFixture(storeDir(e), 'pixelsky.dotenv', 'pixelsky.dotenv')
    const svc = await started(e)
    const info = await svc.addFolder(copyFixture('pixelsky.dotenv', e.folders))
    const by = Object.fromEntries(svc.state().packs.map(p => [p.source, p]))
    expect(by.folder).toMatchObject({ live: true })
    expect(by.store).toMatchObject({ live: false, shadowedBy: 'folder' })
    expect(by.builtin).toMatchObject({ live: false, shadowedBy: 'folder' })
    await svc.remove(info.key)
    const after = Object.fromEntries(svc.state().packs.map(p => [p.source, p]))
    expect(after.store).toMatchObject({ live: true })
    expect(after.builtin).toMatchObject({ live: false, shadowedBy: 'store' })
  })

  it('被替代的那份点启用：enabled 变 true、live 仍是 false、shadowedBy 不变；生效的关掉后它顶上', async () => {
    const e = env(['pixelsky.dotenv'])
    installStoreFixture(storeDir(e), 'pixelsky.dotenv', 'pixelsky.dotenv')
    writeStateFile(stateFile(e), {
      version: 1,
      folders: [],
      builtin: { 'pixelsky.dotenv': { enabled: false, options: {} } },
      store: {},
    })
    const svc = await started(e)
    // 内置关着，商店生效：内置被替代
    expect(svc.state().packs[0]).toMatchObject({ enabled: false, live: false, shadowedBy: 'store' })
    await svc.setEnabled('b-pixelsky.dotenv', true)
    expect(svc.state().packs[0]).toMatchObject({ enabled: true, live: false, shadowedBy: 'store' })
    expect(readStateFile(stateFile(e)).builtin['pixelsky.dotenv'].enabled).toBe(true)
    await svc.setEnabled('s-pixelsky.dotenv', false)
    expect(svc.state().packs[0]).toMatchObject({ live: true })
    expect(svc.state().packs[0].shadowedBy).toBeUndefined()
    expect(svc.state().packs[1]).toMatchObject({ enabled: false, live: false })
  })

  it('商店扩展的开关和选项写进 state.json 的 store，换一个实例还在', async () => {
    const e = env()
    installStoreFixture(storeDir(e), 'with-skill', 'pixelsky.with-skill')
    const svc = await started(e)
    await svc.setEnabled('s-pixelsky.with-skill', false)
    await svc.setOptions('s-pixelsky.with-skill', { overrideBuiltin: ['x'] })
    expect(readStateFile(stateFile(e)).store).toEqual({
      'pixelsky.with-skill': { enabled: false, options: { overrideBuiltin: ['x'] } },
    })
    expect(readStateFile(stateFile(e)).builtin).toEqual({})
    const again = await started(e)
    expect(again.state().packs[0]).toMatchObject({ enabled: false, live: false, options: { overrideBuiltin: ['x'] } })
  })

  it('钥匙已作废的显示为被停用（blocked、live 为 false），preReadKey 不算它', async () => {
    const e = env()
    installStoreFixture(storeDir(e), 'with-skill', 'pixelsky.with-skill')
    const keyStatus = vi.fn(() => 'revoked' as const)
    const svc = make(e, keyStatus)
    svc.start()
    expect(svc.skillLaunch('claude').key).toBe('')
    await svc.ready()
    expect(keyStatus).toHaveBeenCalledWith('8273f03a', SITE)
    expect(svc.state().packs[0]).toMatchObject({ live: false, enabled: true, blocked: { reason: '签名钥匙已作废' } })
    // 对照：钥匙正常时 preReadKey 算它
    const ok = make(e, () => 'active')
    ok.start()
    expect(ok.skillLaunch('claude').key).toBe('loading')
    await ok.ready()
    expect(ok.state().packs[0]).toMatchObject({ live: true })
    expect(ok.state().packs[0].blocked).toBeUndefined()
  })

  it('上次存的停用名单在第一次 commit 时就生效，同 id 的内置顶上；版本对不上或别的站点的名单不命中', async () => {
    const e = env(['pixelsky.dotenv'])
    installStoreFixture(storeDir(e), 'pixelsky.dotenv', 'pixelsky.dotenv', { version: '1.5.0' })
    writeBlocklist(e, 'pixelsky.dotenv', ['1.5.0'])
    const svc = make(e)
    const seen = recordCommits(svc)
    await svc.ready()
    expect(seen[0]).toEqual([
      { key: 'b-pixelsky.dotenv', source: 'builtin', live: true, shadowedBy: undefined },
      { key: 's-pixelsky.dotenv', source: 'store', live: false, shadowedBy: 'builtin' }, // 被停用的那份也算「其他几份」
    ])
    expect(svc.state().packs[1].blocked).toEqual({ reason: '含恶意代码', at: '2026-10-16T00:00:00.000Z' })

    const e2 = env()
    installStoreFixture(storeDir(e2), 'pixelsky.dotenv', 'pixelsky.dotenv', { version: '1.6.0' })
    writeBlocklist(e2, 'pixelsky.dotenv', ['1.5.0'])
    expect((await started(e2)).state().packs[0].live).toBe(true)

    const e3 = env()
    installStoreFixture(storeDir(e3), 'pixelsky.dotenv', 'pixelsky.dotenv')
    writeBlocklist(e3, 'pixelsky.dotenv', '*', 'http://127.0.0.1:8080')
    expect((await started(e3)).state().packs[0].live).toBe(true)
  })

  it('preReadKey：名单命中的、关着的商店扩展都不算带技能', async () => {
    const e = env()
    installStoreFixture(storeDir(e), 'with-skill', 'pixelsky.with-skill')
    writeBlocklist(e, 'pixelsky.with-skill', '*')
    const a = make(e)
    a.start()
    expect(a.skillLaunch('claude').key).toBe('')
    await a.ready()

    const e2 = env()
    installStoreFixture(storeDir(e2), 'with-skill', 'pixelsky.with-skill')
    writeStateFile(stateFile(e2), {
      version: 1,
      folders: [],
      builtin: {},
      store: { 'pixelsky.with-skill': { enabled: false, options: {} } },
    })
    const b = make(e2)
    b.start()
    expect(b.skillLaunch('claude').key).toBe('')
    await b.ready()
  })

  it('install.json 坏了、目录缺失的跳过并写日志，不影响别的商店扩展；.tmp 不是扩展', async () => {
    const e = env()
    installStoreFixture(storeDir(e), 'with-skill', 'pixelsky.with-skill')
    mkdirSync(join(storeDir(e), 'acme.bad'), { recursive: true })
    writeFileSync(join(storeDir(e), 'acme.bad', 'install.json'), '{ oops')
    installStoreFixture(storeDir(e), 'pixelsky.dotenv', 'acme.gone')
    rmSync(join(storeDir(e), 'acme.gone', 'aaaaaaaaaaaaaaaa'), { recursive: true })
    mkdirSync(join(storeDir(e), '.tmp', 'x'), { recursive: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = await started(e)
    expect(svc.state().packs.map(p => p.key)).toEqual(['s-pixelsky.with-skill'])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('商店扩展的扫描上限是 FOLDER_SCAN（记下当前值，Material 搬家时再定）', () => {
    expect(FOLDER_SCAN).toEqual({ limitFiles: 5000, limitBytes: 50 * 1024 * 1024 })
    expect(scanLimits('store')).toBe(FOLDER_SCAN)
    expect(scanLimits('folder')).toBe(FOLDER_SCAN)
    expect(scanLimits('builtin')).not.toBe(FOLDER_SCAN)
  })

  it('packKey 的 store 分支：s-<小写 id>', () => {
    expect(packKey('store', 'Acme.X')).toBe('s-acme.x')
  })

  it('商店扩展启动时不扫 SVG 内容，同一份放在文件夹里会扫出问题', async () => {
    const e = env()
    installStoreFixture(storeDir(e), 'unsafe-svg', 'pixelsky.unsafe-svg')
    const store = (await started(e)).state().packs[0]
    const e2 = env()
    const svc = await started(e2)
    const folder = await svc.addFolder(copyFixture('unsafe-svg', e2.folders))
    expect(folder.issues.length).toBeGreaterThan(store.issues.length)
  })
})

describe('商店扩展：卸载', () => {
  const storeDir = (e: Env): string => join(e.dataDir, 'store')

  it('卸载后 state.json 里没有 store[id]；重新装同 id 按第一次装处理，不沿用卸载前的开关', async () => {
    const e = env()
    installStoreFixture(storeDir(e), 'pixelsky.dotenv', 'pixelsky.dotenv')
    writeStateFile(stateFile(e), {
      version: 1,
      folders: [],
      builtin: {},
      store: { 'pixelsky.dotenv': { enabled: false, options: { overrideBuiltin: ['x'] } } },
    })
    const svc = await started(e)
    expect(pack(svc, 'pixelsky.dotenv')).toMatchObject({ source: 'store', enabled: false })
    await svc.remove('s-pixelsky.dotenv')
    expect(svc.state().packs).toEqual([])
    expect(readStateFile(stateFile(e)).store).toEqual({})
    expect(JSON.parse(readFileSync(stateFile(e), 'utf8')).store).toEqual({})
    // 同 id 重新装：state.json 里没有 → 默认开着
    const record = installStoreFixture(storeDir(e), 'pixelsky.dotenv', 'pixelsky.dotenv')
    const info = await svc.runExclusive(() =>
      svc.replaceStorePack(record, join(storeDir(e), 'pixelsky.dotenv', record.dir)),
    )
    expect(info).toMatchObject({ enabled: true, live: true, options: {} })
    expect(readStateFile(stateFile(e)).store['pixelsky.dotenv']).toEqual({ enabled: true, options: {} })
  })

  it('先 commit 再删文件：commit 时 install.json 还在，但状态里已经没有这个扩展，同 id 的内置版顶上', async () => {
    const e = env(['pixelsky.dotenv'])
    installStoreFixture(storeDir(e), 'pixelsky.dotenv', 'pixelsky.dotenv')
    const svc = await started(e)
    expect(svc.state().packs.map(p => [p.source, p.live])).toEqual([
      ['builtin', false],
      ['store', true],
    ])
    const seen: Array<{ installJson: boolean; packs: Array<[string, boolean, string | undefined]> }> = []
    svc.onChange(() =>
      seen.push({
        installJson: existsSync(join(storeDir(e), 'pixelsky.dotenv', 'install.json')),
        packs: svc.state().packs.map(p => [p.source, p.live, p.shadowedBy]),
      }),
    )
    await svc.remove('s-pixelsky.dotenv')
    expect(seen).toEqual([{ installJson: true, packs: [['builtin', true, undefined]] }])
    expect(existsSync(join(storeDir(e), 'pixelsky.dotenv'))).toBe(false)
  })

  it('有任务时先调 cancel(id)，再卸载；没挂 installer 时跳过', async () => {
    const e = env()
    installStoreFixture(storeDir(e), 'pixelsky.dotenv', 'pixelsky.dotenv')
    const svc = await started(e)
    const order: string[] = []
    svc.attachStoreTasks({
      cancel: async id => {
        order.push(`cancel:${id}`)
        // 取消返回时还没卸载
        order.push(`still:${svc.state().packs.length}`)
      },
    })
    svc.onChange(() => order.push('commit'))
    await svc.remove('s-pixelsky.dotenv')
    expect(order).toEqual(['cancel:pixelsky.dotenv', 'still:1', 'commit'])
    // 文件夹扩展不调 cancel
    const info = await svc.addFolder(copyFixture('pixelsky.dotenv', e.folders))
    order.length = 0
    await svc.remove(info.key)
    expect(order).toEqual(['commit'])
  })

  it('卸载时删图标缓存；内置扩展仍不能卸载', async () => {
    const e = env(['pixelsky.dotenv'])
    installStoreFixture(storeDir(e), 'with-skill', 'pixelsky.with-skill')
    const removed: string[] = []
    const svc = new ExtensionPacks({
      dataDir: e.dataDir,
      builtinDir: e.builtinDir,
      appVersion: '0.4.1-beta',
      removeIcons: async id => void removed.push(id),
    })
    svc.start()
    await svc.ready()
    await expect(svc.remove('b-pixelsky.dotenv')).rejects.toThrow('extpacks.builtinRemove')
    await svc.remove('s-pixelsky.with-skill')
    expect(removed).toEqual(['pixelsky.with-skill'])
  })

  it('启动时 cleanStoreDir 在 loadStore 之前跑：.tmp、没有回执的目录、多余版本目录都清掉', async () => {
    const e = env()
    installStoreFixture(storeDir(e), 'pixelsky.dotenv', 'pixelsky.dotenv')
    mkdirSync(join(storeDir(e), '.tmp', 'half'), { recursive: true })
    mkdirSync(join(storeDir(e), 'acme.orphan', 'aaaaaaaaaaaaaaaa'), { recursive: true })
    mkdirSync(join(storeDir(e), 'pixelsky.dotenv', 'cccccccccccccccc'))
    const svc = await started(e)
    expect(svc.state().packs.map(p => p.id)).toEqual(['pixelsky.dotenv'])
    expect(readdirSync(storeDir(e)).sort()).toEqual(['pixelsky.dotenv'])
    expect(readdirSync(join(storeDir(e), 'pixelsky.dotenv')).sort()).toEqual(['aaaaaaaaaaaaaaaa', 'install.json'])
  })
})

describe('停用名单：applyBlocklist 和 setEnabled', () => {
  const SITE = 'https://auth.pixelstarrysky.xyz'
  const OTHER = 'http://127.0.0.1:8080'
  type Item = { id: string; versions: '*' | string[] }
  const siteOf = (items: Item[]): BlocklistFile['sites'][string] => ({
    fetchedAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '',
    items: items.map(i => ({ ...i, reason: '含恶意代码' })),
  })
  const listOf = (items: Item[], site: string = SITE): BlocklistFile => ({
    version: 1,
    sites: { [site]: siteOf(items) },
  })
  const id = 'pixelsky.with-skill'
  const key = 's-pixelsky.with-skill'
  const storeEnv = async (): Promise<{ e: Env; svc: ExtensionPacks }> => {
    const e = env()
    installStoreFixture(join(e.dataDir, 'store'), 'with-skill', id)
    return { e, svc: await started(e) }
  }

  it('命中：设 blocked、live 为 false 并 commit；解除后清掉，开关没动过所以回到原来的开着', async () => {
    const { svc } = await storeEnv()
    const seen: boolean[] = []
    svc.onChange(() => seen.push(pack(svc, id).live))
    expect(pack(svc, id).live).toBe(true)
    await svc.applyBlocklist(listOf([{ id, versions: ['1.0.0'] }]))
    expect(pack(svc, id)).toMatchObject({ live: false, enabled: true, blocked: { reason: '含恶意代码' } })
    await svc.applyBlocklist(listOf([]))
    expect(pack(svc, id)).toMatchObject({ live: true, enabled: true })
    expect(pack(svc, id).blocked).toBeUndefined()
    expect(seen).toEqual([false, true])
  })

  it('版本对不上不命中；多站点：只看回执里 site 的那份，换站点后别的站点的空名单也不会放出它', async () => {
    const { svc } = await storeEnv()
    await svc.applyBlocklist(listOf([{ id, versions: ['9.9.9'] }]))
    expect(pack(svc, id).live).toBe(true)
    await svc.applyBlocklist(listOf([{ id, versions: '*' }], OTHER))
    expect(pack(svc, id).live).toBe(true)
    await svc.applyBlocklist({ version: 1, sites: { [SITE]: siteOf([{ id, versions: '*' }]), [OTHER]: siteOf([]) } })
    expect(pack(svc, id).blocked).toBeDefined()
    await svc.applyBlocklist({ version: 1, sites: { [SITE]: siteOf([{ id, versions: '*' }]) } })
    expect(pack(svc, id).blocked).toBeDefined()
  })

  it('命中后 setEnabled(key, true) 被拒（extpacks.blocked），state.json 里的 enabled 不变；关掉照常成功', async () => {
    const { e, svc } = await storeEnv()
    await svc.setEnabled(key, false)
    await svc.applyBlocklist(listOf([{ id, versions: '*' }]))
    await expect(svc.setEnabled(key, true)).rejects.toThrow('extpacks.blocked')
    expect(pack(svc, id).enabled).toBe(false)
    expect(readStateFile(stateFile(e)).store[id].enabled).toBe(false)
    await svc.applyBlocklist(listOf([]))
    await svc.setEnabled(key, true)
    expect(pack(svc, id).live).toBe(true)
    await svc.applyBlocklist(listOf([{ id, versions: '*' }]))
    await svc.setEnabled(key, false)
    expect(pack(svc, id)).toMatchObject({ enabled: false, live: false })
    expect(readStateFile(stateFile(e)).store[id].enabled).toBe(false)
  })

  it('被停用的商店版不挡同 id 的内置版：内置顶上，解除后商店版又盖过内置', async () => {
    const e = env(['pixelsky.dotenv'])
    installStoreFixture(join(e.dataDir, 'store'), 'pixelsky.dotenv', 'pixelsky.dotenv')
    const svc = await started(e)
    const builtin = (): ReturnType<typeof pack> => svc.state().packs.find(p => p.source === 'builtin')!
    expect(builtin().shadowedBy).toBe('store')
    await svc.applyBlocklist(listOf([{ id: 'pixelsky.dotenv', versions: '*' }]))
    expect(builtin().live).toBe(true)
    expect(builtin().shadowedBy).toBeUndefined()
    await svc.applyBlocklist(listOf([]))
    expect(builtin().shadowedBy).toBe('store')
  })

  it('文件夹扩展同 id 同版本命中：加一条 pack.storeBlocked 警告、live 不变；名单去掉后警告消失', async () => {
    const e = env()
    const svc = await started(e)
    const info = await svc.addFolder(copyFixture('with-skill', e.folders))
    const warnings = (): number => pack(svc, id).issues.filter(i => i.code === 'pack.storeBlocked').length
    await svc.applyBlocklist(listOf([{ id, versions: ['1.0.0'] }]))
    expect(warnings()).toBe(1)
    expect(pack(svc, id).live).toBe(info.live)
    expect(pack(svc, id).live).toBe(true)
    expect(pack(svc, id).blocked).toBeUndefined()
    await svc.applyBlocklist(listOf([{ id, versions: ['1.0.0'] }]))
    expect(warnings()).toBe(1)
    await svc.applyBlocklist(listOf([{ id, versions: ['2.0.0'] }]))
    expect(warnings()).toBe(0)
    expect(pack(svc, id).status).toBe(info.status)
  })
})
