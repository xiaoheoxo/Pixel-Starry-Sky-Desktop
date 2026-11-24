import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RepeatFilter } from './repeat'

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

it('一分钟内同样的只写一遍，过后补次数；不同的照写；窗口过了重新写', () => {
  const lines: string[] = []
  const write = (line: string): void => void lines.push(line)
  const filter = new RepeatFilter()
  for (let i = 0; i < 3; i++) filter.write('a', write)
  filter.write('b', write)
  expect(lines).toEqual(['a', 'b'])
  vi.advanceTimersByTime(60_000)
  expect(lines).toEqual(['a', 'b', '同样的内容又出现 2 次：a'])
  filter.write('a', write)
  expect(lines.at(-1)).toBe('a')
})
