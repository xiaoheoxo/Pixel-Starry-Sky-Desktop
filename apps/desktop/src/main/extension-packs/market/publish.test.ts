import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCodedError } from '@pixelsky/protocol'
import type {
  ExtStoreCheckReport,
  ExtStoreMyExtension,
  ExtStoreMyVersion,
  ExtStorePublisherState,
} from '@pixelsky/protocol'
import { readPackZip } from '@pixelsky/extension-cli/zip'
import { main } from '../../../../../../packages/extension-cli/src/cli/main'

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, utilityProcess: { fork: vi.fn() } }))
vi.mock('../../account/account', () => ({ baseUrl: () => 'http://127.0.0.1:9', extensionsFetch: vi.fn() }))

const { createPublisher, nodeFs, READ_LIMIT, TOKEN_TTL_MS } = await import('./publish')
const { StoreError } = await import('./api')
type Deps = Parameters<typeof createPublisher>[0]
type PublishFs = NonNullable<Deps['fs']>

const MB = 1024 * 1024
const enc = new TextEncoder()

const manifestOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'acme.hello',
  name: 'X',
  version: '1.0.0',
  publisher: 'acme',
  description: 'd',
  license: 'MIT',
  engines: { pixelsky: '>=0.4.0' },
  contributes: { prompts: [{ id: 'explain', title: '解释', path: 'p/explain.md' }] },
  ...over,
})

function manifestZip(over: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    zipSync({
      'pixelsky-extension.json': enc.encode(JSON.stringify(manifestOf(over))),
      'p/explain.md': enc.encode('解释 {{selection}}'),
    }),
  )
}

const version = (v: string, status: ExtStoreMyVersion['status'] = 'approved'): ExtStoreMyVersion => ({
  version: v,
  status,
  sha256: '',
  size: 1,
  hints: 0,
  rulesVersion: 1,
  toolVersion: '1',
  blocked: false,
  blockReason: '',
  submittedAt: null,
  reviewedAt: null,
  rejectReason: null,
})
const extension = (versions: ExtStoreMyVersion[]): ExtStoreMyExtension => ({
  id: 'acme.hello',
  name: 'X',
  description: '',
  kinds: [],
  latestVersion: null,
  downloads: 0,
  installs: 0,
  delisted: false,
  delistedBy: '',
  delistReason: '',
  blocked: false,
  blockReason: '',
  createdAt: null,
  updatedAt: null,
  versions,
})
const state = (versions: ExtStoreMyVersion[] = [], name = 'acme'): ExtStorePublisherState => ({
  publisher: { name, official: false, createdAt: null },
  extensions: versions.length ? [extension(versions)] : [],
})

const okReport: ExtStoreCheckReport = { incomplete: false, issues: [], blocking: 0, hints: 1 }

/** 内存文件系统：记下每次读取的上限 */
function memFs(files: Record<string, Buffer> = {}, dirs: Record<string, Buffer> = {}) {
  const reads: number[] = []
  const store = new Map<string, string>()
  const fs: PublishFs = {
    kind: async p => (p in dirs ? 'dir' : p in files ? 'file' : Promise.reject(new Error('ENOENT'))),
    readHead: async (p, limit) => {
      reads.push(limit)
      return files[p].subarray(0, limit)
    },
    packFolder: async p => dirs[p],
    mkdir: async () => undefined,
    writeFile: async (p, d) => void store.set(p, d),
    rename: async (a, b) => {
      store.set(b, store.get(a)!)
      store.delete(a)
    },
    readFile: async p => {
      if (!store.has(p)) throw new Error('ENOENT')
      return store.get(p)!
    },
    rm: async p => void store.delete(p),
  }
  return { fs, reads, store }
}

