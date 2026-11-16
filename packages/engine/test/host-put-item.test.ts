// 引擎外面放进对话的条目（云端生图，docs/ui/image-gen.md §6）
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import { EngineHost } from '../src'
import { makeTmp, removeTmp } from './helpers/tmp'

let root: string
let host: EngineHost | undefined
beforeEach(() => {
  root = makeTmp('put-item')
})
afterEach(async () => {
  await host?.shutdown()
  host = undefined
  removeTmp(root)
})

const item = (status: 'running' | 'completed', output = ''): Item => ({
  kind: 'tool',
  id: 'cloudimg-1',
  tool: 'other',
  name: 'cloudImage',
  title: '夜空',
  output,
  status,
})

it('同一个 id 再放一次是更新；落盘，重开还在', async () => {
  const dataDir = join(root, 'data')
  host = new EngineHost({ dataDir, adapters: {}, emit: () => {} })
  const rec = host.createSession({ projectId: host.addProject(root).id, engine: 'codex' })
  host.putItem(rec.id, item('running'))
  expect(host.open(rec.id).items).toMatchObject([{ id: 'cloudimg-1', status: 'running' }])
  host.putItem(rec.id, item('completed', '生图分组 · 1024x1024 · 1 张'))
  expect(host.open(rec.id).items).toHaveLength(1)
  expect(host.open(rec.id).items[0]).toMatchObject({ status: 'completed', output: '生图分组 · 1024x1024 · 1 张' })
  await host.shutdown()
  host = new EngineHost({ dataDir, adapters: {}, emit: () => {} })
  expect(host.open(rec.id).items).toMatchObject([{ id: 'cloudimg-1', status: 'completed' }])
})
