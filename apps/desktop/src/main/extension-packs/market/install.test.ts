import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCodedError } from '@pixelsky/protocol'
import type { ExtPackInfo } from '@pixelsky/protocol'
import { cleanTemp, FIXTURES, installStoreFixture, tempDir } from '../testing'

vi.mock('electron', () => ({ app: { isPackaged: true }, net: { fetch: vi.fn() } }))
vi.mock('../../account/account', () => ({ baseUrl: () => 'http://127.0.0.1:9', extensionsFetch: vi.fn() }))

const { ExtensionPacks } = await import('../service')
const { StoreError } = await import('./api')
const { cleanStoreDir } = await import('./cleanup')
const { createInstaller, nodeFs } = await import('./install')
const { keyIdOf, keyStatus } = await import('./keys')
const { readStateFile, writeStateFile } = await import('../store')
const { signedText } = await import('./verify')
type Installer = ReturnType<typeof createInstaller>
type InstallerDeps = Parameters<typeof createInstaller>[0]
type StoreKey = NonNullable<NonNullable<InstallerDeps['keys']>['table']>[number]

afterEach(cleanTemp)

const SITE = 'https://cloud.test'
const ID = 'acme.dotenv'
const DEV = { packaged: true, value: undefined }
const APP_VERSION = '0.4.1-beta'

// ---------------------------------------------------------------------------
// 钥匙、zip、假云端
// ---------------------------------------------------------------------------

interface Pair {
  priv: KeyObject
  publicKey: string
  keyId: string
}
function pair(): Pair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64')
  return { priv: privateKey, publicKey: raw, keyId: keyIdOf(raw)! }
}

const enc = new TextEncoder()

/** 以 pixelsky.dotenv 为底板：改 id / 版本，可以改清单、加文件 */
interface Build {
  id?: string
  version?: string
  /** 清单文字（整个替换） */
  manifest?: (m: Record<string, unknown>) => Record<string, unknown> | string
  extra?: Record<string, string>
  /** 没有这些文件 */
  drop?: string[]
}
function zipOf(b: Build = {}): Buffer {
  const files: Record<string, Uint8Array> = {}
  const base = join(FIXTURES, 'pixelsky.dotenv')
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else files[relative(base, full).replace(/\\/g, '/')] = readFileSync(full)
    }
  }
  walk(base)
  const manifest = JSON.parse(readFileSync(join(base, 'pixelsky-extension.json'), 'utf8')) as Record<string, unknown>
  manifest.id = b.id ?? ID
  manifest.version = b.version ?? '1.0.0'
  const changed = b.manifest ? b.manifest(manifest) : manifest
  files['pixelsky-extension.json'] = enc.encode(typeof changed === 'string' ? changed : JSON.stringify(changed))
  for (const [path, text] of Object.entries(b.extra ?? {})) files[path] = enc.encode(text)
  for (const path of b.drop ?? []) delete files[path]
  return Buffer.from(zipSync(files))
}

interface Served {
  bytes: Buffer
  headers: Record<string, string>
  size: number
}

/** 假云端：按 id@version 回 zip 和三个响应头；每次下载都记一笔 */
class Cloud {
  readonly served = new Map<string, Served>()
  readonly downloads: string[] = []
  readonly detailCalls: Array<{ id: string; opts: unknown }> = []
  readonly installedCalls: string[] = []
  /** 下载前等这个 Promise（测并发、取消） */
  gate: Promise<void> | null = null
  detailGone = false

  constructor(readonly key: Pair = pair()) {}

  get table(): StoreKey[] {
    return [{ keyId: this.key.keyId, publicKey: this.key.publicKey, sites: [SITE], status: 'active' }]
  }

  /** 上架一个版本。signAs：签名用的 id / 版本（默认和 id/version 一样）；tamper：改响应头 */
  publish(
    id: string,
    version: string,
    build: Build = {},
    opts: { signAs?: [string, string]; key?: Pair; tamper?: (h: Record<string, string>) => void } = {},
  ): Served {
    const bytes = zipOf({ id, version, ...build })
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const key = opts.key ?? this.key
    const [sid, sver] = opts.signAs ?? [id, version]
    const signature = sign(null, signedText(sid, sver, sha256), key.priv).toString('base64')
    const headers = {
      'X-Pixelsky-Ext-Sha256': sha256,
      'X-Pixelsky-Ext-Signature': signature,
      'X-Pixelsky-Ext-Key-Id': key.keyId,
    }
    opts.tamper?.(headers)
    const served = { bytes, headers, size: bytes.length }
    this.served.set(`${id}@${version}`, served)
    return served
  }

  readonly api: InstallerDeps['api'] & { detail: ReturnType<typeof vi.fn> } = {
    detail: vi.fn(async (id: string, opts?: unknown) => {
      this.detailCalls.push({ id, opts })
      if (this.detailGone) throw new StoreError('x', 'not_found', 404, 'extstore.notFound')
      const versions = [...this.served.entries()]
        .filter(([k]) => k.startsWith(`${id}@`))
        .map(([k, s]) => ({
          version: k.slice(id.length + 1),
          publishedAt: null,
          size: s.size,
          sha256: s.headers['X-Pixelsky-Ext-Sha256'],
          signature: s.headers['X-Pixelsky-Ext-Signature'],
          keyId: s.headers['X-Pixelsky-Ext-Key-Id'],
          downloadUrl: '',
        }))
      if (!versions.length) throw new StoreError('x', 'not_found', 404, 'extstore.notFound')
      const latest = versions[versions.length - 1]
      return { extension: { id, version: latest.version }, latest, versions, manifest: null } as never
    }),
    installed: vi.fn(async (id: string) => {
      this.installedCalls.push(id)
    }),
  }

