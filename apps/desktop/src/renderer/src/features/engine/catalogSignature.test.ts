import { describe, expect, it } from 'vitest'
import type { EngineInfo } from '@pixelsky/protocol'
import { catalogSignature } from './catalogSignature'

const info = (patch: Partial<EngineInfo> = {}) =>
  ({
    id: 'claude',
    name: 'Claude Code',
    short: 'Cc',
    status: 'ready',
    version: '2.1.289',
    path: 'C:/claude.exe',
    message: null,
    ...patch,
  }) as EngineInfo

describe('catalogSignature', () => {
  it('引擎信息换了新对象但内容没变：签名不变', () => {
    expect(catalogSignature(info(), undefined)).toBe(catalogSignature({ ...info() }, undefined))
  })

  it('无关字段（message）变了不触发重新请求', () => {
    expect(catalogSignature(info({ message: 'x' }), undefined)).toBe(catalogSignature(info(), undefined))
  })

  it('版本 / 状态 / 启动方式变了签名变', () => {
    const base = catalogSignature(info(), undefined)
    expect(catalogSignature(info({ version: '2.2.0' }), undefined)).not.toBe(base)
    expect(catalogSignature(info({ status: 'unauthenticated' }), undefined)).not.toBe(base)
    expect(catalogSignature(info({ launchError: 'bad arg' }), undefined)).not.toBe(base)
  })

  it('本机配置的启动参数变了签名变', () => {
    const cfg = (args: string[]) => ({ path: null, args, env: {} }) as never
    expect(catalogSignature(info(), cfg(['--a']))).not.toBe(catalogSignature(info(), cfg([])))
  })
  it('授权方式 / 账号变了、或重新检测过，签名变', () => {
    const base = catalogSignature(info(), undefined)
    expect(catalogSignature(info({ auth: { kind: 'apiKey' } }), undefined)).not.toBe(base)
    expect(catalogSignature(info({ account: { email: 'a@b.c' } }), undefined)).not.toBe(base)
    expect(catalogSignature(info(), undefined, 1)).not.toBe(base)
  })
})
