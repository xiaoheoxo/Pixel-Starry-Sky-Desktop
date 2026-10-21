import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  claudePlanFor,
  claudePlanWithTier,
  readClaudeTier,
  tierFromCredentialsText,
  tierMultiplier,
} from '../src/claude/tier'

// 和 Claude Code 2.1.303 写的凭据文件同样的结构（令牌是假的）
const CREDS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-' + 'x'.repeat(90),
    refreshToken: 'sk-ant-ort01-' + 'y'.repeat(90),
    expiresAt: 1792560605000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  },
})

const root = resolve(__dirname, '..', '..', '..', 'scratch', `claude-tier-test-${process.pid}`)
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('tierFromCredentialsText', () => {
  it('只取档位字段', () => {
    expect(tierFromCredentialsText(CREDS)).toEqual({ rateLimitTier: 'default_claude_max_20x', seatTier: null })
    expect(tierFromCredentialsText('{"seatTier": "premium"}')).toEqual({ rateLimitTier: null, seatTier: 'premium' })
  })

  it('没有档位、值不像档位（太长、带别的字符）都不认', () => {
    expect(tierFromCredentialsText('{"claudeAiOauth":{"subscriptionType":"pro"}}')).toBeNull()
    expect(tierFromCredentialsText(`{"rateLimitTier":"${'a'.repeat(65)}"}`)).toBeNull()
    expect(tierFromCredentialsText('{"rateLimitTier":"a b"}')).toBeNull()
    expect(tierFromCredentialsText('')).toBeNull()
  })
})

describe('倍数和套餐值', () => {
  it('tierMultiplier', () => {
    expect(tierMultiplier({ rateLimitTier: 'default_claude_max_5x', seatTier: null })).toBe(5)
    expect(tierMultiplier({ rateLimitTier: 'default_claude_max_20x', seatTier: null })).toBe(20)
    expect(tierMultiplier({ rateLimitTier: 'default_claude_ai', seatTier: 'premium' })).toBe(5)
    expect(tierMultiplier({ rateLimitTier: 'default_claude_ai', seatTier: null })).toBeNull()
    expect(tierMultiplier(null)).toBeNull()
  })

  it('max / team 带上倍数，其余原样', () => {
    const t20 = { rateLimitTier: 'default_claude_max_20x', seatTier: null }
    expect(claudePlanWithTier('max', t20)).toBe('max_20x')
    expect(claudePlanWithTier('max', { rateLimitTier: 'default_claude_max_5x', seatTier: null })).toBe('max_5x')
    expect(claudePlanWithTier('team', { rateLimitTier: null, seatTier: 'premium' })).toBe('team_5x')
    expect(claudePlanWithTier('pro', t20)).toBe('pro')
    expect(claudePlanWithTier('max', null)).toBe('max')
    expect(claudePlanWithTier(null, t20)).toBeNull()
    expect(claudePlanWithTier(undefined, t20)).toBeNull()
  })
})

describe('readClaudeTier', () => {
  it('读配置目录里的凭据文件；macOS、没有文件为 null', () => {
    const dir = join(root, 'acct')
    mkdirSync(dir, { recursive: true })
    expect(readClaudeTier(dir, 'win32')).toBeNull()
    writeFileSync(join(dir, '.credentials.json'), CREDS)
    expect(readClaudeTier(dir, 'win32')?.rateLimitTier).toBe('default_claude_max_20x')
    expect(readClaudeTier(dir, 'linux')?.rateLimitTier).toBe('default_claude_max_20x')
    expect(readClaudeTier(dir, 'darwin')).toBeNull()
  })

  it('claudePlanFor 跟着 CLAUDE_CONFIG_DIR 走', () => {
    const dir = join(root, 'acct2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.credentials.json'), CREDS.replace('max_20x', 'max_5x'))
    const expected = process.platform === 'darwin' ? 'max' : 'max_5x'
    expect(claudePlanFor('max', { CLAUDE_CONFIG_DIR: dir })).toBe(expected)
  })
})