  readonly net: InstallerDeps['net'] = {
    downloadCapped: async (path, opts) => {
      const m = /^\/cloud\/extensions\/([^/]+)\/(.+)\.zip$/.exec(path)
      this.downloads.push(`${m?.[1]}@${m?.[2]}`)
      opts.onProgress?.(5, 10)
      if (this.gate) {
        const gate = this.gate
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => reject(parseThrown('extstore.cancelled'))
          if (opts.signal?.aborted) return abort()
          opts.signal?.addEventListener('abort', abort, { once: true })
          void gate.then(resolve)
        })
      }
      const s = this.served.get(`${m?.[1]}@${m?.[2]}`)
      if (!s) throw parseThrown('extstore.notFound')
      return { bytes: s.bytes, headers: new Headers(s.headers) }
    },
  }
}

function parseThrown(code: string): Error {
  return new Error(`PIXELSKY_ERR:${JSON.stringify({ code })}`)
}

async function codeOf(p: Promise<unknown>): Promise<{ code?: string; params?: Record<string, unknown> }> {
  try {
    await p
  } catch (e) {
    return (parseCodedError((e as Error).message) ?? { code: `raw:${(e as Error).message}` }) as never
  }
  throw new Error('expected rejection')
}

// ---------------------------------------------------------------------------
// 环境：真的 service + installer
// ---------------------------------------------------------------------------

interface Env {
  base: string
  dataDir: string
  builtinDir: string
  storeDir: string
}
function env(builtin: string[] = []): Env {
  const base = tempDir('install-')
  const builtinDir = join(base, 'builtin')
  mkdirSync(builtinDir)
  for (const name of builtin) {
    const dir = join(builtinDir, name === 'pixelsky.dotenv' ? name : name)
    mkdirSync(dir, { recursive: true })
    const src = join(FIXTURES, name)
    const copy = (from: string, to: string): void => {
      for (const e of readdirSync(from, { withFileTypes: true })) {
        if (e.isDirectory()) {
          mkdirSync(join(to, e.name), { recursive: true })
          copy(join(from, e.name), join(to, e.name))
        } else writeFileSync(join(to, e.name), readFileSync(join(from, e.name)))
      }
    }
    copy(src, dir)
  }
  const dataDir = join(base, 'data')
  return { base, dataDir, builtinDir, storeDir: join(dataDir, 'store') }
}

interface Rig {
  svc: InstanceType<typeof ExtensionPacks>
  installer: Installer
  cloud: Cloud
  /** 名单里被停用的版本（测试里直接改） */
  blockedVersions: Set<string>
  changes: Array<ExtPackInfo[]>
  progress: Array<{ phase: string; version: string; kind: string } | undefined>
}

async function rig(e: Env, cloud: Cloud = new Cloud(), over: Partial<InstallerDeps> = {}, start = true): Promise<Rig> {
  const svc = new ExtensionPacks({
    dataDir: e.dataDir,
    builtinDir: e.builtinDir,
    appVersion: APP_VERSION,
    keyStatus: (keyId, site) => keyStatus(keyId, site, cloud.table, DEV),
  })
  svc.start()
  if (start) await svc.ready()
  const changes: Rig['changes'] = []
  svc.onChange(() => changes.push(svc.state().packs))
  const blockedVersions = new Set<string>()
  const progress: Rig['progress'] = []
  const holder: { installer?: Installer } = {}
  const installer = createInstaller({
    host: {
      mutate: fn => svc.runExclusive(fn),
      replaceStorePack: (record, root) => svc.replaceStorePack(record, root),
      removeStorePack: id => svc.removeStorePack(id),
      storeInfo: id => svc.storeInfo(id),
      appVersion: APP_VERSION,
      storeDir: svc.storeDir,
      ready: () => svc.ready(),
      packs: () => svc.state().packs,
    },
    api: cloud.api,
    net: cloud.net,
    site: () => SITE,
    blocked: (_site, id, version) => (blockedVersions.has(`${id}@${version}`) ? { reason: '含恶意代码' } : null),
    keys: { table: cloud.table, dev: DEV },
    sleep: async () => undefined,
    log: () => undefined,
    onChange: () => progress.push(holder.installer?.installing()[ID]),
    ...over,
  })
  holder.installer = installer
  svc.attachStoreTasks({ cancel: id => installer.cancel(id) })
  return { svc, installer, cloud, blockedVersions, changes, progress }
}

const stateStore = (e: Env) => readStateFile(join(e.dataDir, 'state.json')).store
const idDir = (e: Env, id = ID): string => join(e.storeDir, id)
const tmpLeft = (e: Env): string[] =>
  existsSync(join(e.storeDir, '.tmp')) ? readdirSync(join(e.storeDir, '.tmp')) : []
const storePack = (r: Rig, id = ID): ExtPackInfo | undefined =>
  r.svc.state().packs.find(p => p.source === 'store' && p.id === id)

/** 拒装以后：错误代码对、store/<id>/ 没变化、.tmp 清空 */
async function expectRejected(r: Rig, e: Env, p: Promise<unknown>, code: string): Promise<Record<string, unknown>> {
  const before = existsSync(idDir(e)) ? readdirSync(idDir(e)).sort() : null
  const got = await codeOf(p)
  expect(got.code).toBe(code)
  expect(existsSync(idDir(e)) ? readdirSync(idDir(e)).sort() : null).toEqual(before)
  expect(tmpLeft(e)).toEqual([])
  return got.params ?? {}
}

