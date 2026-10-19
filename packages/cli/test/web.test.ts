import { describe, expect, it } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  clampLimit,
  createWebTools,
  decodeEntities,
  htmlToText,
  parseDdgHtml,
  pickBackend,
  truncateText,
  unwrapDdgUrl,
  webExtension,
  type FetchFn,
} from '../src/tools/web.ts'
import type { LookupFn } from '../src/tools/ip-guard.ts'

type Call = { url: string; init?: RequestInit }

/** 假 fetch：按 URL 查表返回 Response，并记录调用。 */
function fakeFetch(routes: Record<string, () => Response>): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init })
    const r = routes[url]
    if (!r) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    return r()
  }
  return { fetch, calls }
}

const html =
  (body: string, headers: Record<string, string> = {}) =>
  () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })

const redirect =
  (to: string, status = 302) =>
  () =>
    new Response(null, { status, headers: { location: to } })

function textOf(r: { content: { text: string }[] }): string {
  return r.content[0].text
}

describe('htmlToText', () => {
  it('标题、段落、列表、链接绝对化、实体', () => {
    const out = htmlToText(
      `<h1>Hello &amp; welcome</h1><p>See <a href="/docs/a?x=1&amp;y=2">the docs</a> now&nbsp;please &#8212; &#x41;</p>
       <ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol><li>a</li><li>b</li></ol>`,
      'https://example.com/base/page',
    )
    expect(out).toContain('# Hello & welcome')
    expect(out).toContain('[the docs](https://example.com/docs/a?x=1&y=2)')
    expect(out).toContain('now please — A')
    expect(out).toContain('- one\n- two\n  - nested')
    expect(out).toContain('1. a\n2. b')
  })

  it('丢掉 script/style/noscript/svg/head/nav/footer 和注释', () => {
    const out = htmlToText(
      `<html><head><title>T</title><style>p{}</style></head><body>
       <nav><a href="/x">menu</a></nav><script>var a = "<p>no</p>"</script><noscript>nojs</noscript>
       <svg><text>icon</text></svg><!-- hidden --><p>Body text</p><footer>foot</footer></body></html>`,
      'https://e.com/',
    )
    expect(out).toBe('Body text')
  })

  it('有 <main> 时只取 main，否则取 <article>', () => {
    const withMain = htmlToText('<div>side</div><main><p>core</p></main><div>other</div>', 'https://e.com/')
    expect(withMain).toBe('core')
    const withArticle = htmlToText(
      '<div>side</div><article><p>a1</p></article><article><p>a2</p></article>',
      'https://e.com/',
    )
    expect(withArticle).toContain('a1')
    expect(withArticle).toContain('a2')
    expect(withArticle).not.toContain('side')
  })

  it('pre 变成围栏代码块并保留缩进和实体', () => {
    const out = htmlToText(
      '<p>Run:</p><pre><code class="language-js">if (a &lt; b) {\n  go()\n}</code></pre><p>after <code>x</code></p>',
      'https://e.com/',
    )
    expect(out).toContain('```js\nif (a < b) {\n  go()\n}\n```')
    expect(out).toContain('after `x`')
  })

  it('表格转竖线行，th 行后加分隔', () => {
    const out = htmlToText(
      '<table><tr><th>Name</th><th>Val</th></tr><tr><td>a|b</td><td>1</td></tr></table>',
      'https://e.com/',
    )
    expect(out).toBe('| Name | Val |\n| --- | --- |\n| a\\|b | 1 |')
  })

  it('锚点和 javascript 链接只留文字', () => {
    const out = htmlToText(
      '<a href="#top">up</a> <a href="javascript:void(0)">js</a> <a href="mailto:a@b.c">mail</a>',
      'https://e.com/',
    )
    expect(out).toBe('up js mail')
  })

  it('decodeEntities 对未知实体和非法数字实体不崩', () => {
    expect(decodeEntities('&unknown; &#0; &#xD800; &lt;')).toBe('&unknown; \uFFFD \uFFFD <')
  })
})