function setup(over: Partial<Deps> = {}) {
  const api = {
    publisher: vi.fn(async () => state()),
    register: vi.fn(),
    upload: vi.fn(async (_zip: Uint8Array) => ({ version: '1.0.0', check: okReport })),
    withdraw: vi.fn(async () => version('1.0.0', 'withdrawn')),
    delist: vi.fn(),
    relist: vi.fn(),
    report: vi.fn(async () => undefined),
    detail: vi.fn(async () => {
      throw new StoreError('x', 'not_found', 404, 'extstore.notFound')
    }),
  }
  const runCheck = vi.fn(async (_zip: Buffer) => okReport)
  const mem = memFs()
  let tokenSeq = 0
  const deps: Deps = {
    api: api as unknown as Deps['api'],
    runCheck,
    signedIn: () => 'a@b.c',
    pickPath: async () => null,
    checksDir: '/data/publish-checks',
    fs: mem.fs,
    now: () => 1000,
    randomToken: () => `tok${++tokenSeq}`,
    ...over,
  }
  return { api, runCheck, mem, deps, pub: createPublisher(deps) }
}

const bytesInput = (b: Buffer, name = 'x.zip') => ({
  bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
  name,
})
const code = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p
  } catch (e) {
    return parseCodedError((e as Error).message)?.code
  }
  return undefined
}

describe('登录', () => {
  it('没登录的通道都回 extstore.notSignedIn，不发请求', async () => {
    const { pub, api } = setup({ signedIn: () => null })
    for (const run of [
      () => pub.publisher(),
      () => pub.register('acme'),
      () => pub.pickUpload(null, 1),
      () => pub.upload('t', 1),
      () => pub.withdraw('acme.hello', '1.0.0'),
      () => pub.delist('acme.hello'),
      () => pub.relist('acme.hello'),
      () => pub.report('acme.hello', { reason: 'other', detail: '', version: '1.0.0' }),
    ])
      expect(await code(run())).toBe('extstore.notSignedIn')
    expect(Object.values(api).every(f => f.mock.calls.length === 0)).toBe(true)
  })

  it('publishCheck 只读本机，不要求登录', async () => {
    const { pub } = setup({ signedIn: () => null })
    expect(await pub.publishCheck('acme.hello', '1.0.0')).toBeNull()
  })
})

describe('选包', () => {
  it('选择框选 zip：只读 10 MB + 1 字节', async () => {
    const mem = memFs({ '/a.zip': manifestZip() })
    const { pub } = setup({ fs: mem.fs, pickPath: async () => '/a.zip' })
    const r = await pub.pickUpload(null, 1)
    expect(r?.id).toBe('acme.hello')
    expect(mem.reads).toEqual([10 * MB + 1])
    expect(READ_LIMIT).toBe(10 * MB + 1)
  })

  it('取消选择框回 null', async () => {
    const { pub, api } = setup()
    expect(await pub.pickUpload(null, 1)).toBeNull()
    expect(api.publisher).not.toHaveBeenCalled()
  })

  it('正好 10 MB 能过，10 MB + 1 字节回 extstore.tooLarge（选择框和拖入都一样）', async () => {
    // 清单后面补零：大小这一关只看字节数，补零的尾巴不影响 zip 末尾之前的解析
    const pad = (n: number): Buffer => {
      const z = manifestZip()
      return Buffer.concat([z, Buffer.alloc(n - z.length)])
    }
    const exact = pad(10 * MB)
    const over = pad(10 * MB + 1)
    const mem = memFs({ '/exact.zip': exact, '/over.zip': over })
    let path = '/exact.zip'
    const { pub, runCheck } = setup({ fs: mem.fs, pickPath: async () => path })
    expect(await code(pub.pickUpload(null, 1))).not.toBe('extstore.tooLarge')
    path = '/over.zip'
    expect(await code(pub.pickUpload(null, 1))).toBe('extstore.tooLarge')
    expect(await code(pub.pickUpload(bytesInput(over), 1))).toBe('extstore.tooLarge')
    expect(await code(pub.pickUpload(bytesInput(exact), 1))).not.toBe('extstore.tooLarge')
    expect(runCheck.mock.calls.every(c => c[0].length <= 10 * MB)).toBe(true)
  })

  it('传字符串路径一律拒绝，不碰文件系统', async () => {
    const mem = memFs({ '/a.zip': manifestZip() })
    const kind = vi.spyOn(mem.fs, 'kind')
    const { pub } = setup({ fs: mem.fs })
    expect(await code(pub.pickUpload('/a.zip', 1))).toBe('extstore.badRequest')
    expect(await code(pub.pickUpload({ path: '/a.zip' }, 1))).toBe('extstore.badRequest')
    expect(kind).not.toHaveBeenCalled()
  })

  it('选文件夹：用 packFolder 打包', async () => {
    const mem = memFs({}, { '/dir': manifestZip() })
    const { pub } = setup({ fs: mem.fs, pickPath: async () => '/dir' })
    expect((await pub.pickUpload(null, 1))?.id).toBe('acme.hello')
  })

  it('读不出清单的包回 extstore.packErrors，不跑本机检查', async () => {
    const { pub, runCheck } = setup()
    const bad = Buffer.from(zipSync({ 'readme.md': enc.encode('x') }))
    expect(await code(pub.pickUpload(bytesInput(bad), 1))).toBe('extstore.packErrors')
    expect(runCheck).not.toHaveBeenCalled()
  })
})

