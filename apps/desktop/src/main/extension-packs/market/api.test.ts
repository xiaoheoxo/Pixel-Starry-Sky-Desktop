import { describe, expect, it, vi } from 'vitest'
import { codedError, parseCodedError } from '@pixelsky/protocol'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
vi.mock('../../account/account', () => ({ baseUrl: () => 'http://127.0.0.1:9', extensionsFetch: vi.fn() }))

const { createApi, mapError, StoreError } = await import('./api')
type Deps = Parameters<typeof createApi>[0]

// 测试响应体手写（云端契约样例目录 services/cloud/testdata/contract/desktop/ 里没有 extension-*.json，
// 2026-10-16 核对，ls | grep -c '^extension-' 为 0）。字段逐个对照：
//   公开接口  services/cloud/internal/api/extapi/extapi.go
//   作者接口  services/cloud/internal/api/desktopapi/extensions.go
//   错误代码  services/cloud/internal/extensions/errors.go:110-131（code）、internal/api/apierr/apierr.go:75-107（状态和提示）

const json = (body: unknown, status = 200): Response => Response.json(body, { status })

/** extapi.go:81-93 itemJSON */
const item = {
  id: 'acme.hello',
  name: 'Hello',
  description: '你好',
  publisher: { name: 'acme', official: false },
  version: '1.2.0',
  icon_url: '/cloud/extensions/acme.hello/1.2.0/icon',
  kinds: ['grammars', 'themes'],
  categories: ['code', 'code-grammars'],
  downloads: 12,
  installs: 7,
  updated_at: '2026-10-01T08:00:00Z',
}
/** extapi.go:95-98 versionJSON */
const version = {
  version: '1.2.0',
  published_at: '2026-10-01T08:00:00Z',
  size: 2048,
  sha256: 'a'.repeat(64),
  signature: 'c2ln',
  key_id: '8273f03a',
  download_url: '/cloud/extensions/acme.hello/1.2.0.zip',
}
/** desktopapi/extensions.go:192-198 extVersionJSON */
const myVersion = {
  extension_id: 'acme.hello',
  version: '1.2.0',
  status: 'pending',
  sha256: 'b'.repeat(64),
  size: 2048,
  hints: 2,
  rules_version: 2,
  tool_version: '0.3.0',
  blocked: false,
  block_reason: '',
  submitted_at: '2026-10-02T08:00:00Z',
  reviewed_at: null,
  reject_reason: null,
}
/** desktopapi/extensions.go:177-190 extExtensionJSON */
const myExtension = {
  id: 'acme.hello',
  name: 'Hello',
  description: '你好',
  kinds: ['grammars'],
  latest_version: null,
  downloads: 0,
  installs: 0,
  delisted: false,
  delisted_by: '',
  delist_reason: '',
  blocked: false,
  block_reason: '',
  created_at: '2026-10-02T08:00:00Z',
  updated_at: '2026-10-02T08:00:00Z',
}
/** 检查器报告（docs/extensions/cli.md §6.2 schema 1；云端 report.go:24-44 读的字段） */
const check = {
  schema: 1,
  tool: { name: 'pixelsky-ext', version: '0.3.0', rulesVersion: 2 },
  options: { level: 'upload' },
  verdict: { pass: false, blocking: 1 },
  counts: { error: 1, warning: 0, reject: 1, hint: 3, note: 0 },
  issues: [
    {
      severity: 'error',
      scope: 'file',
      code: 'files.path',
      message: { zh: '文件名不对', en: 'Bad file name' },
      outcome: 'reject',
    },
    { not: 'an issue' },
  ],
}

function make(handlers: {
  pub?: (path: string, init?: object) => Response | Promise<Response>
  auth?: (method: string, path: string, opts?: Record<string, unknown>) => Response | Promise<Response>
}) {
  const calls: Array<{ via: 'pub' | 'auth'; path: string; init?: Record<string, unknown>; method?: string }> = []
  const deps: Deps = {
    publicFetch: async (path, init) => {
      calls.push({ via: 'pub', path, init: init as Record<string, unknown> })
      return handlers.pub!(path, init)
    },
    extensionsFetch: async (method, path, opts) => {
      calls.push({ via: 'auth', path, method, init: opts as Record<string, unknown> })
      return handlers.auth!(method, path, opts as Record<string, unknown>)
    },
  }
  return { api: createApi(deps), calls }
}