describe('truncateText', () => {
  it('超行数截断并给提示', () => {
    const r = truncateText('a\n'.repeat(3000), 1_000_000, 2000)
    expect(r.truncated).toBe(true)
    expect(r.text).toContain('[truncated')
  })
  it('超字节截断且不切坏多字节字符', () => {
    const r = truncateText('你'.repeat(100), 100)
    expect(r.truncated).toBe(true)
    expect(r.text).not.toContain('\uFFFD')
  })
  it('未超限原样返回', () => {
    expect(truncateText('hi')).toEqual({ text: 'hi', truncated: false })
  })
})

describe('web_fetch', () => {
  it('HTML 转文本，头部有 URL/Status/Content-Type/Title/prompt，details 完整', async () => {
    const { fetch } = fakeFetch({
      'https://e.com/a': html('<html><head><title>My Page</title></head><body><h2>Hi</h2><p>x</p></body></html>'),
    })
    const { fetchTool } = createWebTools({ fetch })
    const r = await fetchTool.execute('1', { url: 'https://e.com/a', prompt: 'the greeting' })
    const t = textOf(r)
    expect(t.startsWith('URL: https://e.com/a\nStatus: 200')).toBe(true)
    expect(t).toContain('Content-Type: text/html; charset=utf-8')
    expect(t).toContain('Title: My Page')
    expect(t).toContain('Looking for: the greeting')
    expect(t).toContain('## Hi')
    expect(r.details).toMatchObject({
      url: 'https://e.com/a',
      finalUrl: 'https://e.com/a',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      truncated: false,
    })
    expect(r.details.bytes).toBeGreaterThan(0)
  })

  it('按 content-type 的 charset 解码 GBK', async () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7]) // 你好世界
    const { fetch } = fakeFetch({
      'https://e.com/g': () => new Response(gbk, { headers: { 'content-type': 'text/plain; charset=gbk' } }),
    })
    const r = await createWebTools({ fetch }).fetchTool.execute('1', { url: 'https://e.com/g' })
    expect(textOf(r)).toContain('你好世界')
  })

  it('HTML 没声明 charset 时看 <meta>', async () => {
    const body = Buffer.concat([
      Buffer.from('<meta charset="gbk"><p>'),
      Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),
      Buffer.from('</p>'),
    ])
    const { fetch } = fakeFetch({
      'https://e.com/m': () => new Response(body, { headers: { 'content-type': 'text/html' } }),
    })
    const r = await createWebTools({ fetch }).fetchTool.execute('1', { url: 'https://e.com/m' })
    expect(textOf(r)).toContain('你好')
  })

  it('未知 charset 退回 utf-8', async () => {
    const { fetch } = fakeFetch({
      'https://e.com/u': () => new Response('héllo', { headers: { 'content-type': 'text/plain; charset=nope-9' } }),
    })
    const r = await createWebTools({ fetch }).fetchTool.execute('1', { url: 'https://e.com/u' })
    expect(textOf(r)).toContain('héllo')
  })

  it('JSON 美化，text/* 原样', async () => {
    const { fetch } = fakeFetch({
      'https://e.com/j': () => new Response('{"a":1,"b":[2]}', { headers: { 'content-type': 'application/json' } }),
      'https://e.com/t': () => new Response('plain  text', { headers: { 'content-type': 'text/plain' } }),
    })
    const tool = createWebTools({ fetch }).fetchTool
    expect(textOf(await tool.execute('1', { url: 'https://e.com/j' }))).toContain(
      '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
    )
    expect(textOf(await tool.execute('2', { url: 'https://e.com/t' }))).toContain('plain  text')
  })

  it('跟随重定向并报告最终 URL（相对 Location 也行）', async () => {
    const { fetch, calls } = fakeFetch({
      'https://e.com/a': redirect('/b', 301),
      'https://e.com/b': redirect('https://other.com/c', 307),
      'https://other.com/c': html('<p>done</p>'),
    })
    const lookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }]
    const r = await createWebTools({ fetch, lookup }).fetchTool.execute('1', { url: 'https://e.com/a' })
    expect(textOf(r)).toContain('URL: https://other.com/c')
    expect(r.details.finalUrl).toBe('https://other.com/c')
    expect(r.details.url).toBe('https://e.com/a')
    expect(calls.every(c => c.init?.redirect === 'manual')).toBe(true)
  })

  it('每一跳重新检查协议和账号密码', async () => {
    const { fetch, calls } = fakeFetch({
      'https://e.com/a': redirect('file:///etc/passwd'),
      'https://e.com/b': redirect('https://u:p@evil.com/'),
    })
    const tool = createWebTools({ fetch }).fetchTool
    await expect(tool.execute('1', { url: 'https://e.com/a' })).rejects.toThrow(/Unsupported URL scheme "file:"/)
    await expect(tool.execute('2', { url: 'https://e.com/b' })).rejects.toThrow(/credentials/)
    expect(calls).toHaveLength(2)
  })

  it('最多跟随 5 跳，第 6 跳报错', async () => {
    const routes: Record<string, () => Response> = {}
    for (let i = 0; i < 10; i++) routes[`https://e.com/${i}`] = redirect(`/${i + 1}`)
    routes['https://e.com/5'] = html('<p>reached 5</p>')
    const { fetch } = fakeFetch(routes)
    const tool = createWebTools({ fetch }).fetchTool
    // 0→1→2→3→4→5：恰好 5 跳，允许
    expect(textOf(await tool.execute('1', { url: 'https://e.com/0' }))).toContain('reached 5')
    // 0 起点改成死循环链，6 跳时报错
    routes['https://e.com/5'] = redirect('/6')
    await expect(tool.execute('2', { url: 'https://e.com/0' })).rejects.toThrow(/Too many redirects/)
  })

  it('重定向没有 Location 时按普通响应处理', async () => {
    const { fetch } = fakeFetch({
      'https://e.com/a': () => new Response('x', { status: 302, headers: { 'content-type': 'text/plain' } }),
    })
    const r = await createWebTools({ fetch }).fetchTool.execute('1', { url: 'https://e.com/a' })
    expect(r.details.status).toBe(302)
  })

  it('超过体积上限就停止读取并标记截断', async () => {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++
        c.enqueue(new Uint8Array(400).fill(97))
      },
    })
    const { fetch } = fakeFetch({
      'https://e.com/big': () => new Response(stream, { headers: { 'content-type': 'text/plain' } }),
    })
    const r = await createWebTools({ fetch, maxBodyBytes: 1000 }).fetchTool.execute('1', { url: 'https://e.com/big' })
    expect(r.details.bytes).toBe(1000)
    expect(r.details.truncated).toBe(true)
    expect(textOf(r)).toContain('exceeded')
    expect(pulled).toBeLessThan(10)
  })

  it('输出超长时截断并带提示', async () => {
    const { fetch } = fakeFetch({
      'https://e.com/l': () => new Response('line\n'.repeat(5000), { headers: { 'content-type': 'text/plain' } }),
    })
    const r = await createWebTools({ fetch }).fetchTool.execute('1', { url: 'https://e.com/l' })
    expect(r.details.truncated).toBe(true)
    expect(textOf(r)).toContain('[truncated')
  })

  it('二进制类型只给一行描述，不读 body', async () => {
    let read = false
    const { fetch } = fakeFetch({
      'https://e.com/i.png': () => {
        const res = new Response(new Uint8Array(2048), {
          headers: { 'content-type': 'image/png', 'content-length': '2048' },
        })
        const orig = res.body!.getReader.bind(res.body)
        res.body!.getReader = ((...a: []) => {
          read = true
          return orig(...a)
        }) as typeof ReadableStream.prototype.getReader
        return res
      },
    })
    const r = await createWebTools({ fetch }).fetchTool.execute('1', { url: 'https://e.com/i.png' })
    expect(textOf(r)).toContain('[Binary content not shown: image/png, 2.0 KB]')
    expect(r.details.bytes).toBe(2048)
    expect(read).toBe(false)
  })

  it('没有 content-type 时嗅探：NUL 视为二进制，HTML 按 HTML', async () => {
    const { fetch } = fakeFetch({
      'https://e.com/bin': () => new Response(new Uint8Array([1, 0, 2, 0])),
      'https://e.com/h': () => new Response(Buffer.from('<!DOCTYPE html><h1>Yo</h1>')),
    })
    const tool = createWebTools({ fetch }).fetchTool
    expect(textOf(await tool.execute('1', { url: 'https://e.com/bin' }))).toContain('Binary content not shown')
    expect(textOf(await tool.execute('2', { url: 'https://e.com/h' }))).toContain('# Yo')
  })

  it('HTTP 4xx/5xx 不抛错，返回状态和 body 开头', async () => {
    const { fetch } = fakeFetch({
      'https://e.com/404': () =>
        new Response('<p>Not here</p>', {
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-type': 'text/html' },
        }),
    })
    const r = await createWebTools({ fetch }).fetchTool.execute('1', { url: 'https://e.com/404' })
    expect(r.details.status).toBe(404)
    expect(textOf(r)).toContain('Status: 404 Not Found')
    expect(textOf(r)).toContain('Not here')
  })

  it('拒绝非 http(s) 协议、账号密码和非法 URL', async () => {
    const { fetch, calls } = fakeFetch({})
    const tool = createWebTools({ fetch }).fetchTool
    await expect(tool.execute('1', { url: 'ftp://e.com/x' })).rejects.toThrow(/Unsupported URL scheme/)
    await expect(tool.execute('2', { url: 'file:///C:/x' })).rejects.toThrow(/Unsupported URL scheme/)
    await expect(tool.execute('3', { url: 'javascript:alert(1)' })).rejects.toThrow(/Unsupported URL scheme/)
    await expect(tool.execute('4', { url: 'https://user:pw@e.com/' })).rejects.toThrow(/credentials/)
    await expect(tool.execute('5', { url: 'https://user@e.com/' })).rejects.toThrow(/credentials/)
    await expect(tool.execute('6', { url: 'not a url' })).rejects.toThrow(/Invalid URL/)
    expect(calls).toHaveLength(0)
  })

  it('网络错误抛短消息', async () => {
    const { fetch } = fakeFetch({})
    await expect(createWebTools({ fetch }).fetchTool.execute('1', { url: 'https://nowhere.test/' })).rejects.toThrow(
      'Fetching nowhere.test failed: ENOTFOUND',
    )
  })

  it('用户中止信号会中断请求', async () => {
    const fetch: FetchFn = (_u, init) =>
      new Promise((_res, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)))
    const ctl = new AbortController()
    const p = createWebTools({ fetch }).fetchTool.execute('1', { url: 'https://e.com/' }, ctl.signal)
    ctl.abort()
    await expect(p).rejects.toThrow(/aborted/)
  })

  it('超时报错', async () => {
    const fetch: FetchFn = (_u, init) =>
      new Promise((_res, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)))
    await expect(
      createWebTools({ fetch, fetchTimeoutMs: 30 }).fetchTool.execute('1', { url: 'https://e.com/' }),
    ).rejects.toThrow(/timed out/)
  })
})

