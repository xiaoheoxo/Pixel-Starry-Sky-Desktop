// PATH 目录预热（docs/memory-tier3.md §1）：检测前异步 stat 一遍，没回应的目录同步查找先跳过，回来后放开
import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTmp, removeTmp } from './helpers/tmp'

/** 卡住的目录：stat 一直不回，直到测试调 release */
const hung = new Map<string, () => void>()
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: (p: string) => {
      const key = String(p).toLowerCase()
      if (!hung.has(key)) return actual.stat(p)
      return new Promise((resolve, reject) => hung.set(key, () => actual.stat(p).then(resolve, reject)))
    },
  }
})

const { dirsOnPath, findOnPath, resetPathWarm, resolveCommand, timedLookup, warmPath } = await import('../src/exec')

const NAME = process.platform === 'win32' ? 'tool.exe' : 'tool'

function setup(): { root: string; a: string; b: string; env: NodeJS.ProcessEnv } {
  const root = makeTmp('path-warm')
  const a = join(root, 'a'),
    b = join(root, 'b')
  for (const dir of [a, b]) {
    mkdirSync(dir)
    writeFileSync(join(dir, NAME), '')
  }
  return { root, a, b, env: { PATH: [a, b].join(delimiter) } }
}

afterEach(() => {
  hung.clear()
  resetPathWarm()
})

describe('PATH 目录预热', () => {
  it('目录都正常时什么都不跳过', async () => {
    const { root, a, b, env } = setup()
    try {
      await warmPath(env)
      expect(findOnPath(NAME, env)).toBe(join(a, NAME))
      expect(dirsOnPath(NAME, env)).toEqual([a, b])
    } finally {
      removeTmp(root)
    }
  })

  it('超时没回应的目录先跳过，stat 回来以后放开', async () => {
    const { root, a, b, env } = setup()
    try {
      hung.set(a.toLowerCase(), () => undefined)
      await warmPath(env, 30)
      expect(findOnPath(NAME, env)).toBe(join(b, NAME))
      expect(dirsOnPath(NAME, env)).toEqual([b])
      const r = resolveCommand('tool', env)
      // 不是 Windows 时测试文件没有执行权限，算 script，路径照样有
      expect('path' in r ? r.path : null).toBe(join(b, NAME))
      // 再预热一次：卡住的 stat 不重复发，仍然跳过
      await warmPath(env, 30)
      expect(dirsOnPath(NAME, env)).toEqual([b])
      // 卡住的那个回来了
      hung.get(a.toLowerCase())!()
      await vi.waitFor(() => expect(findOnPath(NAME, env)).toBe(join(a, NAME)))
    } finally {
      removeTmp(root)
    }
  })

  it('不存在的目录不算没回应', async () => {
    const { root, b } = setup()
    try {
      const env = { PATH: [join(root, 'missing'), b].join(delimiter) }
      await warmPath(env, 30)
      expect(dirsOnPath(NAME, env)).toEqual([b])
      expect(findOnPath(NAME, env)).toBe(join(b, NAME))
    } finally {
      removeTmp(root)
    }
  })

  it('timedLookup 原样返回结果和异常', () => {
    expect(timedLookup('claude', () => 42)).toBe(42)
    expect(() =>
      timedLookup('claude', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
  })
})
