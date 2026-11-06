import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UsageGroupRow } from '@/features/usage/types'
import { shortId } from '../format'

const base = {
  input: 10,
  cacheRead: 0,
  cacheWrite: 0,
  output: 5,
  costUsd: 1,
  costKnown: 1,
  records: 1,
  turns: 2,
  requests: 2,
}
const live: UsageGroupRow = {
  ...base,
  key: 'abcdef12-0000',
  sessionId: 'abcdef12-0000',
  title: '重构登录',
  project: '像素',
}
const gone: UsageGroupRow = {
  ...base,
  key: 'dead0000-1111',
  sessionId: 'dead0000-1111',
  title: '旧标题',
  project: null,
}
const others: UsageGroupRow = { ...base, key: '__others__', others: 3 }

// 重置模块并把「是否真实模式 / 会话列表」换成测试给的值
async function render(rows: UsageGroupRow[], opts: { isLive: boolean; sessions: unknown[]; exists: string[] }) {
  vi.resetModules()
  vi.doMock('@/features/engine/hooks', () => ({ isLive: opts.isLive }))
  vi.doMock('@/features/engine/openRequests', () => ({ sessionExists: (id: string) => opts.exists.includes(id) }))
  vi.doMock('@/features/engine/store', () => ({ useEngineState: () => opts.sessions }))
  const { I18nProvider } = await import('@/i18n/I18nProvider')
  const { Distribution } = await import('./Distribution')
  return renderToStaticMarkup(
    <I18nProvider>
      <Distribution dim="session" onDim={() => {}} rows={rows} activeKey={undefined} onPick={() => {}} />
    </I18nProvider>,
  )
}

describe('shortId', () => {
  it('本机 ID 取前 8 位；远端 ID 去掉机器前缀；空串返回空串', () => {
    expect(shortId('abcdef12-3456')).toBe('abcdef12')
    expect(shortId('ssh-box~0123abcd-9999')).toBe('0123abcd')
    expect(shortId('')).toBe('')
  })
})

describe('分布表 › 会话', () => {
  afterEach(() => vi.doUnmock('@/features/engine/hooks'))

  it('会话还在：显示标题和「项目 · 短 ID」', async () => {
    const html = await render([live], { isLive: true, sessions: [{}], exists: [live.sessionId!] })
    expect(html).toContain('重构登录')
    expect(html).toContain('像素 · abcdef12')
    expect(html).not.toContain('已删除的会话')
  })

  it('会话已删除：显示「已删除的会话」和短 ID，没有项目时只有短 ID', async () => {
    const html = await render([gone], { isLive: true, sessions: [{}], exists: [] })
    expect(html).toContain('已删除的会话')
    expect(html).toContain('>dead0000<')
  })

  it('会话列表还没读到或演示模式：不判断已删除', async () => {
    expect(await render([gone], { isLive: true, sessions: [], exists: [] })).not.toContain('已删除的会话')
    expect(await render([gone], { isLive: false, sessions: [{}], exists: [] })).not.toContain('已删除的会话')
  })

  it('「其余 N 个会话」行：不带悬停高亮和点击提示，也没有小字', async () => {
    const html = await render([live, others], { isLive: true, sessions: [{}], exists: [live.sessionId!] })
    expect(html).toContain('其余 3 个会话')
    const row = html.split('<tr').find(r => r.includes('其余 3 个会话'))!
    expect(row).not.toContain('hover:bg-selected')
    expect(row).not.toContain('title="点击')
    expect(row).not.toContain('text-fg-faint')
    expect(html.split('<tr').find(r => r.includes('重构登录'))).toContain('hover:bg-selected')
  })
})