describe('web_fetch 重定向的地址检查', () => {
  const PUBLIC = '93.184.216.34'
  /** 假 DNS：按主机名查表，没有的名字报 ENOTFOUND；记录被查过的名字 */
  function fakeLookup(table: Record<string, string[]>): { lookup: LookupFn; asked: string[] } {
    const asked: string[] = []
    const lookup: LookupFn = async host => {
      asked.push(host)
      const addrs = table[host]
      if (!addrs) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
      return addrs.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
    }
    return { lookup, asked }
  }
  /** 已批准的公网站点 ok.example 302 到 to；to 上放着「机密」，被拦截时不该被请求到 */
  const redirectTo = (to: string, table: Record<string, string[]> = {}) => {
    const { fetch, calls } = fakeFetch({ 'https://ok.example/': redirect(to), [to]: html('SECRET') })
    const { lookup } = fakeLookup({ 'ok.example': [PUBLIC], ...table })
    const p = createWebTools({ fetch, lookup }).fetchTool.execute('1', { url: 'https://ok.example/' })
    return { p, calls }
  }

  it('公网站点 302 到 127.0.0.1：拦截，不发请求', async () => {
    const { p, calls } = redirectTo('http://127.0.0.1/')
    await expect(p).rejects.toThrow(
      /^Blocked redirect to 127\.0\.0\.1: it resolves to a private or local address \(127\.0\.0\.1\)/,
    )
    expect(calls.map(c => c.url)).toEqual(['https://ok.example/'])
  })

  it('302 到云元数据 169.254.169.254：拦截', async () => {
    const { p } = redirectTo('http://169.254.169.254/latest/meta-data')
    await expect(p).rejects.toThrow(/Blocked redirect to 169\.254\.169\.254/)
  })

  it('302 到 IPv4 的别的写法（十六进制 / 十进制整数）：URL 归一化后同样拦截', async () => {
    await expect(redirectTo('http://0x7f.1/').p).rejects.toThrow(/Blocked redirect/)
    await expect(redirectTo('http://2130706433/').p).rejects.toThrow(/Blocked redirect/)
  })

  it('302 到域名但解析结果里混了内网地址：拦截', async () => {
    const { p, calls } = redirectTo('https://evil.example/', { 'evil.example': [PUBLIC, '10.0.0.5'] })
    await expect(p).rejects.toThrow(/Blocked redirect to evil\.example: .*\(10\.0\.0\.5\)/)
    expect(calls).toHaveLength(1)
  })

  it('302 到 [::ffff:127.0.0.1]：拦截', async () => {
    const { p } = redirectTo('http://[::ffff:127.0.0.1]/')
    await expect(p).rejects.toThrow(/Blocked redirect to \[::ffff:7f00:1\]/)
  })

  it('302 到 localhost 和 sub.localhost：不解析直接拦截', async () => {
    const t = { localhost: [PUBLIC], 'sub.localhost': [PUBLIC] } // 即使 DNS 说是公网也不信
    await expect(redirectTo('http://localhost/', t).p).rejects.toThrow(/Blocked redirect to localhost/)
    await expect(redirectTo('http://sub.localhost:8080/', t).p).rejects.toThrow(
      /Blocked redirect to sub\.localhost:8080/,
    )
  })

  it('第一跳 http://localhost:3000 不检查，同 host 的跳转（/ → /login）放行', async () => {
    const { fetch, calls } = fakeFetch({
      'http://localhost:3000/': redirect('/login'),
      'http://localhost:3000/login': html('<p>login</p>'),
    })
    const { lookup, asked } = fakeLookup({})
    const r = await createWebTools({ fetch, lookup }).fetchTool.execute('1', { url: 'http://localhost:3000/' })
    expect(textOf(r)).toContain('login')
    expect(calls).toHaveLength(2)
    expect(asked).toEqual([])
  })

  it('第一跳是内网 IP 也不检查；同 host 的 http ↔ https 放行', async () => {
    const { fetch } = fakeFetch({
      'http://192.168.1.5/': redirect('https://192.168.1.5/'),
      'https://192.168.1.5/': redirect('http://192.168.1.5:80/x'), // 默认端口被归一化掉，host 不变
      'http://192.168.1.5/x': html('<p>intranet</p>'),
    })
    const r = await createWebTools({ fetch, lookup: fakeLookup({}).lookup }).fetchTool.execute('1', {
      url: 'http://192.168.1.5/',
    })
    expect(textOf(r)).toContain('intranet')
  })

  it('同主机名不同端口（localhost:3000 → localhost:6379）：拦截', async () => {
    const { fetch, calls } = fakeFetch({
      'http://localhost:3000/': redirect('http://localhost:6379/'),
      'http://localhost:6379/': html('REDIS'),
    })
    await expect(
      createWebTools({ fetch, lookup: fakeLookup({}).lookup }).fetchTool.execute('1', {
        url: 'http://localhost:3000/',
      }),
    ).rejects.toThrow(/Blocked redirect to localhost:6379/)
    expect(calls).toHaveLength(1)
  })

  it('公网 → 公网放行，且只解析换了 host 的那一跳', async () => {
    const { fetch } = fakeFetch({
      'https://a.example/': redirect('https://b.example/x'),
      'https://b.example/x': html('<p>b</p>'),
    })
    const { lookup, asked } = fakeLookup({ 'b.example': [PUBLIC, '2606:4700::1111'] })
    const r = await createWebTools({ fetch, lookup }).fetchTool.execute('1', { url: 'https://a.example/' })
    expect(textOf(r)).toContain('URL: https://b.example/x')
    expect(asked).toEqual(['b.example'])
  })

  it('fake-ip 代理把域名解析成 198.18.0.7：算公网，放行', async () => {
    const { fetch } = fakeFetch({
      'https://a.example/': redirect('https://b.example/'),
      'https://b.example/': html('<p>fake-ip ok</p>'),
    })
    const { lookup } = fakeLookup({ 'b.example': ['198.18.0.7'] })
    const r = await createWebTools({ fetch, lookup }).fetchTool.execute('1', { url: 'https://a.example/' })
    expect(textOf(r)).toContain('fake-ip ok')
  })

  it('重定向目标解析失败：按拦截处理（验证不了就不放行），消息带错误码', async () => {
    const { p, calls } = redirectTo('https://nx.example/')
    await expect(p).rejects.toThrow(/^Blocked redirect to nx\.example: its address could not be verified \(ENOTFOUND\)/)
    expect(calls).toHaveLength(1)
  })

  it('解析返回空列表也拦截', async () => {
    const { p } = redirectTo('https://empty.example/', { 'empty.example': [] })
    await expect(p).rejects.toThrow(/could not be verified \(no addresses\)/)
  })

  it('重定向目标的解析一直不返回：照样按抓取超时结束', async () => {
    const { fetch } = fakeFetch({ 'https://ok.example/': redirect('https://slow.example/') })
    const lookup: LookupFn = () => new Promise(() => {})
    const p = createWebTools({ fetch, lookup, fetchTimeoutMs: 50 }).fetchTool.execute('1', {
      url: 'https://ok.example/',
    })
    await expect(p).rejects.toThrow(/timed out/)
  })
})