const fail = async (p: Promise<unknown>) => {
  const e = (await p.catch((x: unknown) => x)) as InstanceType<typeof StoreError>
  expect(e).toBeInstanceOf(StoreError)
  return e
}
const coded = (e: Error) => parseCodedError(e.message)

describe('解析', () => {
  it('目录（extapi.go:104-131）：条目、next_before 为 null 和有值', async () => {
    const { api, calls } = make({ pub: () => json({ items: [item, { no: 'id' }, 5], next_before: null }) })
    const page = await api.catalog({ q: 'he llo', category: 'code', sort: 'updated', before: '30' })
    expect(page.nextBefore).toBeNull()
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toEqual({
      id: 'acme.hello',
      name: 'Hello',
      description: '你好',
      publisher: { name: 'acme', official: false },
      version: '1.2.0',
      iconUrl: '/cloud/extensions/acme.hello/1.2.0/icon',
      kinds: ['grammars', 'themes'],
      categories: ['code', 'code-grammars'],
      downloads: 12,
      installs: 7,
      updatedAt: '2026-10-01T08:00:00Z',
    })
    const url = new URL(calls[0].path, 'http://x')
    expect(url.pathname).toBe('/cloud/api/extensions')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'he llo',
      category: 'code',
      sort: 'updated',
      before: '30',
      limit: '30',
    })
    const second = make({ pub: () => json({ items: [], next_before: '30' }) })
    expect((await second.api.catalog()).nextBefore).toBe('30')
  })

  it('目录：搜索词截到 100 字，limit 夹在 1-100 之间；缺 items 是 badResponse', async () => {
    const { api, calls } = make({ pub: () => json({ items: [], next_before: null }) })
    await api.catalog({ q: '字'.repeat(150) }, 500)
    const params = new URL(calls[0].path, 'http://x').searchParams
    expect([...params.get('q')!]).toHaveLength(100)
    expect(params.get('limit')).toBe('100')
    for (const bad of [{}, { items: 'x' }, null, [1]]) {
      const e = await fail(make({ pub: () => json(bad) }).api.catalog())
      expect(e.key).toBe('extstore.api.badResponse')
    }
  })

  it('目录项缺字段、类型不对：用默认值，不抛', async () => {
    const { api } = make({
      pub: () => json({ items: [{ id: 'a.b', publisher: 'x', kinds: 'nope', downloads: 'many', icon_url: 5 }] }),
    })
    const [it] = (await api.catalog()).items
    expect(it).toMatchObject({
      id: 'a.b',
      name: 'a.b',
      publisher: { name: '', official: false },
      kinds: [],
      downloads: 0,
      iconUrl: '',
      updatedAt: null,
    })
  })

  it('详情（extapi.go:153-183）：fresh 传 no-cache，否则不传；manifest 为 null 也行', async () => {
    const body = {
      extension: item,
      latest: version,
      manifest: { id: 'acme.hello' },
      readme: '# hi',
      contents: [{ kind: 'grammars', count: 2 }, { kind: 5 }],
      license: 'MIT',
      repository: null,
      homepage: null,
      versions: [version, { nope: 1 }],
    }
    const { api, calls } = make({ pub: () => json(body) })
    const d = await api.detail('acme.hello', { fresh: true })
    expect(calls[0].init).toMatchObject({ cache: 'no-cache' })
    expect(calls[0].path).toBe('/cloud/api/extensions/acme.hello')
    expect(d.latest).toEqual({
      version: '1.2.0',
      publishedAt: '2026-10-01T08:00:00Z',
      size: 2048,
      sha256: 'a'.repeat(64),
      signature: 'c2ln',
      keyId: '8273f03a',
      downloadUrl: '/cloud/extensions/acme.hello/1.2.0.zip',
    })
    expect(d.contents).toEqual([{ kind: 'grammars', count: 2 }])
    expect(d.versions).toHaveLength(1)
    expect(d.license).toBe('MIT')
    expect(d.repository).toBeNull()
    expect(d.local).toBeNull()

    await api.detail('acme.hello')
    expect(calls[1].init).not.toHaveProperty('cache')
    const nullManifest = make({ pub: () => json({ ...body, manifest: null }) })
    expect((await nullManifest.api.detail('acme.hello')).manifest).toBeNull()
    const missing = make({ pub: () => json({ extension: item }) })
    expect((await fail(missing.api.detail('acme.hello'))).key).toBe('extstore.api.badResponse')
  })

  it('详情：id 不合规（路径注入）在发请求前就被拒', async () => {
    const { api, calls } = make({ pub: () => json({}) })
    for (const id of ['../x', 'a/b', 'A.B', '', 'a%2Fb', 'x'.repeat(200)])
      await expect(api.detail(id), id).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('停用名单（extapi.go:185-201）："*" 和版本数组；形状不对的条目丢掉', async () => {
    const { api, calls } = make({
      pub: () =>
        json({
          updated_at: '2026-10-03T00:00:00Z',
          items: [
            { id: 'a.b', versions: '*', reason: '恶意' },
            { id: 'a.c', versions: ['1.0.0', 3], reason: '坏了' },
            { id: 'a.e', versions: ['not a version', '2.0.0'], reason: '部分坏' },
            { id: 'a.f', versions: ['not a version'], reason: '全坏' },
            { id: 'a.d', versions: 'nope', reason: 'x' },
            { id: '', versions: '*' },
            null,
          ],
        }),
    })
    const list = await api.blocklist()
    expect(calls[0].init).toMatchObject({ cache: 'no-cache' })
    expect(list.updatedAt).toBe('2026-10-03T00:00:00Z')
    expect(list.items).toEqual([
      { id: 'a.b', versions: '*', reason: '恶意' },
      { id: 'a.c', versions: ['1.0.0'], reason: '坏了' },
      { id: 'a.e', versions: ['2.0.0'], reason: '部分坏' },
    ])
    expect((await make({ pub: () => json({ updated_at: null, items: [] }) }).api.blocklist()).updatedAt).toBeNull()
  })

  it('我的发布（desktopapi/extensions.go:52-73）：没注册发布者时 publisher 是 null', async () => {
    const { api } = make({
      auth: () =>
        json({
          publisher: null,
          extensions: [{ ...myExtension, latest_version: '1.0.0', versions: [myVersion, { x: 1 }] }, { no: 'id' }],
        }),
    })
    const s = await api.publisher()
    expect(s.publisher).toBeNull()
    expect(s.extensions).toHaveLength(1)
    expect(s.extensions[0].latestVersion).toBe('1.0.0')
    expect(s.extensions[0].versions).toEqual([
      {
        version: '1.2.0',
        status: 'pending',
        sha256: 'b'.repeat(64),
        size: 2048,
        hints: 2,
        rulesVersion: 2,
        toolVersion: '0.3.0',
        blocked: false,
        blockReason: '',
        submittedAt: '2026-10-02T08:00:00Z',
        reviewedAt: null,
        rejectReason: null,
      },
    ])
    const withPub = make({
      auth: () =>
        json({ publisher: { name: 'acme', official: true, created_at: '2026-10-01T00:00:00Z' }, extensions: [] }),
    })
    expect((await withPub.api.publisher()).publisher).toEqual({
      name: 'acme',
      official: true,
      createdAt: '2026-10-01T00:00:00Z',
    })
    expect((await fail(make({ auth: () => json({ publisher: null }) }).api.publisher())).key).toBe(
      'extstore.api.badResponse',
    )
  })

  it('我的发布：不认识的版本状态当 pending', async () => {
    const { api } = make({
      auth: () =>
        json({ publisher: null, extensions: [{ ...myExtension, versions: [{ ...myVersion, status: 'weird' }] }] }),
    })
    expect((await api.publisher()).extensions[0].versions[0].status).toBe('pending')
  })

  it('注册（extensions.go:75-89，201）、撤回（:114-121）、下架 / 上架（:124-140）', async () => {
    const { api, calls } = make({
      auth: (method, path) => {
        if (path.endsWith('/publisher'))
          return json({ publisher: { name: 'acme', official: false, created_at: '2026-10-01T00:00:00Z' } }, 201)
        if (path.endsWith('/withdraw')) return json({ version: { ...myVersion, status: 'withdrawn' } })
        return json({ extension: { ...myExtension, delisted: path.endsWith('/delist'), delisted_by: 'author' } })
      },
    })
    expect((await api.register('acme')).name).toBe('acme')
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/extensions/publisher',
      init: { body: { name: 'acme' } },
    })
    expect((await api.withdraw('acme.hello', '1.2.0')).status).toBe('withdrawn')
    expect(calls[1].path).toBe('/v1/extensions/acme.hello/versions/1.2.0/withdraw')
    expect((await api.delist('acme.hello')).delisted).toBe(true)
    expect((await api.relist('acme.hello')).delisted).toBe(false)
    expect(calls.map(c => c.path).slice(2)).toEqual([
      '/v1/extensions/acme.hello/delist',
      '/v1/extensions/acme.hello/relist',
    ])
  })

  it('上传成功（extensions.go:92-112，201）：存下 check 里的 issues、规则版本、提示条数；zip 原文、application/zip、90 秒', async () => {
    const { api, calls } = make({
      auth: () => json({ version: myVersion, check: { ...check, verdict: { pass: true, blocking: 0 } } }, 201),
    })
    const zip = new Uint8Array([80, 75, 3, 4])
    const r = await api.upload(zip)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/extensions/upload',
      init: { raw: zip, contentType: 'application/zip', timeoutMs: 90_000 },
    })
    expect(r.version).toBe('1.2.0')
    expect(r.check).toMatchObject({ incomplete: false, blocking: 0, hints: 3, rulesVersion: 2, toolVersion: '0.3.0' })
    expect(r.check.issues.map(i => i.code)).toEqual(['files.path'])
    // 缺 check 或缺 version 都算返回的数据异常
    expect((await fail(make({ auth: () => json({ version: myVersion }, 201) }).api.upload(zip))).key).toBe(
      'extstore.api.badResponse',
    )
  })

  it('举报（extensions.go:143-160，201）：只发 reason / detail / version；installed 不抛', async () => {
    const { api, calls } = make({
      auth: () => json({ report: { id: 5, created_at: '2026-10-03T00:00:00Z' } }, 201),
      pub: () => new Response(null, { status: 404 }),
    })
    await api.report('acme.hello', { reason: 'broken', detail: '打不开', version: '1.2.0' })
    expect(calls[0]).toMatchObject({
      path: '/v1/extensions/acme.hello/report',
      init: { body: { reason: 'broken', detail: '打不开', version: '1.2.0' } },
    })
    await expect(api.installed('acme.hello')).resolves.toBeUndefined()
    expect(calls[1]).toMatchObject({
      via: 'pub',
      path: '/cloud/api/extensions/acme.hello/installed',
      init: { method: 'POST' },
    })
    const boom = make({
      pub: () => {
        throw new TypeError('offline')
      },
    })
    await expect(boom.api.installed('acme.hello')).resolves.toBeUndefined()
  })
})