describe('上传前的四条核对', () => {
  it('通过：返回三行核对、报告、token，字节交给本机检查', async () => {
    const { pub, runCheck } = setup()
    const zip = manifestZip()
    const r = await pub.pickUpload(bytesInput(zip), 1)
    expect(r).toMatchObject({
      token: 'tok1',
      id: 'acme.hello',
      version: '1.0.0',
      report: okReport,
      contributes: { prompts: [{ id: 'explain', title: '解释', path: 'p/explain.md' }] },
      previousContributes: null,
      checks: { permissions: [], prefixOk: true, versionNewer: true },
    })
    expect(runCheck).toHaveBeenCalledTimes(1)
    expect(runCheck.mock.calls[0][0]).toEqual(zip)
  })

  it('没有发布者：extstore.api.noPublisher，不跑本机检查', async () => {
    const { pub, api, runCheck } = setup()
    api.publisher.mockResolvedValue({ publisher: null, extensions: [] })
    expect(await code(pub.pickUpload(bytesInput(manifestZip()), 1))).toBe('extstore.api.noPublisher')
    expect(runCheck).not.toHaveBeenCalled()
  })

  it('id 前缀不是自己的 / 清单 publisher 不是自己：prefixOk 为 false，不发 token', async () => {
    const { pub } = setup()
    const a = await pub.pickUpload(bytesInput(manifestZip({ id: 'other.hello', publisher: 'other' })), 1)
    expect(a).toMatchObject({ token: '', checks: { prefixOk: false, versionNewer: true } })
    const b = await pub.pickUpload(bytesInput(manifestZip({ publisher: 'other' })), 1)
    expect(b).toMatchObject({ token: '', checks: { prefixOk: false } })
  })

  it('版本号不比已上架的最高版本大：versionNewer 为 false；撤回、没通过的版本号可以再用', async () => {
    const { pub, api } = setup()
    api.publisher.mockResolvedValue(state([version('1.0.0', 'approved')]))
    expect(await pub.pickUpload(bytesInput(manifestZip()), 1)).toMatchObject({
      token: '',
      checks: { versionNewer: false },
    })
    api.publisher.mockResolvedValue(state([version('1.0.0', 'withdrawn'), version('1.0.1', 'rejected')]))
    expect(await pub.pickUpload(bytesInput(manifestZip({ version: '1.0.0' })), 1)).toMatchObject({
      token: 'tok1',
      checks: { versionNewer: true },
    })
    api.publisher.mockResolvedValue(state([version('1.0.0', 'approved')]))
    expect(await pub.pickUpload(bytesInput(manifestZip({ version: '1.0.1' })), 1)).toMatchObject({
      checks: { versionNewer: true },
    })
  })

  it('待审核的版本只禁同一个版本号，不要求新版本比它大（和云端 versionRule 一致）', async () => {
    const { pub, api } = setup()
    // 已通过 1.0.0、待审核 2.0.0：传 1.5.0 比已通过的大，可以
    api.publisher.mockResolvedValue(state([version('1.0.0', 'approved'), version('2.0.0', 'pending')]))
    expect(await pub.pickUpload(bytesInput(manifestZip({ version: '1.5.0' })), 1)).toMatchObject({
      checks: { versionNewer: true },
    })
    // 只有待审核 1.0.0：传 0.9.0 可以；传同号 1.0.0 不行
    api.publisher.mockResolvedValue(state([version('1.0.0', 'pending')]))
    expect(await pub.pickUpload(bytesInput(manifestZip({ version: '0.9.0' })), 1)).toMatchObject({
      checks: { versionNewer: true },
    })
    expect(await pub.pickUpload(bytesInput(manifestZip({ version: '1.0.0' })), 1)).toMatchObject({
      token: '',
      checks: { versionNewer: false },
    })
  })

  it('待审核已有 3 个：extstore.api.tooManyPending；2 个还可以', async () => {
    const { pub, api, runCheck } = setup()
    api.publisher.mockResolvedValue(
      state([version('1.0.0', 'pending'), version('1.0.1', 'pending'), version('1.0.2', 'pending')]),
    )
    expect(await code(pub.pickUpload(bytesInput(manifestZip({ version: '2.0.0' })), 1))).toBe(
      'extstore.api.tooManyPending',
    )
    expect(runCheck).not.toHaveBeenCalled()
    api.publisher.mockResolvedValue(state([version('1.0.0', 'pending'), version('1.0.1', 'pending')]))
    expect((await pub.pickUpload(bytesInput(manifestZip({ version: '2.0.0' })), 1))?.token).toBe('tok1')
  })

  it('本机检查有要改的问题：带报告回来但不发 token；没检查完时照发', async () => {
    const { pub, runCheck } = setup()
    runCheck.mockResolvedValueOnce({ incomplete: false, issues: [], blocking: 2 })
    expect(await pub.pickUpload(bytesInput(manifestZip()), 1)).toMatchObject({ token: '', report: { blocking: 2 } })
    runCheck.mockResolvedValueOnce({ incomplete: true, issues: [] })
    expect(await pub.pickUpload(bytesInput(manifestZip()), 1)).toMatchObject({
      token: 'tok1',
      report: { incomplete: true },
    })
  })

  it('上一个上架版本的清单带回来做「（新增）」比较', async () => {
    const { pub, api } = setup()
    const previousContributes = { themes: [] }
    api.detail.mockResolvedValue({ manifest: { contributes: previousContributes } } as never)
    const r = await pub.pickUpload(bytesInput(manifestZip()), 1)
    expect(r?.previousContributes).toEqual(previousContributes)
    // 这次包里的贡献是另一回事，不会被上一个版本的顶掉
    expect(r?.contributes).toEqual({ prompts: [{ id: 'explain', title: '解释', path: 'p/explain.md' }] })
  })

  it('这次包里的贡献带回来；不认识的种类、不是数组的值丢掉', async () => {
    const { pub } = setup()
    const skills = [{ id: 's', title: 'S', path: 's.md' }]
    const zip = manifestZip({ contributes: { skills, themes: 'nope', prompts: { a: 1 }, evil: [1], __proto__x: [2] } })
    expect((await pub.pickUpload(bytesInput(zip), 1))?.contributes).toEqual({ skills })
    // 清单里没有 contributes：null
    const bare = manifestZip({ contributes: undefined })
    expect((await pub.pickUpload(bytesInput(bare), 1))?.contributes).toBeNull()
  })
})

