import { describe, expect, it } from 'vitest'
import type { CheckItem } from '../../../../shared/types/machines'
import { itemView, requiredReady, sortCheckItems } from './wslCheckModel'

const item = (key: CheckItem['key'], status: CheckItem['status'], required: boolean, extra: Partial<CheckItem> = {}) =>
  ({ key, status, required, detail: '', ...extra }) as CheckItem

describe('sortCheckItems', () => {
  it('按固定顺序排，不改原数组', () => {
    const input = [item('login', 'info', false), item('start', 'ok', true), item('node', 'ok', true)]
    expect(sortCheckItems(input).map(i => i.key)).toEqual(['start', 'node', 'login'])
    expect(input[0].key).toBe('login')
  })
})

describe('requiredReady', () => {
  it('必需项都过了', () => {
    expect(requiredReady([item('start', 'ok', true), item('node', 'ok', true), item('codex', 'warn', false)])).toBe(
      true,
    )
  })
  it('必需项没过或没有结果', () => {
    expect(requiredReady([item('start', 'ok', true), item('node', 'fail', true)])).toBe(false)
    expect(requiredReady([])).toBe(false)
  })
})

describe('itemView', () => {
  it('WSL_HOME_EMPTY 有短说明和原因', () => {
    const view = itemView(item('start', 'fail', true, { code: 'WSL_HOME_EMPTY' }))
    expect(view.short).not.toBeNull()
    expect(view.reason).not.toBeNull()
  })
  it('通过的项右侧显示 detail', () => {
    expect(itemView(item('claude', 'ok', false, { detail: '2.1.299' }))).toMatchObject({
      short: { text: '2.1.299' },
      line: null,
      reason: null,
      fix: null,
    })
  })
  it('node 太旧：短说明带版本，原因和命令', () => {
    expect(
      itemView(item('node', 'fail', true, { code: 'NODE_OLD', detail: '18.19.0', fix: 'fnm install 22' })),
    ).toEqual({
      label: 'wsl.item.node',
      status: 'fail',
      short: { key: 'wsl.short.NODE_OLD', params: { version: '18.19.0' } },
      line: null,
      reason: 'wsl.reason.NODE_OLD',
      fix: 'fnm install 22',
    })
  })
  it('Pixel 引擎：排在 Codex 后面；node 不够新时短说明带版本，原因和命令', () => {
    const input = [item('login', 'info', false), item('pixel', 'ok', false), item('codex', 'warn', false)]
    expect(sortCheckItems(input).map(i => i.key)).toEqual(['codex', 'pixel', 'login'])
    expect(
      itemView(item('pixel', 'warn', false, { code: 'PIXEL_NODE_OLD', detail: '22.11.0', fix: 'fnm install 22' })),
    ).toEqual({
      label: 'wsl.item.pixel',
      status: 'warn',
      short: { key: 'wsl.short.PIXEL_NODE_OLD', params: { version: '22.11.0' } },
      line: null,
      reason: 'wsl.reason.PIXEL_NODE_OLD',
      fix: 'fnm install 22',
    })
    expect(itemView(item('pixel', 'warn', false, { code: 'PIXEL_ARCH' })).reason).toBe('wsl.reason.PIXEL_ARCH')
  })
  it('Windows 版 claude：路径单独一行', () => {
    const v = itemView(item('claude', 'warn', false, { code: 'CLAUDE_WINDOWS', detail: '/mnt/c/x/claude' }))
    expect(v.line).toBe('/mnt/c/x/claude')
    expect(v.reason).toBe('wsl.reason.CLAUDE_WINDOWS')
  })
  it('启动失败：没有右侧短说明，原始错误一行', () => {
    const v = itemView(item('start', 'fail', true, { code: 'WSL_START_FAILED', detail: 'timeout' }))
    expect(v.short).toBeNull()
    expect(v.line).toBe('timeout')
  })
  it('编码：只有短说明，没有原因行', () => {
    const v = itemView(item('encoding', 'info', false, { code: 'ENCODING_NOT_UTF8', detail: 'POSIX' }))
    expect(v.short).toEqual({ key: 'wsl.short.ENCODING_NOT_UTF8', params: { charmap: 'POSIX' } })
    expect(v.reason).toBeNull()
    expect(v.status).toBe('ok')
  })
  it('编码未知仍是灰色空心圆', () => {
    expect(itemView(item('encoding', 'info', false, { code: 'ENCODING_UNKNOWN' })).status).toBe('info')
  })
  it('登录项总是说明单独登录', () => {
    expect(itemView(item('login', 'info', false)).reason).toBe('wsl.reason.login')
  })

  it('登录项的 detail 翻译成「还没登录 / 已登录」', () => {
    expect(itemView({ key: 'login', status: 'info', required: false, detail: 'none' }).short).toEqual({
      key: 'wsl.login.none',
    })
    expect(itemView({ key: 'login', status: 'ok', required: false, detail: 'claude' }).short).toEqual({
      key: 'wsl.login.some',
      params: { who: 'claude' },
    })
  })
})
