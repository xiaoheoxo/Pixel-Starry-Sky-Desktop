import { expect, it } from 'vitest'
import { changedDiffDigits } from './DiffStat'

it('jumps only the digits that changed', () => {
  expect(changedDiffDigits('96', '97')).toEqual([1])
  expect(changedDiffDigits('96', '96')).toEqual([])
  expect(changedDiffDigits('99', '100')).toEqual([0, 1, 2])
})

it('aligns by place value when a count gains or loses digits', () => {
  expect(changedDiffDigits('19', '119')).toEqual([0])
  expect(changedDiffDigits('109', '9')).toEqual([])
  expect(changedDiffDigits('21', '0')).toEqual([0])
})