describe('token', () => {
  const pickOk = (pub: ReturnType<typeof setup>['pub'], owner = 1) => pub.pickUpload(bytesInput(manifestZip()), owner)

  it('用一次就失效，成功或失败都一样', async () => {
    const { pub, api } = setup()
    await pickOk(pub)
    await pub.upload('tok1', 1)
    expect(await code(pub.upload('tok1', 1))).toBe('extstore.badRequest')
    await pickOk(pub)
    api.upload.mockRejectedValueOnce(new StoreError('x', 'rate_limited', 429, 'extstore.api.uploadRateLimited'))
    await expect(pub.upload('tok2', 1)).rejects.toThrow()
    expect(await code(pub.upload('tok2', 1))).toBe('extstore.badRequest')
    expect(api.upload).toHaveBeenCalledTimes(2)
  })

  it('10 分钟过期', async () => {
    let t = 1000
    const { pub, api } = setup({ now: () => t })
    await pickOk(pub)
    t += TOKEN_TTL_MS
    expect(await code(pub.upload('tok1', 1))).toBe('extstore.badRequest')
    await pickOk(pub)
    t += TOKEN_TTL_MS - 1
    await pub.upload('tok2', 1)
    expect(api.upload).toHaveBeenCalledTimes(1)
  })

  it('一个窗口只留一份：新的顶掉旧的；别的窗口互不影响；token 不对不能用', async () => {
    const { pub, api } = setup()
    await pickOk(pub, 1) // tok1
    await pickOk(pub, 1) // tok2 顶掉 tok1
    expect(await code(pub.upload('tok1', 1))).toBe('extstore.badRequest')
    await pickOk(pub, 1) // tok3
    await pickOk(pub, 2) // tok4
    expect(await code(pub.upload('tok4', 1))).toBe('extstore.badRequest') // 别的窗口的 token
    await pub.upload('tok4', 2)
    expect(await code(pub.upload('', 1))).toBe('extstore.badRequest')
    expect(api.upload).toHaveBeenCalledTimes(1)
  })

  it('窗口关了（forget）：它没用过的 token 作废，别的窗口不受影响', async () => {
    const { pub, api } = setup()
    await pickOk(pub, 1) // tok1
    await pickOk(pub, 2) // tok2
    pub.forget(1)
    expect(await code(pub.upload('tok1', 1))).toBe('extstore.badRequest')
    await pub.upload('tok2', 2)
    expect(api.upload).toHaveBeenCalledTimes(1)
    pub.forget(99) // 没有记录的窗口：不报错
  })

  it('上传的是选包时读到的那份字节，不再读文件', async () => {
    const zip = manifestZip()
    const mem = memFs({ '/a.zip': zip })
    const { pub, api } = setup({ fs: mem.fs, pickPath: async () => '/a.zip' })
    await pub.pickUpload(null, 1)
    await pub.upload('tok1', 1)
    expect(mem.reads).toHaveLength(1)
    expect(Buffer.from(api.upload.mock.calls[0][0]).equals(zip)).toBe(true)
  })

  it('核对没过时不发 token，旧 token 也被作废', async () => {
    const { pub } = setup()
    await pickOk(pub)
    await pub.pickUpload(bytesInput(manifestZip({ publisher: 'other' })), 1)
    expect(await code(pub.upload('tok1', 1))).toBe('extstore.badRequest')
  })
})

