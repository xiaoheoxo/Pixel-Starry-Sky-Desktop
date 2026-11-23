import { describe, expect, it } from 'vitest'
import type { ArtifactFile, ArtifactTurn } from '@pixelsky/protocol'
import { FOCUS_MS, findFocusFile, findFocusTurn, freshFocus, turnKey } from './focus'

const turn = (sessionId: string, userItemId: string | null, at = 1): ArtifactTurn => ({
  sessionId,
  title: 't',
  engine: 'claude',
  archived: false,
  userItemId,
  prompt: '',
  at,
  files: [],
})

describe('findFocusTurn', () => {
  const turns = [turn('s1', null), turn('s1', 'u1'), turn('s2', 'u1')]
  it('按会话和用户消息找', () => {
    expect(findFocusTurn(turns, { sessionId: 's1', userItemId: 'u1' })).toBe(turns[1])
    expect(findFocusTurn(turns, { sessionId: 's2', userItemId: 'u1' })).toBe(turns[2])
  })
  it('null 对应会话开头的改动', () => {
    expect(findFocusTurn(turns, { sessionId: 's1', userItemId: null })).toBe(turns[0])
  })
  it('找不到时为 null', () => {
    expect(findFocusTurn(turns, { sessionId: 's3', userItemId: 'u1' })).toBeNull()
    expect(findFocusTurn(turns, { sessionId: 's2', userItemId: null })).toBeNull()
  })
})

describe('findFocusFile', () => {
  const file = (path: string, absolute: string, local: string | null = path): ArtifactFile => ({
    path,
    absolute,
    inside: true,
    local,
    kind: 'update',
    added: 1,
    removed: 0,
    itemId: 'edit',
    itemIds: ['edit'],
  })
  it('Windows 路径不分斜杠和大小写，不按文件名猜', () => {
    const first = file('srcA/Settings.java', 'C:\\project\\srcA\\Settings.java')
    const second = file('srcB/Settings.java', 'C:\\project\\srcB\\Settings.java')
    const target = { ...turn('s', 'u'), files: [first, second] }
    expect(findFocusFile(target, 'srcb\\settings.java')).toBe(second)
    expect(findFocusFile(target, 'c:/project/srcA/settings.java')).toBe(first)
    expect(findFocusFile(target, 'Settings.java')).toBeNull()
  })
  it('Linux 路径分大小写；记录里是绝对路径也能用相对路径对上', () => {
    const selected = file('/project/settings.java', '/project/settings.java', 'settings.java')
    const target = { ...turn('s', null), files: [file('Settings.java', '/project/Settings.java'), selected] }
    expect(findFocusFile(target, './settings.java')).toBe(selected)
    expect(findFocusFile(target, 'SETTINGS.java')).toBeNull()
  })
})

describe('freshFocus', () => {
  it('过期的请求不再处理', () => {
    const focus = { sessionId: 's', userItemId: null, token: 1, at: 0 }
    expect(freshFocus(focus, FOCUS_MS - 1)).toBe(true)
    expect(freshFocus(focus, FOCUS_MS)).toBe(false)
    expect(freshFocus(null)).toBe(false)
  })
})

describe('turnKey', () => {
  it('会话开头用 start', () => {
    expect(turnKey(turn('s1', null, 5))).toBe('s1:start:5')
    expect(turnKey(turn('s1', 'u1', 5))).toBe('s1:u1:5')
  })
})
