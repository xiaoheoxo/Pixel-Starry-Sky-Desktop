import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeWindowFile, readWindowFile } from './windowFile'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wf-'))
  dirs.push(d)
  return join(d, 'window.json')
}
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))

describe('window.json 合并写入', () => {
  it('只改自己的字段，别的字段保留', () => {
    const f = tmp()
    writeFileSync(f, JSON.stringify({ closeToTray: false, hintShown: true, windowState: { x: 1 } }))
    mergeWindowFile(f, { closeToTray: true, hintShown: true })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ closeToTray: true, hintShown: true, windowState: { x: 1 } })
  })

  it('文件不存在或损坏：当空对象，写入后可读', () => {
    const f = tmp()
    expect(readWindowFile(f)).toEqual({})
    writeFileSync(f, '{oops')
    mergeWindowFile(f, { a: 1 })
    expect(readWindowFile(f)).toEqual({ a: 1 })
  })

  it('内容是数组时当作空', () => {
    const f = tmp()
    writeFileSync(f, '[1]')
    expect(readWindowFile(f)).toEqual({})
  })

  it('原子写：残留的临时文件不影响写入，写完不留临时文件', () => {
    const f = tmp()
    writeFileSync(f, JSON.stringify({ keep: 1 }))
    writeFileSync(`${f}.tmp`, '{半截')
    mergeWindowFile(f, { a: 2 })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ keep: 1, a: 2 })
    expect(existsSync(`${f}.tmp`)).toBe(false)
  })

  it('临时文件写不了（同名目录占位）：退回直接写，内容不丢', () => {
    const f = tmp()
    writeFileSync(f, JSON.stringify({ keep: 1 }))
    mkdirSync(`${f}.tmp`)
    mergeWindowFile(f, { a: 2 })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ keep: 1, a: 2 })
  })
})