describe('检查结果存本机', () => {
  const file = join('/data/publish-checks', 'acme.hello@1.0.0.json')
  const cloudCheck: ExtStoreCheckReport = {
    incomplete: false,
    issues: [],
    blocking: 1,
    hints: 0,
    rulesVersion: 3,
    toolVersion: '9',
  }

  it('上传成功：存本机检查报告，publishCheck 读回来一样', async () => {
    const { pub, mem } = setup()
    await pub.pickUpload(bytesInput(manifestZip()), 1)
    await pub.upload('tok1', 1)
    expect(JSON.parse(mem.store.get(file)!)).toEqual(okReport)
    expect(await pub.publishCheck('acme.hello', '1.0.0')).toEqual(okReport)
    expect([...mem.store.keys()]).toEqual([file]) // 先写临时文件再改名，没留下临时文件
  })

  it('本机没检查完时，成功后存云端带回来的那份', async () => {
    const { pub, mem, runCheck, api } = setup()
    runCheck.mockResolvedValue({ incomplete: true, issues: [] })
    api.upload.mockResolvedValue({ version: '1.0.0', check: cloudCheck })
    await pub.pickUpload(bytesInput(manifestZip()), 1)
    await pub.upload('tok1', 1)
    expect(JSON.parse(mem.store.get(file)!)).toEqual(cloudCheck)
  })

  it('云端回 422 check_failed：存云端带回来的 check，错误对象里也带着它', async () => {
    const { pub, mem, api } = setup()
    const err = new StoreError('m', 'check_failed', 422, 'extstore.api.checkFailed', cloudCheck)
    api.upload.mockRejectedValue(err)
    await pub.pickUpload(bytesInput(manifestZip()), 1)
    await expect(pub.upload('tok1', 1)).rejects.toBe(err)
    expect(err.check).toEqual(cloudCheck)
    expect(JSON.parse(mem.store.get(file)!)).toEqual(cloudCheck)
    expect(await pub.publishCheck('acme.hello', '1.0.0')).toEqual(cloudCheck)
  })

  it('其他失败（version_used 等）不存', async () => {
    const { pub, mem, api } = setup()
    api.upload.mockRejectedValue(new StoreError('m', 'version_used', 409, 'extstore.api.versionProblem'))
    await pub.pickUpload(bytesInput(manifestZip()), 1)
    await expect(pub.upload('tok1', 1)).rejects.toThrow()
    expect(mem.store.size).toBe(0)
    expect(await pub.publishCheck('acme.hello', '1.0.0')).toBeNull()
  })

  it('存盘失败不影响上传结果', async () => {
    const { pub, mem } = setup()
    mem.fs.writeFile = async () => {
      throw new Error('disk full')
    }
    await pub.pickUpload(bytesInput(manifestZip()), 1)
    await expect(pub.upload('tok1', 1)).resolves.toMatchObject({ version: '1.0.0' })
  })

  it('publishCheck：没有是 null；文件坏了也是 null', async () => {
    const { pub, mem } = setup()
    expect(await pub.publishCheck('acme.hello', '1.0.0')).toBeNull()
    mem.store.set(file, '{oops')
    expect(await pub.publishCheck('acme.hello', '1.0.0')).toBeNull()
    mem.store.set(file, '{"x":1}')
    expect(await pub.publishCheck('acme.hello', '1.0.0')).toBeNull()
  })

  it('publishCheck：id / 版本不合格（路径穿越）时拒绝，不碰文件系统', async () => {
    const { pub, mem } = setup()
    const read = vi.spyOn(mem.fs, 'readFile')
    const cases: Array<[unknown, unknown]> = [
      ['../x', '1.0.0'],
      ['acme.hello', '../1.0.0'],
      ['acme/x', '1.0.0'],
      ['acme.hello', '1.0.0/../../a'],
      [1, '1.0.0'],
    ]
    for (const [id, v] of cases) expect(await code(pub.publishCheck(id, v))).toBe('extstore.badRequest')
    expect(read).not.toHaveBeenCalled()
  })
})

