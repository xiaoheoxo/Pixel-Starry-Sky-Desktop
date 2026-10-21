import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SecureStore, type Cipher } from './secure-store'

/** 假的系统加密：可以随时切换能不能用 */
function cipher(): Cipher & { on: boolean } {
  return {
    on: true,
    available() {
      return this.on
    },
    encrypt: text => 'enc:' + text,
    decrypt: text => {
      if (!text.startsWith('enc:')) throw new Error('bad')
      return text.slice(4)
    },
  }
}

let dir: string
let file: string
beforeEach(async () => {
  const scratch = resolve('../../scratch')
  await mkdir(scratch, { recursive: true })
  dir = await mkdtemp(join(scratch, 'secure-store-'))
  file = join(dir, 'secrets.bin')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8').slice(4)) as Record<string, unknown>

describe('SecureStore', () => {
  it('启动时系统加密不可用、之后能用了：先读出旧文件合并再写，不把旧凭据覆盖掉', () => {
    writeFileSync(file, 'enc:' + JSON.stringify({ old: { key: '1' } }))
    const c = cipher()
    c.on = false
    const store = new SecureStore(file, c)
    expect(store.get('old')).toBeUndefined()
    // 不可用时只放内存
    store.set('mem', { key: '2' })
    expect(onDisk()).toEqual({ old: { key: '1' } })
    c.on = true
    store.set('new', { key: '3' })
    expect(onDisk()).toEqual({ old: { key: '1' }, mem: { key: '2' }, new: { key: '3' } })
    expect(store.get('old')).toEqual({ key: '1' })
  })

  it('之后补读时解不开：先备份原文件再写', async () => {
    writeFileSync(file, '坏的')
    const c = cipher()
    c.on = false
    const store = new SecureStore(file, c)
    c.on = true
    store.set('new', { key: '3' })
    expect(store.warning).not.toBeNull()
    const backups = (await readdir(dir)).filter(n => n.includes('.unreadable-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]), 'utf8')).toBe('坏的')
    expect(onDisk()).toEqual({ new: { key: '3' } })
  })

  it('没有旧文件：加密能用后照常写', () => {
    const c = cipher()
    c.on = false
    const store = new SecureStore(file, c)
    store.set('a', { key: '1' })
    expect(existsSync(file)).toBe(false)
    c.on = true
    store.set('b', { key: '2' })
    expect(onDisk()).toEqual({ a: { key: '1' }, b: { key: '2' } })
  })
})