// ---------------------------------------------------------------------------

describe('install：成功路径', () => {
  it('下载、验签、解压、换上：生效、写回执、报安装一次、进度按阶段推', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    const r = await rig(e, cloud)
    const info = await r.installer.install(ID, '1.0.0')
    expect(info).toMatchObject({ key: `s-${ID}`, source: 'store', live: true, store: { version: '1.0.0', site: SITE } })
    expect(storePack(r)?.live).toBe(true)
    const record = JSON.parse(readFileSync(join(idDir(e), 'install.json'), 'utf8'))
    const served = cloud.served.get(`${ID}@1.0.0`)!
    expect(record).toMatchObject({
      id: ID,
      version: '1.0.0',
      sha256: served.headers['X-Pixelsky-Ext-Sha256'],
      signature: served.headers['X-Pixelsky-Ext-Signature'],
      keyId: cloud.key.keyId,
      site: SITE,
      dir: served.headers['X-Pixelsky-Ext-Sha256'].slice(0, 16),
    })
    // 解压出的文件：白名单类型有、samples/ 没有；没有留下的临时目录和回执临时文件
    expect(existsSync(join(idDir(e), record.dir, 'syntaxes/dotenv.tmLanguage.json'))).toBe(true)
    expect(existsSync(join(idDir(e), record.dir, 'samples'))).toBe(false)
    expect(readdirSync(idDir(e)).sort()).toEqual([record.dir, 'install.json'].sort())
    expect(tmpLeft(e)).toEqual([])
    expect(stateStore(e)[ID]).toEqual({ enabled: true, options: {} })
    expect(cloud.installedCalls).toEqual([ID])
    // 进度：先下载、再校验、再安装；结束后进度表是空的
    const phases = r.progress.filter(Boolean).map(p => p!.phase)
    expect(phases[0]).toBe('downloading')
    expect([...new Set(phases)]).toEqual(['downloading', 'verifying', 'installing'])
    expect(r.progress.filter(Boolean).every(p => p!.version === '1.0.0' && p!.kind === 'install')).toBe(true)
    expect(r.installer.installing()).toEqual({})
    // 装好马上 commit 过：最后一次推的状态里就有它
    expect(r.changes[r.changes.length - 1].some(p => p.key === `s-${ID}`)).toBe(true)
  })

  it('启动清理（cleanStoreDir）没跑完之前不建 store/.tmp：下载可以先做，解压要等 host.ready', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    const r = await rig(e, cloud)
    const real = r.svc.ready.bind(r.svc)
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    r.svc.ready = () => gate.then(real)
    const done = r.installer.install(ID, '1.0.0')
    await vi.waitFor(() => expect(cloud.downloads).toEqual([`${ID}@1.0.0`])) // 下载没被挡
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(existsSync(join(e.storeDir, '.tmp'))).toBe(false)
    release()
    await expect(done).resolves.toMatchObject({ source: 'store', live: true })
    expect(tmpLeft(e)).toEqual([])
  })

  it('取详情用 fresh（cache:no-cache），第 2 步；下载走 /cloud/extensions/<id>/<version>.zip', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    const r = await rig(e, cloud)
    await r.installer.install(ID, '1.0.0')
    expect(cloud.detailCalls).toEqual([{ id: ID, opts: expect.objectContaining({ fresh: true }) }])
    expect(cloud.downloads).toEqual([`${ID}@1.0.0`])
  })

  it('非法的 id 或版本：不发请求', async () => {
    const e = env()
    const r = await rig(e)
    expect((await codeOf(r.installer.install('Bad Id', '1.0.0'))).code).toBe('extstore.badRequest')
    expect((await codeOf(r.installer.install(ID, '1.0'))).code).toBe('extstore.badRequest')
    expect(r.cloud.detailCalls).toEqual([])
  })

  it('新装成功后装好的扩展重启还在；同 id 内置版标 shadowedBy', async () => {
    const e = env(['pixelsky.dotenv'])
    const cloud = new Cloud()
    cloud.publish('pixelsky.dotenv', '1.0.0')
    const r = await rig(e, cloud)
    await r.installer.install('pixelsky.dotenv', '1.0.0')
    const [builtin, store] = r.svc.state().packs
    expect(store).toMatchObject({ source: 'store', live: true })
    expect(builtin).toMatchObject({ source: 'builtin', live: false, shadowedBy: 'store' })
    const again = await rig(e, cloud)
    expect(again.svc.state().packs.map(p => [p.source, p.live])).toEqual([
      ['builtin', false],
      ['store', true],
    ])
  })
})