describe('按「接口 + code」映射错误', () => {
  const err = (code: string, error = '云端原文', extra: object = {}) => ({ error, code, ...extra })

  // 状态码和 code 对照 apierr.go:75-107、errors.go:110-131
  const table: Array<[Parameters<typeof mapError>[0], number, string, string]> = [
    ['upload', 422, 'check_failed', 'extstore.api.checkFailed'],
    ['upload', 422, 'check_timeout', 'extstore.api.checkTimeout'],
    ['upload', 403, 'no_publisher', 'extstore.api.noPublisher'],
    ['upload', 403, 'not_your_publisher', 'extstore.api.notYourPublisher'],
    ['upload', 409, 'version_not_newer', 'extstore.api.versionProblem'],
    ['upload', 409, 'version_used', 'extstore.api.versionProblem'],
    ['upload', 409, 'version_pending', 'extstore.api.versionProblem'],
    ['upload', 409, 'too_many_pending', 'extstore.api.tooManyPending'],
    ['upload', 429, 'rate_limited', 'extstore.api.uploadRateLimited'],
    ['upload', 413, 'too_large', 'extstore.api.tooLarge'],
    ['upload', 400, 'bad_package', 'extstore.api.badPackage'],
    ['upload', 503, 'checker_unavailable', 'extstore.api.checkerUnavailable'],
    ['upload', 502, 'checker_error', 'extstore.api.checkerError'],
    ['upload', 400, 'invalid', 'extstore.api.invalid'],
    ['report', 429, 'rate_limited', 'extstore.api.reportRateLimited'],
    ['report', 429, 'already_reported', 'extstore.api.alreadyReported'],
    ['report', 404, 'not_found', 'extstore.api.reportNotFound'],
    ['report', 400, 'invalid', 'extstore.api.invalid'],
    ['register', 409, 'name_taken', 'extstore.api.nameTaken'],
    ['register', 409, 'already_publisher', 'extstore.api.alreadyPublisher'],
    ['register', 400, 'reserved_name', 'extstore.api.reservedName'],
    ['register', 400, 'bad_publisher_name', 'extstore.api.badPublisherName'],
    ['withdraw', 409, 'bad_state', 'extstore.api.badState'],
    ['withdraw', 404, 'not_found', 'extstore.api.myNotFound'],
    ['delist', 404, 'not_found', 'extstore.api.myNotFound'],
    ['relist', 403, 'delisted_by_admin', 'extstore.api.delistedByAdmin'],
    ['relist', 404, 'not_found', 'extstore.api.myNotFound'],
    ['detail', 404, 'not_found', 'extstore.notFound'],
    ['catalog', 400, 'invalid', 'extstore.api.invalid'],
    ['catalog', 503, 'unavailable', 'extstore.api.unavailable'],
    ['publisher', 503, 'unavailable', 'extstore.api.unavailable'],
  ]
  it.each(table)('%s %i %s -> %s', (endpoint, status, code, key) => {
    const e = mapError(endpoint, status, err(code, '云端原文'))
    expect(e.key).toBe(key)
    expect(e.code).toBe(code)
    expect(e.status).toBe(status)
    expect(coded(e)?.code).toBe(key)
  })

  it('版本号问题和包不对：云端原文放进参数照显示', () => {
    const e = mapError('upload', 409, err('version_used', '这个版本号已经上架过'))
    expect(coded(e)).toEqual({ code: 'extstore.api.versionProblem', params: { message: '这个版本号已经上架过' } })
    expect(coded(mapError('upload', 400, err('bad_package', '没有 manifest.json')))?.params.message).toBe(
      '没有 manifest.json',
    )
  })

  it('同一个 code 在不同接口上文案不同：rate_limited 和 not_found', () => {
    expect(mapError('upload', 429, err('rate_limited')).key).not.toBe(mapError('report', 429, err('rate_limited')).key)
    expect(mapError('report', 404, err('not_found')).key).toBe('extstore.api.reportNotFound')
    expect(mapError('withdraw', 404, err('not_found')).key).toBe('extstore.api.myNotFound')
    // already_reported 和 rate_limited 同是 429，靠 code 区分
    expect(mapError('report', 429, err('already_reported')).key).toBe('extstore.api.alreadyReported')
  })

  it('check_failed：把带回来的 check 解析出来挂在错误上，检查结果坏了就没有', () => {
    const e = mapError('upload', 422, err('check_failed', '没通过', { check }))
    expect(e.check).toMatchObject({ incomplete: false, blocking: 1, rulesVersion: 2 })
    expect(e.check?.issues).toHaveLength(1)
    expect(mapError('upload', 422, err('check_failed', '没通过', { check: 'x' })).check).toBeUndefined()
    // 别的接口的 check_failed 不解析 check
    expect(mapError('report', 422, err('check_failed', 'x', { check })).check).toBeUndefined()
  })

  it('internal 和不认识的 code：显示云端原文；没有原文写状态码', () => {
    for (const code of ['internal', 'brand_new_code']) {
      const e = mapError('upload', 500, err(code, '服务器内部错误'))
      expect(e.key).toBe('extstore.api.cloud')
      expect(coded(e)?.params).toEqual({ message: '服务器内部错误' })
    }
    const none = mapError('detail', 418, {})
    expect(none.key).toBe('extstore.api.status')
    expect(coded(none)?.params).toEqual({ status: 418 })
    expect(mapError('detail', 500, err('internal', '')).key).toBe('extstore.api.status')
    // 5xx、没有原文也没有 code：云端暂时不可用
    expect(mapError('catalog', 502, null).key).toBe('extstore.api.unavailable')
  })

  it('401：响应体不是 JSON 或只有 {"error":"invalid_token"} 都是未登录', () => {
    for (const body of [null, '', 'oops', { error: 'invalid_token' }, {}]) {
      const e = mapError('publisher', 401, body)
      expect(e.key).toBe('extstore.notSignedIn')
      expect(e.status).toBe(401)
    }
  })

  it('error 是对象时取 message', () => {
    expect(coded(mapError('upload', 500, { error: { message: '内部' } }))?.params).toEqual({ message: '内部' })
  })

  it('经 createApi：响应体不是 JSON 的 401、非 JSON 的 500 都能走到映射', async () => {
    const a = make({ auth: () => new Response('not json', { status: 401 }) })
    expect((await fail(a.api.publisher())).key).toBe('extstore.notSignedIn')
    const b = make({ auth: () => new Response('<html>', { status: 500 }) })
    expect((await fail(b.api.upload(new Uint8Array()))).key).toBe('extstore.api.unavailable')
    const c = make({ auth: () => json(err('check_failed', '没通过', { check }), 422) })
    const e = await fail(c.api.upload(new Uint8Array()))
    expect(e.key).toBe('extstore.api.checkFailed')
    expect(e.check?.issues).toHaveLength(1)
  })

  it('经 createApi：举报各种错误', async () => {
    const run = (status: number, code: string) =>
      fail(
        make({ auth: () => json(err(code), status) }).api.report('acme.hello', {
          reason: 'other',
          detail: 'x',
          version: '',
        }),
      )
    expect((await run(429, 'rate_limited')).key).toBe('extstore.api.reportRateLimited')
    expect((await run(429, 'already_reported')).key).toBe('extstore.api.alreadyReported')
    expect((await run(404, 'not_found')).key).toBe('extstore.api.reportNotFound')
    expect((await run(400, 'invalid')).key).toBe('extstore.api.invalid')
  })

  it('网络层错误：连不上是 offline，超时是 timeout，未登录和登录过期是 notSignedIn', async () => {
    const reject = (e: unknown) => make({ pub: () => Promise.reject(e), auth: () => Promise.reject(e) })
    expect((await fail(reject(new TypeError('fetch failed')).api.catalog())).key).toBe('extstore.offline')
    // Electron net.fetch 断网、连接被掐断时抛的是普通 Error，不是 TypeError（7.6a 走查发现漏成原文）
    expect((await fail(reject(new Error('net::ERR_EMPTY_RESPONSE')).api.catalog())).key).toBe('extstore.offline')
    expect((await fail(reject(new Error('net::ERR_CONNECTION_REFUSED')).api.publisher())).key).toBe('extstore.offline')
    // 已经带代码的错误（例如代理提示）不被改写成 offline
    const proxy = await reject(codedError('extstore.proxyHint'))
      .api.publisher()
      .then(
        () => null,
        (e: unknown) => e as Error,
      )
    expect(parseCodedError(proxy?.message)?.code).toBe('extstore.proxyHint')
    expect((await fail(reject(Object.assign(new Error('t'), { name: 'TimeoutError' })).api.catalog())).key).toBe(
      'extstore.timeout',
    )
    expect((await fail(reject(new Error('请先登录像素星空账号')).api.publisher())).key).toBe('extstore.notSignedIn')
    expect((await fail(reject(Object.assign(new Error('x'), { code: 'AUTH_EXPIRED' })).api.publisher())).key).toBe(
      'extstore.notSignedIn',
    )
  })
})
