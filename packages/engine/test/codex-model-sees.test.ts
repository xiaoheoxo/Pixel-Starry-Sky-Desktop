import { describe, expect, it } from 'vitest'
import type { EngineCatalog } from '@pixelsky/protocol'
import { codexModelSees } from '../src/codex/catalog'

const model = (id: string, inputModalities: string[]) => ({
  id,
  label: id,
  efforts: [],
  defaultEffort: null,
  inputModalities,
  isDefault: false,
})
const catalog: EngineCatalog = {
  outputStyles: [],
  currentOutputStyle: null,
  models: [model('gpt-6.1-sol', ['text', 'image']), model('text-only', ['text'])],
  currentModel: 'gpt-6.1-sol',
}

describe('codexModelSees', () => {
  it('自己登录的会话按 Codex 目录', () => {
    expect(codexModelSees(catalog, 'gpt-6.1-sol', false)).toBe(true)
    expect(codexModelSees(catalog, 'text-only', false)).toBe(false)
  })

  it('目录里没有这个模型（本机 Codex 旧、自定义接口）不拦', () => {
    expect(codexModelSees(catalog, 'gpt-7-new', false)).toBe(true)
    expect(codexModelSees(null, 'gpt-6.1-sol', false)).toBe(true)
  })

  it('平台会话按平台的模型资料，不看 Codex 目录', () => {
    // 本机 Codex 目录里没有、或标成只收文字，平台资料能看图就放行
    expect(codexModelSees(null, 'gpt-6.1-sol', true)).toBe(true)
    expect(codexModelSees(catalog, 'text-only', true)).toBe(true)
    // 内置模型表里只收文字的模型照样拦
    expect(codexModelSees(catalog, 'deepseek-v4-pro', true)).toBe(false)
  })
})