describe('install：拒装（错误代码对、store/<id>/ 不变、.tmp 清空）', () => {
  it('签名对不上（响应头里的签名是用别的版本签的）', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0', {}, { signAs: [ID, '9.9.9'] })
    const r = await rig(e, cloud)
    await expectRejected(r, e, r.installer.install(ID, '1.0.0'), 'extstore.badSignature')
    expect(cloud.installedCalls).toEqual([])
  })

  it('钥匙不认识：unknownKey（站点钥匙表里没有）', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0', {}, { key: pair() })
    const r = await rig(e, cloud)
    await expectRejected(r, e, r.installer.install(ID, '1.0.0'), 'extstore.unknownKey')
  })

  it('清单的 id 和签名的不一致', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0', {
      manifest: m => ({ ...m, id: 'acme.other' }),
    })
    const r = await rig(e, cloud)
    await expectRejected(r, e, r.installer.install(ID, '1.0.0'), 'extstore.badSignature')
  })

  it('清单的版本和签名的不一致', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0', { manifest: m => ({ ...m, version: '1.0.1' }) })
    const r = await rig(e, cloud)
    await expectRejected(r, e, r.installer.install(ID, '1.0.0'), 'extstore.badSignature')
  })

  it('版本要求不满足：engineUnmet，带 {version}', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0', { manifest: m => ({ ...m, engines: { pixelsky: '>=9.0.0' } }) })
    const r = await rig(e, cloud)
    const params = await expectRejected(r, e, r.installer.install(ID, '1.0.0'), 'extstore.engineUnmet')
    expect(params).toEqual({ version: '9.0.0' })
  })

  it('有 files.* 问题（隐藏文件）：badFiles，即使 status 不是 error', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0', { extra: { '.x.json': '{}' } })
    const r = await rig(e, cloud)
    const params = await expectRejected(r, e, r.installer.install(ID, '1.0.0'), 'extstore.badFiles')
    expect(params.files).toBe('.x.json')
  })

  it('文件名危险：含 : 的被 zip 读取层挡成 packErrors，保留名（CON.json）是 files.path → badFiles；整包拒绝、不留文件', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0', { extra: { 'a:b.json': '{}' } })
    cloud.publish(ID, '1.0.1', { extra: { 'CON.json': '{}' } })
    const r = await rig(e, cloud)
    await expectRejected(r, e, r.installer.install(ID, '1.0.0'), 'extstore.packErrors')
    const params = await expectRejected(r, e, r.installer.install(ID, '1.0.1'), 'extstore.badFiles')
    expect(params.files).toBe('CON.json')
    expect(existsSync(idDir(e))).toBe(false)
  })

  it('status 是 error：packErrors，参数只带前 3 条', async () => {
    const e = env()
    const cloud = new Cloud()
    // 一个坏文件名（zip.entryName，让 status 变成 error）加上清单里 3 条指向不存在文件的贡献：一共 4 条错误，只列前 3 条
    const snippets = [1, 2, 3].map(n => ({ language: 'dotenv', path: `snippets/missing${n}.json` }))
    cloud.publish(ID, '1.0.0', {
      extra: { 'a:b.json': '{}' },
      manifest: m => ({ ...m, contributes: { snippets } }),
    })
    const r = await rig(e, cloud)
    const params = await expectRejected(r, e, r.installer.install(ID, '1.0.0'), 'extstore.packErrors')
    expect(String(params.issues).split('；')).toHaveLength(3)
  })

  it('停用名单里有这个版本：versionBlocked，不发请求', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    const r = await rig(e, cloud)
    r.blockedVersions.add(`${ID}@1.0.0`)
    const params = await expectRejected(r, e, r.installer.install(ID, '1.0.0'), 'extstore.versionBlocked')
    expect(params).toEqual({ reason: '含恶意代码' })
    expect(cloud.detailCalls).toEqual([])
  })

  it('比本机低又不是换回：downgrade；换回可以', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    cloud.publish(ID, '1.1.0')
    const r = await rig(e, cloud)
    await r.installer.install(ID, '1.1.0')
    expect(cloud.downloads).toEqual([`${ID}@1.1.0`])
    await expectRejected(r, e, r.installer.install(ID, '1.0.0'), 'extstore.downgrade')
    expect(cloud.downloads).toEqual([`${ID}@1.1.0`])
    const info = await r.installer.install(ID, '1.0.0', { rollback: true })
    expect(info.store?.version).toBe('1.0.0')
    expect(storePack(r)?.store?.version).toBe('1.0.0')
  })

  it('详情里没有这个版本：notFound', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    const r = await rig(e, cloud)
    await expectRejected(r, e, r.installer.install(ID, '2.0.0'), 'extstore.notFound')
  })
})

describe('install：下架后详情 404（只靠响应头验）', () => {
  it('照样装上', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    cloud.detailGone = true
    const r = await rig(e, cloud)
    expect((await r.installer.install(ID, '1.0.0')).live).toBe(true)
  })

  it('响应头的 sha256 改掉一位：拒绝', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(
      ID,
      '1.0.0',
      {},
      {
        tamper: h => {
          const sha = h['X-Pixelsky-Ext-Sha256']
          h['X-Pixelsky-Ext-Sha256'] = (sha[0] === '0' ? '1' : '0') + sha.slice(1)
        },
      },
    )
    cloud.detailGone = true
    const r = await rig(e, cloud)
    await expectRejected(r, e, r.installer.install(ID, '1.0.0'), 'extstore.badSignature')
  })
})