describe('web_search 辅助', () => {
  it('后端选择：SearXNG > Tavily > Brave > DuckDuckGo', () => {
    expect(pickBackend({})).toBe('duckduckgo')
    expect(pickBackend({ BRAVE_API_KEY: 'b' })).toBe('brave')
    expect(pickBackend({ BRAVE_API_KEY: 'b', TAVILY_API_KEY: 't' })).toBe('tavily')
    expect(pickBackend({ BRAVE_API_KEY: 'b', TAVILY_API_KEY: 't', PIXELSKY_SEARCH_URL: 'http://s' })).toBe('searxng')
    expect(pickBackend({ TAVILY_API_KEY: '  ' })).toBe('duckduckgo')
  })

  it('limit 夹到 1–10，缺省 5', () => {
    expect(clampLimit(undefined)).toBe(5)
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(-3)).toBe(1)
    expect(clampLimit(99)).toBe(10)
    expect(clampLimit(3.9)).toBe(3)
    expect(clampLimit(Number.NaN)).toBe(5)
  })

  it('DDG 跳转链接还原', () => {
    expect(unwrapDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fp%3Fq%3D1&amp;rut=abc')).toBe(
      'https://a.com/p?q=1',
    )
    expect(unwrapDdgUrl('https://plain.com/x')).toBe('https://plain.com/x')
  })
})

