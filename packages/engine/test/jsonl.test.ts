import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { LineSplitter, readJsonLines } from '../src/jsonl'

describe('readJsonLines', () => {
  it('一行被切成很多块、多行挤在一块、结尾没有换行都能读对', async () => {
    const stream = new PassThrough()
    const got: unknown[] = []
    const bad: string[] = []
    readJsonLines(
      stream,
      m => got.push(m),
      l => bad.push(l),
    )
    const big = JSON.stringify({ text: 'x'.repeat(5000) })
    for (let i = 0; i < big.length; i += 700) stream.write(big.slice(i, i + 700))
    stream.write('\n{"a":1}\nnot json\n{"b":')
    stream.write('2}\n{"c":3}')
    const ended = new Promise(resolve => stream.on('end', resolve))
    stream.end()
    await ended
    expect(got).toEqual([{ text: 'x'.repeat(5000) }, { a: 1 }, { b: 2 }, { c: 3 }])
    expect(bad).toEqual(['not json'])
  })
})

describe('LineSplitter', () => {
  it('大行跨很多块、同一块里还挤着下一行的开头', () => {
    const s = new LineSplitter()
    const big = 'y'.repeat(100_000)
    const out: string[] = []
    for (let i = 0; i < big.length; i += 700) out.push(...s.push(big.slice(i, i + 700)))
    expect(out).toEqual([])
    expect(s.pending).toBe(big.length)
    expect(s.push('tail\nnext1\nne')).toEqual([big + 'tail', 'next1'])
    expect(s.pending).toBe(2)
    expect(s.push('xt2')).toEqual([])
    expect(s.end()).toBe('next2')
    expect(s.pending).toBe(0)
  })
  it('行尾 CR 落在上一块末尾时拼成整行后仍在行尾', () => {
    const s = new LineSplitter()
    expect(s.push('{"a":1}\r')).toEqual([])
    expect(s.push('\n')).toEqual(['{"a":1}\r'])
  })
})