describe('install：更新、换回、继承', () => {
  it('更新和换回保留开关和选项', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    cloud.publish(ID, '1.1.0')
    const r = await rig(e, cloud)
    await r.installer.install(ID, '1.0.0')
    await r.svc.setEnabled(`s-${ID}`, false)
    await r.svc.setOptions(`s-${ID}`, { overrideBuiltin: ['dotenv'] })
    const updated = await r.installer.install(ID, '1.1.0')
    expect(updated).toMatchObject({ enabled: false, live: false, options: { overrideBuiltin: ['dotenv'] } })
    expect(updated.store?.version).toBe('1.1.0')
    // 更新不再报安装
    expect(cloud.installedCalls).toEqual([ID])
    const back = await r.installer.install(ID, '1.0.0', { rollback: true })
    expect(back).toMatchObject({ enabled: false, options: { overrideBuiltin: ['dotenv'] } })
    expect(stateStore(e)[ID]).toEqual({ enabled: false, options: { overrideBuiltin: ['dotenv'] } })
    // 旧版本目录留到下次启动清理：现在有两个版本目录
    // （换回的 1.0.0 目录原来就在，先被改名成 .old-*）
    expect(readdirSync(idDir(e)).filter(n => n !== 'install.json').length).toBeGreaterThanOrEqual(2)
    const again = await rig(e, cloud)
    expect(readdirSync(idDir(e)).filter(n => n !== 'install.json')).toHaveLength(1)
    expect(again.svc.state().packs[0].store?.version).toBe('1.0.0')
  })

  it('第一次装商店版继承内置版的开关和选项：关掉的装上后仍是关的，谁也不标替代', async () => {
    const e = env(['pixelsky.dotenv'])
    mkdirSync(e.dataDir, { recursive: true })
    writeStateFile(join(e.dataDir, 'state.json'), {
      version: 1,
      folders: [],
      builtin: { 'pixelsky.dotenv': { enabled: false, options: { overrideBuiltin: ['x'] } } },
      store: {},
    })
    const cloud = new Cloud()
    cloud.publish('pixelsky.dotenv', '1.0.0')
    cloud.publish('pixelsky.dotenv', '1.1.0')
    const r = await rig(e, cloud)
    const info = await r.installer.install('pixelsky.dotenv', '1.0.0')
    expect(stateStore(e)['pixelsky.dotenv']).toEqual({ enabled: false, options: { overrideBuiltin: ['x'] } })
    expect(info).toMatchObject({ enabled: false, live: false, options: { overrideBuiltin: ['x'] } })
    const [builtin, store] = r.svc.state().packs
    expect([builtin.live, store.live]).toEqual([false, false])
    expect(builtin.shadowedBy).toBeUndefined()
    expect(store.shadowedBy).toBeUndefined()
    // 已有 store[id] 时不再从内置抄：打开商店版、更新，仍是打开的
    await r.svc.setEnabled('s-pixelsky.dotenv', true)
    expect((await r.installer.install('pixelsky.dotenv', '1.1.0')).enabled).toBe(true)
    expect(stateStore(e)['pixelsky.dotenv'].enabled).toBe(true)
  })

  it('目标目录已存在（同一个包重装）：先改名挪开再换上', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    const r = await rig(e, cloud)
    await r.installer.install(ID, '1.0.0')
    const info = await r.installer.install(ID, '1.0.0')
    expect(info.live).toBe(true)
    const names = readdirSync(idDir(e))
    expect(names.some(n => n.includes('.old-'))).toBe(true)
    await rig(e, cloud) // 重启清理掉 .old-*
    expect(readdirSync(idDir(e)).sort()).toHaveLength(2)
  })

  it('目录改名遇到 EBUSY：退避重试后成功', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    let busy = 2
    const sleeps: number[] = []
    const r = await rig(e, cloud, {
      fs: {
        ...nodeFs,
        rename: async (from, to) => {
          if (from.includes('.tmp') && busy-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
          return nodeFs.rename(from, to)
        },
      },
      sleep: async ms => void sleeps.push(ms),
    })
    expect((await r.installer.install(ID, '1.0.0')).live).toBe(true)
    expect(sleeps).toEqual([50, 100])
  })

  it('目录改名一直 EBUSY：失败，旧版本照常用、不留半个包', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    cloud.publish(ID, '1.1.0')
    let always = false
    const sleeps: number[] = []
    const r = await rig(e, cloud, {
      fs: {
        ...nodeFs,
        rename: async (from, to) => {
          if (always && from.includes('.tmp')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
          return nodeFs.rename(from, to)
        },
      },
      sleep: async ms => void sleeps.push(ms),
    })
    await r.installer.install(ID, '1.0.0')
    always = true
    expect((await codeOf(r.installer.install(ID, '1.1.0'))).code).toMatch(/raw:busy/)
    expect(sleeps).toEqual([50, 100, 200, 400])
    expect(storePack(r)?.store?.version).toBe('1.0.0')
    expect(JSON.parse(readFileSync(join(idDir(e), 'install.json'), 'utf8')).version).toBe('1.0.0')
    expect(tmpLeft(e)).toEqual([])
  })
})