const DDG_HTML = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fone&amp;rut=1">First <b>Result</b> &amp; more</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fone">Snippet with <b>bold</b> text.</a>
</div>
<div class="result result--ad">
  <a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Ad title</a>
  <a class="result__snippet" href="x">Ad snippet</a>
</div>
<div class="result">
  <a class="result__a" href="https://b.com/two">Second</a>
  <div class="result__snippet">Second snippet</div>
</div>
<div class="result">
  <a class="result__a" href="https://c.com/three">Third no snippet</a>
</div>`

describe('parseDdgHtml', () => {
  it('解析标题、真实链接、摘要，跳过广告', () => {
    expect(parseDdgHtml(DDG_HTML)).toEqual([
      { title: 'First Result & more', url: 'https://a.com/one', snippet: 'Snippet with bold text.' },
      { title: 'Second', url: 'https://b.com/two', snippet: 'Second snippet' },
      { title: 'Third no snippet', url: 'https://c.com/three', snippet: '' },
    ])
  })
})

describe('web_search 工具', () => {
  it('DuckDuckGo：POST 表单，编号列表输出，details', async () => {
    const { fetch, calls } = fakeFetch({ 'https://html.duckduckgo.com/html/': () => new Response(DDG_HTML) })
    const r = await createWebTools({ fetch, env: {} }).searchTool.execute('1', { query: 'pixel sky', limit: 2 })
    expect(calls[0].init?.method).toBe('POST')
    expect(String(calls[0].init?.body)).toBe('q=pixel+sky')
    expect(textOf(r)).toBe(
      '1. First Result & more\n   https://a.com/one\n   Snippet with bold text.\n2. Second\n   https://b.com/two\n   Second snippet',
    )
    expect(r.details.backend).toBe('duckduckgo')
    expect(r.details.query).toBe('pixel sky')
    expect(r.details.results).toHaveLength(2)
  })

  it('DuckDuckGo 反爬页给出明确提示', async () => {
    const { fetch } = fakeFetch({
      'https://html.duckduckgo.com/html/': () => new Response('<div class="anomaly-modal">captcha</div>'),
    })
    await expect(createWebTools({ fetch, env: {} }).searchTool.execute('1', { query: 'x' })).rejects.toThrow(
      /bot check/,
    )
  })

  it('Tavily：JSON POST，api_key/max_results，解析 content', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.tavily.com/search': () =>
        Response.json({
          results: [
            { title: 'T1', url: 'https://t.com/1', content: 'c1' },
            { title: 'T2', url: 'https://t.com/2', content: 'c2' },
          ],
        }),
    })
    const r = await createWebTools({ fetch, env: { TAVILY_API_KEY: 'k1', BRAVE_API_KEY: 'b' } }).searchTool.execute(
      '1',
      {
        query: 'q',
        limit: 20,
      },
    )
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ api_key: 'k1', query: 'q', max_results: 10 })
    expect(r.details.backend).toBe('tavily')
    expect(r.details.results).toEqual([
      { title: 'T1', url: 'https://t.com/1', snippet: 'c1' },
      { title: 'T2', url: 'https://t.com/2', snippet: 'c2' },
    ])
  })

  it('Brave：GET 带 token 头，description 去 HTML', async () => {
    const url = 'https://api.search.brave.com/res/v1/web/search?q=a%20b%26c&count=3'
    const { fetch, calls } = fakeFetch({
      [url]: () =>
        Response.json({
          web: { results: [{ title: 'B1', url: 'https://b.com/1', description: 'x <strong>y</strong> &amp; z' }] },
        }),
    })
    const r = await createWebTools({ fetch, env: { BRAVE_API_KEY: 'bk' } }).searchTool.execute('1', {
      query: 'a b&c',
      limit: 3,
    })
    expect((calls[0].init?.headers as Record<string, string>)['x-subscription-token']).toBe('bk')
    expect(r.details.backend).toBe('brave')
    expect(r.details.results[0]).toEqual({ title: 'B1', url: 'https://b.com/1', snippet: 'x y & z' })
  })

  it('SearXNG 覆盖：<base>/search?q=&format=json，截到 limit', async () => {
    const { fetch, calls } = fakeFetch({
      'http://localhost:8080/search?q=hello&format=json': () =>
        Response.json({
          results: [1, 2, 3].map(i => ({ title: `S${i}`, url: `https://s.com/${i}`, content: `c${i}` })),
        }),
    })
    const r = await createWebTools({
      fetch,
      env: { PIXELSKY_SEARCH_URL: 'http://localhost:8080/', TAVILY_API_KEY: 'k' },
    }).searchTool.execute('1', { query: 'hello', limit: 2 })
    expect(calls).toHaveLength(1)
    expect(r.details.backend).toBe('searxng')
    expect(r.details.results.map(x => x.title)).toEqual(['S1', 'S2'])
  })

  it('limit 缺省为 5', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://t.com/${i}`, content: '' }))
    const { fetch } = fakeFetch({ 'https://api.tavily.com/search': () => Response.json({ results: rows }) })
    const r = await createWebTools({ fetch, env: { TAVILY_API_KEY: 'k' } }).searchTool.execute('1', { query: 'q' })
    expect(r.details.results).toHaveLength(5)
  })

  it('没有结果时明说', async () => {
    const { fetch } = fakeFetch({ 'https://api.tavily.com/search': () => Response.json({ results: [] }) })
    const r = await createWebTools({ fetch, env: { TAVILY_API_KEY: 'k' } }).searchTool.execute('1', { query: 'zzz' })
    expect(textOf(r)).toBe('No results found for "zzz" (backend: tavily).')
    expect(r.details.results).toEqual([])
  })

  it('HTTP 错误、空查询、网络错误、中止', async () => {
    const { fetch } = fakeFetch({ 'https://api.tavily.com/search': () => new Response('no', { status: 401 }) })
    const tool = createWebTools({ fetch, env: { TAVILY_API_KEY: 'k' } }).searchTool
    await expect(tool.execute('1', { query: 'q' })).rejects.toThrow('Search (tavily) failed: HTTP 401')
    await expect(tool.execute('2', { query: '  ' })).rejects.toThrow(/non-empty/)
    const down = createWebTools({ fetch: fakeFetch({}).fetch, env: {} }).searchTool
    await expect(down.execute('3', { query: 'q' })).rejects.toThrow('Search (duckduckgo) failed: ENOTFOUND')
    const hang: FetchFn = (_u, init) =>
      new Promise((_r, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)))
    const ctl = new AbortController()
    const p = createWebTools({ fetch: hang, env: {} }).searchTool.execute('4', { query: 'q' }, ctl.signal)
    ctl.abort()
    await expect(p).rejects.toThrow(/aborted/)
  })
})

describe('webExtension', () => {
  it('注册 web_fetch 和 web_search', () => {
    const names: string[] = []
    void webExtension({ registerTool: (t: { name: string }) => void names.push(t.name) } as unknown as ExtensionAPI)
    expect(names).toEqual(['web_fetch', 'web_search'])
  })
})
