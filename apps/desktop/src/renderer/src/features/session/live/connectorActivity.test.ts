import type { Item } from '@pixelsky/protocol'
import { describe, expect, it } from 'vitest'
import { connectorCall, connectorUsage } from './connectorActivity'

function mcp(
  id: string,
  name: string,
  status: 'completed' | 'running' | 'failed' = 'completed',
): Extract<Item, { kind: 'tool' }> {
  return { id, kind: 'tool', tool: 'mcp', name, status, title: 'inputs not used in the label', output: 'result' }
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
    expect(
      connectorUsage([
        first,
        { ...first, status: 'completed' },
        mcp('2', 'mcp__github__read', 'failed'),
        mcp('3', 'files / list'),
        mcp('4', 'unqualified'),
      ]),
    ).toEqual([
      { provider: 'github', calls: 2 },
      { provider: 'files', calls: 1 },
    ])
  })
})