describe('install：并发和取消', () => {
  it('同 id 同版本连点两次：同一个 Promise，只下载 1 次，installed 只报 1 次', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    let open!: () => void
    cloud.gate = new Promise<void>(resolve => (open = resolve))
    const r = await rig(e, cloud)
    const a = r.installer.install(ID, '1.0.0')
    const b = r.installer.install(ID, '1.0.0')
    expect(b).toBe(a)
    open()
    await a
    expect(cloud.downloads).toEqual([`${ID}@1.0.0`])
    expect(cloud.installedCalls).toEqual([ID])
    expect(cloud.detailCalls).toHaveLength(1)
  })

  it('同一个 id 正在装时点别的版本或换回：回「正在安装」；不同 id 可以同时装', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    cloud.publish(ID, '1.1.0')
    cloud.publish('acme.other', '1.0.0', { manifest: m => ({ ...m, name: 'Other' }) })
    let open!: () => void
    cloud.gate = new Promise<void>(resolve => (open = resolve))
    const r = await rig(e, cloud)
    const a = r.installer.install(ID, '1.0.0')
    expect((await codeOf(r.installer.install(ID, '1.1.0'))).code).toBe('extstore.installing')
    // 同版本（不管是不是换回）复用同一个任务
    expect(r.installer.install(ID, '1.0.0')).toBe(a)
    const other = r.installer.install('acme.other', '1.0.0')
    open()
    await Promise.all([a, other])
    expect(
      r.svc
        .state()
        .packs.filter(p => p.source === 'store')
        .map(p => p.id),
    ).toEqual([ID, 'acme.other'])
  })

  it('取消：下载中止，回 cancelled，什么都不留；任务表清空后可以重新装', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    cloud.gate = new Promise<void>(() => undefined)
    const r = await rig(e, cloud)
    const p = r.installer.install(ID, '1.0.0')
    const got = codeOf(p)
    await vi.waitFor(() => expect(cloud.downloads).toHaveLength(1))
    await r.installer.cancel(ID)
    expect((await got).code).toBe('extstore.cancelled')
    expect(existsSync(idDir(e))).toBe(false)
    expect(r.installer.installing()).toEqual({})
    cloud.gate = null
    expect((await r.installer.install(ID, '1.0.0')).live).toBe(true)
  })

  it('取消一个没有任务的 id：什么都不做', async () => {
    const r = await rig(env())
    await expect(r.installer.cancel(ID)).resolves.toBeUndefined()
  })

  it('卸载会取消进行中的下载，取消后不会被换上回来', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    cloud.publish(ID, '1.1.0')
    const r = await rig(e, cloud)
    await r.installer.install(ID, '1.0.0')
    cloud.gate = new Promise<void>(() => undefined)
    const update = r.installer.install(ID, '1.1.0')
    const got = codeOf(update)
    await vi.waitFor(() => expect(cloud.downloads).toHaveLength(2))
    await r.svc.remove(`s-${ID}`)
    expect((await got).code).toBe('extstore.cancelled')
    expect(storePack(r)).toBeUndefined()
    expect(existsSync(idDir(e))).toBe(false)
    expect(stateStore(e)[ID]).toBeUndefined()
  })

  it('已经排队等「换上」时被取消：不会换上', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    const r = await rig(e, cloud)
    let release!: () => void
    const hold = r.svc.runExclusive(() => new Promise<void>(resolve => (release = resolve)))
    const p = r.installer.install(ID, '1.0.0')
    const got = codeOf(p)
    await vi.waitFor(() => expect(tmpLeft(e)).toHaveLength(1)) // 解压完，等着换上
    const cancelled = r.installer.cancel(ID)
    release()
    await hold
    await cancelled
    expect((await got).code).toBe('extstore.cancelled')
    expect(existsSync(idDir(e))).toBe(false)
    expect(tmpLeft(e)).toEqual([])
    expect(storePack(r)).toBeUndefined()
  })

  it('下载期间名单更新：换上前拒绝', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    let open!: () => void
    cloud.gate = new Promise<void>(resolve => (open = resolve))
    const r = await rig(e, cloud)
    const p = r.installer.install(ID, '1.0.0')
    const got = codeOf(p)
    await vi.waitFor(() => expect(cloud.downloads).toHaveLength(1))
    r.blockedVersions.add(`${ID}@1.0.0`)
    open()
    expect((await got).code).toBe('extstore.versionBlocked')
    expect(existsSync(idDir(e))).toBe(false)
    expect(tmpLeft(e)).toEqual([])
  })

  it('换上前钥匙被作废：拒绝', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    const table = cloud.table
    let revoked = false
    const r = await rig(e, cloud, {
      keys: {
        get table() {
          return revoked ? table.map(k => ({ ...k, status: 'revoked' as const })) : table
        },
        dev: DEV,
      } as never,
      net: {
        downloadCapped: async (path, opts) => {
          const got = await cloud.net.downloadCapped(path, opts)
          revoked = false
          return got
        },
      },
    })
    // 下载时钥匙还在用，验签通过；换上前（swapIn）再查一遍：把表改成作废
    const spy = vi.spyOn(r.svc, 'runExclusive').mockImplementation(fn => {
      revoked = true
      return fn()
    })
    expect((await codeOf(r.installer.install(ID, '1.0.0'))).code).toBe('extstore.revokedKey')
    spy.mockRestore()
    expect(existsSync(idDir(e))).toBe(false)
  })

  it('silent 安装：不推进度，失败只写日志（仍 reject）', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    const logs: string[] = []
    const r = await rig(e, cloud, { log: m => logs.push(m) })
    await r.installer.install(ID, '1.0.0', { silent: true })
    expect(r.progress).toEqual([])
    expect((await codeOf(r.installer.install(ID, '2.0.0', { silent: true }))).code).toBe('extstore.notFound')
    expect(logs.join('\n')).toContain('silent install')
    expect(r.progress).toEqual([])
  })
})

