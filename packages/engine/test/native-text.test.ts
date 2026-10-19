import { describe, expect, it } from 'vitest'
import { NATIVE_TEXT } from '../src/native/text'

// 提示文字加了引擎名参数后，Claude 的句子必须和改之前一字不差（界面按中文原句查英文）
describe('NATIVE_TEXT 带引擎名', () => {
  const CC = 'Claude Code'
  it('divider', () => {
    expect(NATIVE_TEXT.divider('terminal', false, 3, 0, CC)).toBe('接着终端里的 Claude Code 会话 · 3 轮')
    expect(NATIVE_TEXT.divider('other', false, 3, 0, CC)).toBe('接着 Claude Code 会话（来自其他程序）· 3 轮')
    expect(NATIVE_TEXT.divider('terminal', true, 3, 0, CC)).toBe(
      '复制了终端里的 Claude Code 会话 · 3 轮（原会话不动，两边可以同时用）',
    )
    expect(NATIVE_TEXT.divider('other', true, 3, 2, CC)).toBe(
      '复制了其他程序的 Claude Code 会话 · 3 轮（原会话不动，两边可以同时用）（更早的 2 轮没有显示）',
    )
    expect(NATIVE_TEXT.divider('terminal', false, 3, 2)).toBe(NATIVE_TEXT.divider('terminal', false, 3, 2, CC))
  })
  it('recreated', () => {
    expect(NATIVE_TEXT.recreated(2, CC)).toBe(
      'Claude Code 的会话记录不在了，已把像素星空里的聊天（2 轮）写进新的引擎会话（工具调用和文件改动没有带过去）',
    )
  })
  it('newer', () => {
    expect(NATIVE_TEXT.newer(1)).toBe('这个会话在终端里又聊了 1 轮，显示里还没有')
  })
})
