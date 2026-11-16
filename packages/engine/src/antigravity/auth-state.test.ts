// agy 记住的 Key 登录（auth-state.ts，docs/antigravity-engine.md §13 问题 2）
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpError, ACP_AUTH_REQUIRED } from '../acp/connection'
import { readFileSync } from 'node:fs'
import { agyAuthStatePath, forgetKeyAuth, keyAuthCameBack, rememberKeyAuth } from './auth-state'

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function home(state: string | null): { home: string; file: string } {
  const h = mkdtempSync(join(tmpdir(), 'agy-home-'))
  homes.push(h)
  const file = agyAuthStatePath(h)
  if (state !== null) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, state)
  }
  return { home: h, file }
}

describe('forgetKeyAuth', () => {
  it('回归：平台会话按 Key 认证过，之后不带 Key 启动前清掉记录，agy 回到自己的 Google 登录', () => {
    const h = home('{"methodId":"gemini-api-key"}')
    expect(forgetKeyAuth({}, h.home)).toBe(true)
    expect(existsSync(h.file)).toBe(false)
  })
  it('这次带 Key（平台线路、用户自己填的 Key）不动', () => {
    const h = home('{"methodId":"gemini-api-key"}')
    expect(forgetKeyAuth({ GEMINI_API_KEY: 'k' }, h.home)).toBe(false)
    expect(existsSync(h.file)).toBe(true)
  })
  it('记的是别的登录方式、没有记录、内容坏了都不动', () => {
    const other = home('{"methodId":"oauth-personal"}')
    expect(forgetKeyAuth({}, other.home)).toBe(false)
    expect(existsSync(other.file)).toBe(true)
    expect(forgetKeyAuth({}, home(null).home)).toBe(false)
    const bad = home('not json')
    expect(forgetKeyAuth({}, bad.home)).toBe(false)
    expect(existsSync(bad.file)).toBe(true)
  })
  it('用户目录按启动 agy 的 env 认', () => {
    const h = home('{"methodId":"gemini-api-key"}')
    expect(forgetKeyAuth({ USERPROFILE: h.home, HOME: h.home })).toBe(true)
    expect(existsSync(h.file)).toBe(false)
  })
})

describe('rememberKeyAuth', () => {
  it('回归：终端带 Key 启动前记上「按 Key 登录」（没有记录、记的是别的都改成 Key）', () => {
    for (const state of [null, '{"methodId":"oauth-personal"}', 'bad']) {
      const h = home(state)
      rememberKeyAuth({ GEMINI_API_KEY: 'k' }, h.home)
      expect(JSON.parse(readFileSync(h.file, 'utf8'))).toEqual({ methodId: 'gemini-api-key' })
    }
  })
  it('不带 Key 不写', () => {
    const h = home(null)
    rememberKeyAuth({}, h.home)
    expect(existsSync(h.file)).toBe(false)
  })
})

describe('keyAuthCameBack', () => {
  const auth = new AcpError(ACP_AUTH_REQUIRED, 'Authentication required')
  it('需要认证、而记录又出现了（同时启动的平台会话写回去的）：清掉，值得重试', () => {
    const h = home('{"methodId":"gemini-api-key"}')
    expect(keyAuthCameBack(auth, {}, h.home)).toBe(true)
    expect(existsSync(h.file)).toBe(false)
  })
  it('真的没登录（没有记录）、别的错误、这次带 Key：不重试', () => {
    expect(keyAuthCameBack(auth, {}, home(null).home)).toBe(false)
    const h = home('{"methodId":"gemini-api-key"}')
    expect(keyAuthCameBack(new Error('boom'), {}, h.home)).toBe(false)
    expect(keyAuthCameBack(auth, { GEMINI_API_KEY: 'k' }, h.home)).toBe(false)
    expect(existsSync(h.file)).toBe(true)
  })
})