describe('install：断电恢复（启动清理 + loadStore 以后状态一致）', () => {
  /** 到了指定的那一步“进程死了”：之后所有文件操作都抛错（连善后也做不了），所以磁盘停在那一刻的样子 */
  type Point = 'mkdir' | 'park' | 'rename-dir' | 'write-json' | 'rename-json'
  function crashing(point: Point): InstallerDeps['fs'] {
    let dead = false
    const alive = (): void => {
      if (dead) throw new Error('power cut')
    }
    const cut = (): never => {
      dead = true
      throw new Error('power cut')
    }
    return {
      mkdir: async path => {
        alive()
        if (point === 'mkdir') cut()
        return nodeFs.mkdir(path)
      },
      rename: async (from, to) => {
        alive()
        if (point === 'park' && to.includes('.old-')) {
          await nodeFs.rename(from, to)
          cut()
        }
        if (point === 'rename-dir' && from.includes('.tmp') && !from.includes('install.json')) {
          await nodeFs.rename(from, to)
          cut()
        }
        if (point === 'rename-json' && from.includes('install.json.tmp')) cut()
        return nodeFs.rename(from, to)
      },
      writeFile: async (path, data) => {
        alive()
        if (point === 'write-json') cut()
        return nodeFs.writeFile(path, data)
      },
      rm: async path => {
        alive()
        return nodeFs.rm(path)
      },
      exists: nodeFs.exists,
    }
  }

  const POINTS: Point[] = ['mkdir', 'rename-dir', 'write-json', 'rename-json']

  for (const hasOld of [false, true]) {
    for (const point of POINTS) {
      it(`${hasOld ? '更新' : '新装'}时在「${point}」断电：重启后不留半个包${hasOld ? '，旧版本照常用' : ''}`, async () => {
        const e = env()
        const cloud = new Cloud()
        cloud.publish(ID, '1.0.0')
        cloud.publish(ID, '1.1.0')
        if (hasOld) await (await rig(e, cloud)).installer.install(ID, '1.0.0')
        const r = await rig(e, cloud, { fs: crashing(point) })
        await r.installer.install(ID, hasOld ? '1.1.0' : '1.0.0').catch(() => undefined)
        // 这一刻起进程“死了”：重启（重新跑 cleanStoreDir + loadStore）后要一致
        const after = await rig(e, cloud)
        expect(tmpLeft(e)).toEqual([])
        const pack = storePack(after)
        if (hasOld) {
          expect(pack).toMatchObject({ live: true, store: { version: '1.0.0' } })
          const record = JSON.parse(readFileSync(join(idDir(e), 'install.json'), 'utf8'))
          expect(record.version).toBe('1.0.0')
          expect(readdirSync(idDir(e)).sort()).toEqual([record.dir, 'install.json'].sort())
        } else {
          expect(pack).toBeUndefined()
          expect(existsSync(idDir(e))).toBe(false)
        }
      })
    }
  }

  it('同一个包重装、旧目录刚挪开（.old-*）时断电：重启后改回来，已装的版本还在', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    await (await rig(e, cloud)).installer.install(ID, '1.0.0')
    const r = await rig(e, cloud, { fs: crashing('park') })
    await r.installer.install(ID, '1.0.0').catch(() => undefined)
    expect(readdirSync(idDir(e)).some(n => n.includes('.old-'))).toBe(true)
    const after = await rig(e, cloud)
    expect(storePack(after)).toMatchObject({ live: true, store: { version: '1.0.0' } })
    expect(readdirSync(idDir(e))).toHaveLength(2)
    expect(tmpLeft(e)).toEqual([])
  })

  it('回执写好、service 还没换内存时断电：重启后是新版本', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish(ID, '1.0.0')
    cloud.publish(ID, '1.1.0')
    await (await rig(e, cloud)).installer.install(ID, '1.0.0')
    const r = await rig(e, cloud)
    vi.spyOn(r.svc, 'replaceStorePack').mockRejectedValue(new Error('power cut'))
    await r.installer.install(ID, '1.1.0').catch(() => undefined)
    const after = await rig(e, cloud)
    expect(storePack(after)?.store?.version).toBe('1.1.0')
    expect(readdirSync(idDir(e)).filter(n => n !== 'install.json')).toHaveLength(1)
    expect(tmpLeft(e)).toEqual([])
  })
})

