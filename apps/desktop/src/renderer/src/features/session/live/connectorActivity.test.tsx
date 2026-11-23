import type { Item } from '@pixelsky/protocol'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n/I18nProvider'
import { setCurrentLocale } from '@/i18n/core'
import { ConnectorActivitySummary } from './ConnectorActivitySummary'
import { connectorCall, connectorCallCount, connectorUsage } from './connectorActivity'
import { summaryText } from './TurnProcess'
import { summarize } from './turnFold'

vi.mock('../attachments/ImageAttachments', () => ({ ImageThumbs: () => null }))
vi.mock('@/features/appearance/ThemeProvider', () => ({ useMinimal: () => false }))
vi.mock('@/features/search/expand', () => ({ REQUEST_MS: 0, useExpandAny: () => null }))
vi.mock('@/features/panes/keepAlive', () => ({}))

beforeAll(() => setCurrentLocale('zh-CN'))

function mcp(
  id: string,
  name: string,
  status: 'completed' | 'running' | 'failed' = 'completed',
): Extract<Item, { kind: 'tool' }> {
  return { id, kind: 'tool', tool: 'mcp', name, status, title: 'inputs not used in the label', output: 'result' }
}

function cmd(id: string): Extract<Item, { kind: 'command' }> {
  return { id, kind: 'command', command: 'echo hi', description: null, output: '', exitCode: 0, status: 'completed' }
}

describe('connector activity', () => {
  it('extracts tool and provider from both persisted formats without reading args or output', () => {
    expect(connectorCall(mcp('1', 'Pixelsky Threads / read_thread'))).toEqual({
      provider: 'Pixelsky Threads',
      tool: 'read_thread',
    })
    expect(connectorCall(mcp('2', 'mcp__github__list_issues'))).toEqual({ provider: 'github', tool: 'list_issues' })
    expect(connectorCall(mcp('3', 'unknown_tool'))).toEqual({ provider: null, tool: 'unknown_tool' })
    expect(connectorCall({ ...mcp('4', 'mcp__pretend__launch'), kind: 'tool', tool: 'other' })).toBeNull()
  })

  it('counts real call IDs once per provider, including active and failed calls', () => {
    const first = mcp('1', 'github / read', 'running')
    const usage = connectorUsage([
      first,
      { ...first, status: 'completed' },
      mcp('2', 'mcp__github__read', 'failed'),
      mcp('3', 'files / list'),
      mcp('4', 'unqualified'),
    ])
    expect(usage).toEqual([
      { provider: 'github', calls: 2 },
      { provider: 'files', calls: 1 },
    ])
    expect(connectorCallCount(usage)).toBe(3)
  })

  it('removes duplicated MCP count from summaryText when covered by connector summary', () => {
    const items: Item[] = [
      cmd('c1'),
      mcp('m1', 'Pixelsky Threads / list_threads'),
      mcp('m2', 'Pixelsky Threads / read_thread'),
    ]
    const s = summarize(items)
    const covered = connectorCallCount(connectorUsage(items))
    expect(summaryText(s, items.length, { coveredMcp: covered })).not.toContain('MCP')
    expect(summaryText(s, items.length, { coveredMcp: covered })).toContain('命令')

    // 只有命名连接器调用时不再重复输出「N 步」或「MCP N 次」
    const onlyMcp: Item[] = [mcp('m1', 'Pixelsky Threads / list_threads'), mcp('m2', 'Pixelsky Threads / read_thread')]
    expect(summaryText(summarize(onlyMcp), onlyMcp.length, { coveredMcp: 2 })).toBe('')

    // 混有未命名 MCP 调用时保留剩余未归类次数
    const mixed: Item[] = [mcp('m1', 'github / read'), mcp('m2', 'unqualified_tool')]
    expect(summaryText(summarize(mixed), mixed.length, { coveredMcp: 1 })).toContain('MCP 1')
  })

  it('keeps connector count non-truncating separately from truncated provider name', () => {
    const items: Item[] = [
      mcp('1', 'Pixelsky Threads / list_threads'),
      mcp('2', 'Pixelsky Threads / read_thread'),
      mcp('3', 'Pixelsky Threads / read_thread'),
    ]
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ConnectorActivitySummary items={items} />
      </I18nProvider>,
    )
    expect(html).toMatch(/data-connector-name="true"[^>]*class="[^"]*truncate[^"]*">Pixelsky Threads</)
    expect(html).toMatch(/data-connector-count="true"[^>]*class="[^"]*shrink-0[^"]*">×3</)
  })
})
