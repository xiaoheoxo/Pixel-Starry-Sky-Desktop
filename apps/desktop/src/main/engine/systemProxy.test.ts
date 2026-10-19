// 系统代理补给本机引擎：解析 Chromium 的代理结果、开关、状态（main/engine/systemProxy.ts）
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SystemProxy, envHasProxy, parseProxyRule } from './systemProxy'

describe('parseProxyRule', () => {
  it('取第一个 HTTP / HTTPS 代理', () => {
    expect(parseProxyRule('PROXY 127.0.0.1:7890; DIRECT')).toEqual({ kind: 'http', url: 'http://127.0.0.1:7890' })
    expect(parseProxyRule('HTTPS proxy.example:443')).toEqual({ kind: 'http', url: 'https://proxy.example:443' })
    expect(parseProxyRule('SOCKS5 127.0.0.1:7891; PROXY 127.0.0.1:7890')).toEqual({
      kind: 'http',
      url: 'http://127.0.0.1:7890',
    })
  })
  it('只有 SOCKS：报出来但不当成可用的代理', () => {
    expect(parseProxyRule('SOCKS5 127.0.0.1:7891; DIRECT')).toEqual({ kind: 'socks', server: '127.0.0.1:7891' })
  })
  it('直连、空、写坏的都算没开代理；DIRECT 排在前面时后面的不看', () => {
    expect(parseProxyRule('DIRECT')).toBeNull()
    expect(parseProxyRule('')).toBeNull()
    expect(parseProxyRule('PROXY')).toBeNull()
    expect(parseProxyRule('DIRECT; PROXY 127.0.0.1:7890')).toBeNull()
  })
})

describe('envHasProxy', () => {
  it('大小写都认', () => {
    expect(envHasProxy({ https_proxy: 'x' })).toBe(true)
    expect(envHasProxy({ ALL_PROXY: 'x' })).toBe(true)
    expect(envHasProxy({ NO_PROXY: 'x', PATH: 'y' })).toBe(false)
  })
})

describe('SystemProxy', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const make = (rules: Record<string, string>, env: NodeJS.ProcessEnv = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'pixelsky-proxy-'))
    dirs.push(dir)
    const logs: string[] = []
    const proxy = new SystemProxy({
      resolve: async url => rules[new URL(url).hostname] ?? 'DIRECT',
      dir,
      env,
      log: m => logs.push(m),
    })
    return { proxy, dir, logs }
  }

  it('按每个引擎要连的地址查（PAC 可能分网站给代理）', async () => {
    const { proxy } = make({ 'api.anthropic.com': 'PROXY 127.0.0.1:7890' })
    expect(proxy.forEngine('claude')).toBeNull()
    await proxy.refresh()
    expect(proxy.forEngine('claude')).toBe('http://127.0.0.1:7890')
    expect(proxy.forEngine('pixel')).toBe('http://127.0.0.1:7890')
    expect(proxy.forEngine('codex')).toBeNull()
    expect(proxy.status()).toEqual({ enabled: true, proxy: 'http://127.0.0.1:7890', socks: null, envSet: false })
  })

  it('关掉后不补，开关存在文件里，下次启动沿用', async () => {
    const { proxy, dir } = make({ 'api.anthropic.com': 'PROXY 127.0.0.1:7890' })
    await proxy.refresh()
    expect(proxy.setEnabled(false).enabled).toBe(false)
    expect(proxy.forEngine('claude')).toBeNull()
    expect(JSON.parse(readFileSync(join(dir, 'system-proxy.json'), 'utf8'))).toEqual({ enabled: false })
    const again = new SystemProxy({ resolve: async () => 'PROXY 127.0.0.1:7890', dir })
    await again.refresh()
    expect(again.forEngine('claude')).toBeNull()
  })

  it('只有 SOCKS 时不补，状态里报出来；系统环境里设了代理变量时状态说明按用户的', async () => {
    const { proxy } = make({ 'api.anthropic.com': 'SOCKS5 127.0.0.1:7891' }, { HTTPS_PROXY: 'http://corp:8080' })
    await proxy.refresh()
    expect(proxy.forEngine('claude')).toBeNull()
    expect(proxy.status()).toEqual({ enabled: true, proxy: null, socks: '127.0.0.1:7891', envSet: true })
  })

  it('查询出错按没开代理；代理变化时才写日志', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixelsky-proxy-'))
    dirs.push(dir)
    const logs: string[] = []
    let rule: string | Error = 'PROXY 127.0.0.1:7890'
    const proxy = new SystemProxy({
      resolve: async () => {
        if (rule instanceof Error) throw rule
        return rule
      },
      dir,
      log: m => logs.push(m),
    })
    await proxy.refresh()
    await proxy.refresh()
    rule = new Error('boom')
    await proxy.refresh()
    expect(proxy.forEngine('claude')).toBeNull()
    expect(logs).toEqual(['系统代理', '系统没开代理'])
  })
})
