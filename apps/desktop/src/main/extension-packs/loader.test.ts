import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPack, packKey } from './loader'
import { cleanTemp, copyFixture, tempDir } from './testing'

afterEach(cleanTemp)

const input = (root: string, over: Partial<Parameters<typeof loadPack>[0]> = {}): Parameters<typeof loadPack>[0] => ({
  key: 'f-test',
  root,
  source: 'folder',
  enabled: true,
  addedAt: 1,
  options: {},
  revision: 1,
  appVersion: '0.4.1-beta',
  ...over,
})

function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path)
    return true
  } catch {
    return false // Windows 没有权限时跳过
  }
}

describe('packKey', () => {
  it('内置用 b-<id>，文件夹用 f- 加 12 位十六进制，都是合法主机名', () => {
    expect(packKey('builtin', 'pixelsky.material-icons')).toBe('b-pixelsky.material-icons')
    const key = packKey('folder', '/home/u/ext')
    expect(key).toMatch(/^f-[0-9a-f]{12}$/)
    expect(packKey('folder', '/home/u/ext')).toBe(key)
    expect(packKey('folder', '/home/u/ext/')).toBe(key)
  })

  it('路径大小写：Linux 区分，win32 / darwin 不区分', () => {
    expect(packKey('folder', '/Home/Ext', 'linux')).not.toBe(packKey('folder', '/home/ext', 'linux'))
    expect(packKey('folder', 'D:\\Ext\\A', 'win32')).toBe(packKey('folder', 'd:\\ext\\a', 'win32'))
    expect(packKey('folder', 'D:/Ext/A', 'win32')).toBe(packKey('folder', 'd:\\ext\\a\\', 'win32'))
    expect(packKey('folder', '/Users/Ext', 'darwin')).toBe(packKey('folder', '/users/ext', 'darwin'))
  })
})