describe('注册 / 撤回 / 下架 / 重新上架', () => {
  it('参数合格才发请求', async () => {
    const { pub, api } = setup()
    expect(await code(pub.register('A'))).toBe('extstore.badRequest')
    expect(await code(pub.register('acme-'))).toBe('extstore.badRequest')
    expect(await code(pub.withdraw('../x', '1.0.0'))).toBe('extstore.badRequest')
    expect(await code(pub.delist('x'))).toBe('extstore.badRequest')
    expect(await code(pub.relist(5))).toBe('extstore.badRequest')
    expect(api.register).not.toHaveBeenCalled()
    await pub.register('acme')
    await pub.withdraw('acme.hello', '1.0.0')
    await pub.delist('acme.hello')
    await pub.relist('acme.hello')
    expect(api.register).toHaveBeenCalledWith('acme')
    expect(api.withdraw).toHaveBeenCalledWith('acme.hello', '1.0.0')
    expect(api.delist).toHaveBeenCalledWith('acme.hello')
    expect(api.relist).toHaveBeenCalledWith('acme.hello')
  })

  it('云端错误原样抛出', async () => {
    const { pub, api } = setup()
    const err = new StoreError('m', 'delisted_by_admin', 403, 'extstore.api.delistedByAdmin')
    api.relist.mockRejectedValue(err)
    await expect(pub.relist('acme.hello')).rejects.toBe(err)
  })
})