describe('cleanStoreDir', () => {
  const ok = (e: Env, id = ID): void => {
    installStoreFixture(e.storeDir, 'pixelsky.dotenv', id)
  }

  it('清空 .tmp；没有 install.json 或回执坏了的目录整个删；多余的版本目录、.old-*、回执临时文件删掉', async () => {
    const e = env()
    ok(e)
    mkdirSync(join(e.storeDir, '.tmp', 'abc'), { recursive: true })
    mkdirSync(join(e.storeDir, 'acme.nojson', 'aaaaaaaaaaaaaaaa'), { recursive: true })
    mkdirSync(join(e.storeDir, 'acme.badjson'), { recursive: true })
    writeFileSync(join(e.storeDir, 'acme.badjson', 'install.json'), '{oops')
    mkdirSync(join(e.storeDir, ID, 'bbbbbbbbbbbbbbbb'))
    mkdirSync(join(e.storeDir, ID, 'aaaaaaaaaaaaaaaa.old-x1'))
    writeFileSync(join(e.storeDir, ID, 'install.json.tmp-1'), '{}')
    await cleanStoreDir(e.storeDir)
    expect(readdirSync(e.storeDir).sort()).toEqual([ID])
    expect(readdirSync(join(e.storeDir, ID)).sort()).toEqual(['aaaaaaaaaaaaaaaa', 'install.json'])
  })

  it('回执指向的目录不在、但有 <dir>.old-*（重装时挪开旧目录后断电）：改回来', async () => {
    const e = env()
    ok(e)
    const dir = join(e.storeDir, ID)
    await nodeFs.rename(join(dir, 'aaaaaaaaaaaaaaaa'), join(dir, 'aaaaaaaaaaaaaaaa.old-x1'))
    await cleanStoreDir(e.storeDir)
    expect(readdirSync(dir).sort()).toEqual(['aaaaaaaaaaaaaaaa', 'install.json'])
  })

  it('回执指向的目录不在、也没有备份：整个目录删掉', async () => {
    const e = env()
    ok(e)
    await nodeFs.rm(join(e.storeDir, ID, 'aaaaaaaaaaaaaaaa'))
    await cleanStoreDir(e.storeDir)
    expect(existsSync(join(e.storeDir, ID))).toBe(false)
  })

  it('删不掉的（被占用）跳过、写一行日志，不抛错，别的照删', async () => {
    const e = env()
    ok(e)
    mkdirSync(join(e.storeDir, ID, 'bbbbbbbbbbbbbbbb'))
    mkdirSync(join(e.storeDir, '.tmp', 'x'), { recursive: true })
    const logs: string[] = []
    const { rm } = await import('node:fs/promises')
    await cleanStoreDir(
      e.storeDir,
      m => logs.push(m),
      async (path, opts) => {
        if (path.endsWith('bbbbbbbbbbbbbbbb')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        await rm(path, opts)
      },
    )
    expect(logs.some(l => l.includes('bbbbbbbbbbbbbbbb'))).toBe(true)
    expect(existsSync(join(e.storeDir, '.tmp'))).toBe(false)
    expect(existsSync(join(e.storeDir, ID, 'bbbbbbbbbbbbbbbb'))).toBe(true)
  })

  it('store 目录不存在：什么都不做', async () => {
    await expect(cleanStoreDir(join(env().base, 'nope'))).resolves.toBeUndefined()
  })
})

describe('bootstrap：BOOTSTRAP_PACKS', () => {
  it('默认空列表：不发任何请求，host.ready 和 host.packs 都没被调', async () => {
    const e = env()
    const cloud = new Cloud()
    const calls: string[] = []
    const installer = createInstaller({
      host: {
        mutate: fn => fn(),
        replaceStorePack: vi.fn(),
        removeStorePack: vi.fn(),
        storeInfo: () => null,
        appVersion: APP_VERSION,
        storeDir: e.storeDir,
        ready: async () => void calls.push('ready'),
        packs: () => {
          calls.push('packs')
          return []
        },
      },
      api: cloud.api,
      net: cloud.net,
      site: () => SITE,
      blocked: () => null,
    })
    await installer.bootstrap()
    expect(calls).toEqual([])
    expect(cloud.api.detail).not.toHaveBeenCalled()
  })

  function bootstrapRig(packs: Partial<ExtPackInfo>[], ready: Promise<void>) {
    const e = env()
    const cloud = new Cloud()
    cloud.publish('acme.aa', '1.0.0')
    const order: string[] = []
    const detail = cloud.api.detail
    cloud.api.detail = vi.fn(async (id: string, opts?: { fresh?: boolean; signal?: AbortSignal }) => {
      order.push(`detail:${id}`)
      return detail(id, opts)
    })
    const installer = createInstaller({
      host: {
        mutate: fn => fn(),
        replaceStorePack: vi.fn(async () => ({ live: true }) as ExtPackInfo),
        removeStorePack: vi.fn(),
        storeInfo: () => null,
        appVersion: APP_VERSION,
        storeDir: e.storeDir,
        ready: async () => {
          order.push('ready')
          await ready
        },
        packs: () => {
          order.push('packs')
          return packs as ExtPackInfo[]
        },
      },
      api: cloud.api,
      net: cloud.net,
      site: () => SITE,
      blocked: () => null,
      keys: { table: cloud.table, dev: DEV },
      bootstrapPacks: ['acme.aa', 'acme.bb'],
      log: () => undefined,
    })
    return { installer, order, cloud }
  }

  it('等 ready 才取列表、取详情；ready 没好之前 api.detail 是 0 次', async () => {
    let open!: () => void
    const { installer, order, cloud } = bootstrapRig([], new Promise<void>(resolve => (open = resolve)))
    const done = installer.bootstrap()
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['ready'])
    expect(cloud.api.detail).not.toHaveBeenCalled()
    open()
    await done
    expect(order.slice(0, 3)).toEqual(['ready', 'packs', 'detail:acme.aa'])
  })

  it('本机没有商店版的才装：商店版已装的跳过；内置版不算；一个失败不影响下一个', async () => {
    const { installer, cloud } = bootstrapRig(
      [
        { id: 'acme.bb', source: 'store' },
        { id: 'acme.aa', source: 'builtin' },
      ],
      Promise.resolve(),
    )
    await installer.bootstrap()
    // acme.aa 只有内置版 → 仍要装（取版本号一次、安装前取详情一次，下载一次）；acme.bb 已有商店版 → 跳过
    expect(cloud.detailCalls.map(c => c.id)).toEqual(['acme.aa', 'acme.aa'])
    expect(cloud.downloads).toEqual(['acme.aa@1.0.0'])
  })

  it('失败只写日志、不抛，继续下一个', async () => {
    const e = env()
    const cloud = new Cloud()
    cloud.publish('acme.bb', '1.0.0', { manifest: m => ({ ...m, name: 'B' }) })
    const logs: string[] = []
    const r = await rig(e, cloud, { bootstrapPacks: ['acme.aa', 'acme.bb'], log: m => logs.push(m) })
    await expect(r.installer.bootstrap()).resolves.toBeUndefined()
    expect(logs.some(l => l.includes('bootstrap acme.aa failed'))).toBe(true)
    expect(storePack(r, 'acme.bb')?.live).toBe(true)
    expect(r.progress).toEqual([]) // 静默：不推进度
  })
})