describe('loadPack', () => {
  it('加载示例扩展：有 id、文件表和清单，不是 error', async () => {
    const dir = tempDir()
    const root = copyFixture('pixelsky.dotenv', dir)
    const pack = await loadPack(input(root))
    expect(pack.info.id).toBe('pixelsky.dotenv')
    expect(pack.info.status).not.toBe('error')
    expect(pack.info.live).toBe(true)
    expect(pack.info.manifest?.contributes.grammars).toHaveLength(1)
    expect(pack.files.has('syntaxes/dotenv.tmLanguage.json')).toBe(true)
    expect(pack.info.revision).toBe(1)
  })

  it('跳过 .git / node_modules / .gitignore / .vscode，不报 files.hidden', async () => {
    const root = copyFixture('pixelsky.dotenv', tempDir())
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'node_modules'))
    mkdirSync(join(root, '.vscode'))
    writeFileSync(join(root, '.git', 'config'), 'x')
    writeFileSync(join(root, 'node_modules', 'm.js'), 'x')
    writeFileSync(join(root, '.vscode', 'settings.json'), '{}')
    writeFileSync(join(root, '.gitignore'), 'node_modules')
    const pack = await loadPack(input(root))
    expect(pack.files.has('.git/config')).toBe(false)
    expect(pack.files.has('.gitignore')).toBe(false)
    expect(pack.files.has('.vscode/settings.json')).toBe(false)
    expect(pack.info.issues.some(i => i.code === 'files.hidden')).toBe(false)
  })

  it('停用的扩展照样校验，但 live 为 false', async () => {
    const root = copyFixture('pixelsky.dotenv', tempDir())
    const pack = await loadPack(input(root, { enabled: false }))
    expect(pack.info.enabled).toBe(false)
    expect(pack.info.live).toBe(false)
    expect(pack.info.id).toBe('pixelsky.dotenv')
  })

  it('没有清单：pack 级错误 manifest.missing', async () => {
    const pack = await loadPack(input(tempDir()))
    expect(pack.info.status).toBe('error')
    expect(pack.info.live).toBe(false)
    expect(pack.info.manifest).toBeNull()
    expect(pack.info.issues.map(i => i.code)).toContain('manifest.missing')
    expect(pack.info.issues[0].scope).toBe('pack')
  })

  it('清单不是 JSON：pack 级错误 manifest.parse', async () => {
    const root = copyFixture('bad-manifest', tempDir())
    const pack = await loadPack(input(root))
    expect(pack.info.status).toBe('error')
    expect(pack.info.issues.map(i => i.code)).toContain('manifest.parse')
  })

  it('清单带注释：照常加载并给 manifest.jsonc 警告', async () => {
    const root = copyFixture('with-tasks', tempDir())
    const file = join(root, 'pixelsky-extension.json')
    writeFileSync(file, '// 注释\n' + (await import('node:fs')).readFileSync(file, 'utf8'))
    const pack = await loadPack(input(root))
    expect(pack.info.id).toBe('pixelsky.with-tasks')
    expect(pack.info.issues.map(i => i.code)).toContain('manifest.jsonc')
    expect(pack.info.status).not.toBe('error')
  })

  it('内置扩展只保留 error 级问题', async () => {
    const root = copyFixture('with-tasks', tempDir())
    const file = join(root, 'pixelsky-extension.json')
    writeFileSync(file, '// 注释\n' + (await import('node:fs')).readFileSync(file, 'utf8'))
    const pack = await loadPack(input(root, { source: 'builtin', key: 'b-x' }))
    expect(pack.info.issues.every(i => i.severity === 'error')).toBe(true)
  })

  it('内置扩展随安装包发布，不查版本；文件夹扩展版本不够不加载', async () => {
    const root = copyFixture('with-tasks', tempDir())
    const file = join(root, 'pixelsky-extension.json')
    const { readFileSync: read } = await import('node:fs')
    const manifest = JSON.parse(read(file, 'utf8')) as { engines: { pixelsky: string } }
    manifest.engines.pixelsky = '>=99.0.0'
    writeFileSync(file, JSON.stringify(manifest))
    const builtin = await loadPack(input(root, { source: 'builtin', key: 'b-x' }))
    expect(builtin.info.live).toBe(true)
    const folder = await loadPack(input(root))
    expect(folder.info.issues.map(i => i.code)).toContain('manifest.engineUnmet')
    expect(folder.info.live).toBe(false)
  })

  it('符号链接：不进文件表，记 files.symlink（error / file）', async () => {
    const dir = tempDir()
    const root = copyFixture('pixelsky.dotenv', dir)
    writeFileSync(join(dir, 'secret.json'), '{}')
    if (!trySymlink(join(dir, 'secret.json'), join(root, 'link.json'))) return
    const pack = await loadPack(input(root))
    expect(pack.files.has('link.json')).toBe(false)
    const issue = pack.info.issues.find(i => i.code === 'files.symlink')
    expect(issue).toMatchObject({ severity: 'error', scope: 'file', path: 'link.json' })
  })

  it('超过扫描上限：pack 级错误 files.scanLimit', async () => {
    const root = copyFixture('with-tasks', tempDir())
    // 扫描上限是 5000 个文件，造 5001 个小文件
    mkdirSync(join(root, 'many'))
    for (let i = 0; i < 5001; i++) writeFileSync(join(root, 'many', `${i}.txt`), '')
    const pack = await loadPack(input(root))
    expect(pack.info.status).toBe('error')
    expect(pack.info.issues.map(i => i.code)).toContain('files.scanLimit')
  }, 30_000)

  it('folder 扩展里不安全的 svg：记 svg.unsafe（error / file），安全的不记', async () => {
    const root = copyFixture('unsafe-svg', tempDir())
    const pack = await loadPack(input(root))
    const bad = pack.info.issues.filter(i => i.code === 'svg.unsafe')
    expect(bad.map(i => i.path)).toEqual(['icons/bad.svg'])
    expect(bad[0]).toMatchObject({ severity: 'error', scope: 'file' })
  })

  it('内置扩展不扫 svg 内容', async () => {
    const root = copyFixture('unsafe-svg', tempDir())
    const pack = await loadPack(input(root, { source: 'builtin', key: 'b-x' }))
    expect(pack.info.issues.some(i => i.code === 'svg.unsafe')).toBe(false)
  })

  it('技能信息：每个技能读 SKILL.md 的 name / description，引擎默认两个都用', async () => {
    const root = copyFixture('with-skill', tempDir())
    const pack = await loadPack(input(root))
    expect(pack.info.skills).toEqual([
      { name: 'hello', description: 'Say hello', engines: ['claude', 'codex'], index: 0 },
      { name: 'hola', description: 'Say hola', engines: ['codex'], index: 1 },
    ])
  })
})