describe('举报', () => {
  const input = { reason: 'broken', detail: '坏了', version: '1.0.0' }

  it('detail 正好 2000 字能过，2001 字回 extstore.badRequest', async () => {
    const { pub, api } = setup()
    await pub.report('acme.hello', { ...input, detail: 'a'.repeat(2000) })
    expect(api.report).toHaveBeenCalledTimes(1)
    expect(await code(pub.report('acme.hello', { ...input, detail: 'a'.repeat(2001) }))).toBe('extstore.badRequest')
    expect(api.report).toHaveBeenCalledTimes(1)
  })

  it('原因必须是六种之一，id 和版本要合格', async () => {
    const { pub, api } = setup()
    expect(await code(pub.report('acme.hello', { ...input, reason: 'spam' }))).toBe('extstore.badRequest')
    expect(await code(pub.report('acme.hello', null))).toBe('extstore.badRequest')
    expect(await code(pub.report('../x', input))).toBe('extstore.badRequest')
    expect(await code(pub.report('acme.hello', { ...input, version: 'v1' }))).toBe('extstore.badRequest')
    expect(await code(pub.report('acme.hello', { ...input, detail: 1 }))).toBe('extstore.badRequest')
    expect(api.report).not.toHaveBeenCalled()
    for (const reason of ['malicious', 'broken', 'copyright', 'inappropriate', 'misleading', 'other'])
      await pub.report('acme.hello', { ...input, reason })
    expect(api.report).toHaveBeenCalledTimes(6)
  })

  it('不给版本时用商店里现在的版本', async () => {
    const { pub, api } = setup()
    api.detail.mockResolvedValue({ extension: { version: '2.3.4' } } as never)
    await pub.report('acme.hello', { reason: 'other', detail: '' })
    expect(api.report).toHaveBeenCalledWith('acme.hello', { reason: 'other', detail: '', version: '2.3.4' })
  })

  it('云端的举报错误原样抛出（映射在 api.test.ts）', async () => {
    const { pub, api } = setup()
    const err = new StoreError('m', 'already_reported', 429, 'extstore.api.alreadyReported')
    api.report.mockRejectedValue(err)
    await expect(pub.report('acme.hello', input)).rejects.toBe(err)
  })
})

describe('nodeFs（真实文件）', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  it('文件夹打出来的 zip 和 CLI pack 逐字节相同', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pub-'))
    const ext = join(dir, 'ext')
    await mkdir(join(ext, 'p'), { recursive: true })
    await writeFile(
      join(ext, 'pixelsky-extension.json'),
      JSON.stringify(manifestOf({ main: null, permissions: [], price: null })),
    )
    await writeFile(join(ext, 'LICENSE'), 'MIT')
    await writeFile(join(ext, 'README.md'), '# X')
    await writeFile(join(ext, 'p', 'explain.md'), '解释 {{selection}}')
    const mine = await nodeFs.packFolder(ext)
    expect(readPackZip(mine).entries.map(e => e.path)).toEqual([
      'LICENSE',
      'README.md',
      'p/explain.md',
      'pixelsky-extension.json',
    ])
    expect((await nodeFs.packFolder(ext)).equals(mine)).toBe(true)

    const out = join(dir, 'cli.zip')
    let log = ''
    const io = {
      out: (s: string) => void (log += s),
      err: (s: string) => void (log += s),
      cwd: dir,
      env: {},
      isTTY: false,
      locale: 'zh-CN',
    }
    const exit = await main(['pack', ext, '--out', out, '--grammar', 'off'], io, { runner: 'inline' })
    expect(exit).toBe(0)
    expect(mine.equals(await readFile(out))).toBe(true)
  })

  it('readHead 只读到上限', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pub-'))
    const big = join(dir, 'big.zip')
    await writeFile(big, Buffer.alloc(100))
    expect((await nodeFs.readHead(big, 10)).length).toBe(10)
    expect((await nodeFs.readHead(big, 1000)).length).toBe(100)
    expect(await nodeFs.kind(dir)).toBe('dir')
    expect(await nodeFs.kind(big)).toBe('file')
  })
})
