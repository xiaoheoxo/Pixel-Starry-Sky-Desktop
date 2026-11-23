import { expect, it } from 'vitest'
import { changedDigits } from './BouncingDiffStat'

it('只有变了的那几位跳；多一位、少一位时按个位对齐', () => {
  expect(changedDigits('96', '97')).toEqual([1])
  expect(changedDigits('96', '96')).toEqual([])
  expect(changedDigits('99', '100')).toEqual([0, 1, 2])
  expect(changedDigits('19', '119')).toEqual([0])
  expect(changedDigits('109', '9')).toEqual([])
  expect(changedDigits('21', '0')).toEqual([0])
})
