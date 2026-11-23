import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelDetailKey, type HostEvent } from '@pixelsky/protocol'
import { EngineHost } from '../src/host'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pixelsky-model-meta-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('Host modelMetadata (top-level cross-channel storage & cloud catalog toggle)', () => {
  it('stores and broadcasts channel model details independently of codex config and respects cloudModelCatalog', async () => {
    const dir = tempDir()
    const events: HostEvent[] = []
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('models.dev')) {
        return new Response(
          JSON.stringify({
            openai: { models: { 'gpt-6.2-sol': { id: 'gpt-6.2-sol', cost: { input: 2, output: 10 } } } },
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'openai/gpt-6.2-sol', description: 'OpenRouter balanced model' }] }),
        { status: 200 },
      )
    })

    const host = new EngineHost({
      dataDir: dir,
      adapters: {},
      fetch: fetcher as unknown as typeof fetch,
      emit: e => events.push(e),
    })

    expect(host.modelMetadata()).toEqual({ details: {}, cloudCatalog: true })

    // 保存自定义接口与 Claude 通道的明细（不再依赖 codex 引擎）
    const customTarget = { channel: 'custom' as const, sourceId: 'relay-1', model: 'gpt-6.2-sol' }
    const claudeTarget = { channel: 'claude' as const, sourceId: null, model: 'claude-sonnet-4-6' }
    host.setModelDetail({
      target: customTarget,
      detail: { main: '公司中转', price: { currency: 'CNY', input: 8, output: 24 } },
    })
    host.setModelDetail({
      target: claudeTarget,
      detail: { main: '主力开发' },
    })

    // 开启时正常拉取公开参考
    const refsOn = await host.modelDisplayReferences(['gpt-6.2-sol'])
    expect(refsOn['gpt-6.2-sol']?.description).toBe('OpenRouter balanced model')
    expect(fetcher).toHaveBeenCalledTimes(2)

    // 关闭联网目录开关后不再发起任何请求
    const afterOff = host.setCloudModelCatalog(false)
    expect(afterOff.cloudCatalog).toBe(false)
    expect(await host.modelDisplayReferences(['gpt-6.2-sol'], true)).toEqual({})
    expect(fetcher).toHaveBeenCalledTimes(2)

    // 重新打开宿主持久化读取完好
    const reloaded = new EngineHost({ dataDir: dir, adapters: {}, emit: () => {} })
    expect(reloaded.modelMetadata().cloudCatalog).toBe(false)
    expect(reloaded.modelMetadata().details[modelDetailKey(customTarget)]?.main).toBe('公司中转')
    expect(reloaded.modelMetadata().details[modelDetailKey(claudeTarget)]?.main).toBe('主力开发')
    expect(events.some(e => e.kind === 'model_metadata')).toBe(true)
  })
})
