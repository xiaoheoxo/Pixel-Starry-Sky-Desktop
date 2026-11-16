import { mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES, type EngineEvent } from '@pixelsky/protocol'
import { CodexAdapter, EngineHost } from '../src'
import { codexGeneratedImage, codexGenerationFailure, codexViewedImage } from '../src/codex/images'
import { CodexTranslator } from '../src/codex/translate'
import { Store } from '../src/store'
import { makeTmp, removeTmp } from './helpers/tmp'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaPj/HwAEggJ/59habAAAAABJRU5ErkJggg==',
  'base64',
)
let root: string
let host: EngineHost | undefined
beforeEach(() => {
  root = makeTmp('codex-images')
})
afterEach(async () => {
  await host?.shutdown()
  host = undefined
  removeTmp(root)
})

describe('Codex 看图附件', () => {
  it('旧版只存路径的已完成看图条目，重开时补齐附件并落盘', async () => {
    const cwd = join(root, 'workspace')
    mkdirSync(cwd)
    const dataDir = join(root, 'data')
    const path = join(root, 'dark.png')
    writeFileSync(path, png)
    host = new EngineHost({ dataDir, adapters: {}, emit: () => {} })
    const record = host.createSession({ projectId: host.addProject(cwd).id, engine: 'codex' })
    await host.shutdown()
    const store = new Store(dataDir)
    store.appendItem(record.id, {
      kind: 'tool',
      id: 'cx-old-image',
      tool: 'read',
      name: 'imageView',
      title: path,
      output: '',
      status: 'completed',
    })
    host = new EngineHost({ dataDir, adapters: { codex: new CodexAdapter() }, emit: () => {} })
    // 快照里截掉了图片数据，落盘的是补齐的完整条目
    const item = host.open(record.id).items[0]
    expect(item).toMatchObject({ cut: true, images: [{ dataBase64: '' }] })
    const full = host.item(record.id, 'cx-old-image')
    expect(full?.kind === 'tool' && full.images?.[0].dataBase64).toBe(png.toString('base64'))
    expect(new Store(dataDir).readItem(record.id, 'cx-old-image')).toEqual(full)
    await host.shutdown()
    rmSync(path)
    host = new EngineHost({ dataDir, adapters: {}, emit: () => {} })
    expect(host.open(record.id).items[0]).toEqual(item)
    expect(host.item(record.id, 'cx-old-image')).toEqual(full)
  })

  it('只在看图完成时保存数据，后续重复完成不会因临时文件被删而丢失附件', () => {
    const path = join(root, '尚未生成.png')
    const events: EngineEvent[] = []
    const translator = new CodexTranslator(e => events.push(e))
    const raw = { type: 'imageView', id: 'view', path }
    translator.item(raw, false)
    expect(translator.items.get('cx-view')).not.toHaveProperty('images')
    writeFileSync(path, png)
    translator.item(raw, true)
    const item = translator.items.get('cx-view')
    expect(item).toMatchObject({
      kind: 'tool',
      name: 'imageView',
      status: 'completed',
      images: [
        {
          id: 'cx-view-img0',
          name: '尚未生成.png',
          mediaType: 'image/png',
          bytes: png.length,
          dataBase64: png.toString('base64'),
        },
      ],
    })
    expect(events.at(-1)).toEqual({ type: 'item_completed', item })
    rmSync(path)
    translator.item(raw, true)
    expect(translator.items.get('cx-view')).toEqual(item)
  })

  it.each(['failed', 'declined', 'interrupted'])('看图状态为 %s 时不读取附件', status => {
    const path = join(root, 'dark.png')
    writeFileSync(path, png)
    const translator = new CodexTranslator(() => {})
    translator.item({ type: 'imageView', id: 'view', path, status }, true)
    expect(translator.items.get('cx-view')).not.toHaveProperty('images')
  })

  it('不存在、目录、非图片、空文件、超大文件和网络路径不产生附件，也不抛错', () => {
    const text = join(root, 'text.png')
    const empty = join(root, 'empty.png')
    const large = join(root, 'large.png')
    writeFileSync(text, 'not an image')
    writeFileSync(empty, '')
    writeFileSync(large, png)
    truncateSync(large, MAX_IMAGE_BYTES + 1)
    for (const path of [
      '',
      'relative.png',
      join(root, 'missing.png'),
      root,
      text,
      empty,
      large,
      '//server/share/a.png',
      '\\\\server\\share\\a.png',
    ])
      expect(codexViewedImage(path, 'view'), path).toBeNull()
  })

  it.each(['absolute', 'relative'])('项目外图片通过 %s 路径进入宿主事件并持久保存，重开时不依赖原文件', async mode => {
    const cwd = join(root, 'workspace')
    const path = join(root, 'screenshots', '截图 dark.png')
    mkdirSync(cwd)
    mkdirSync(join(root, 'screenshots'))
    writeFileSync(path, png)
    const dataDir = join(root, 'data')
    const adapter = new CodexAdapter({
      launcher: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./fakes/fake-codex.mjs', import.meta.url))],
      },
      env: { ...process.env, FAKE_CODEX_IMAGE_PATH: mode === 'relative' ? relative(cwd, path) : path },
      launchOptions: () => ({ askQuestions: false }),
    })
    const events: EngineEvent[] = []
    host = new EngineHost({
      dataDir,
      adapters: { codex: adapter },
      emit: e => {
        if (e.kind === 'session') events.push(e.event)
      },
    })
    const record = host.createSession({ projectId: host.addProject(cwd).id, engine: 'codex', model: 'fake-codex' })
    await host.send(record.id, '查看截图')
    await expect.poll(() => host!.open(record.id).state).toBe('idle')
    // 快照里截掉了图片数据，按 id 从磁盘补回
    const viewed = host.open(record.id).items.find(i => i.kind === 'tool' && i.name === 'imageView')
    expect(viewed).toMatchObject({ cut: true })
    const full = host.item(record.id, viewed!.id)
    expect(full?.kind === 'tool' && full.images?.[0]).toMatchObject({
      name: '截图 dark.png',
      dataBase64: png.toString('base64'),
    })
    expect(
      events.some(
        e =>
          e.type === 'item_completed' &&
          e.item.id === viewed?.id &&
          e.item.kind === 'tool' &&
          e.item.images?.length === 1,
      ),
    ).toBe(true)
    await host.shutdown()
    rmSync(path)
    host = new EngineHost({ dataDir, adapters: {}, emit: () => {} })
    expect(host.open(record.id).items.find(i => i.id === viewed?.id)).toEqual(viewed)
    expect(host.item(record.id, viewed!.id)).toEqual(full)
  })
})

// docs/ui/image-gen.md：Codex 内置生图的 imageGeneration 条目
describe('Codex 生图', () => {
  it('完成时读 Codex 存的 savedPath，标题是改写后的提示词；结果里的 base64 不当文字', () => {
    const path = join(root, 'gen.png')
    writeFileSync(path, png)
    const translator = new CodexTranslator(() => {})
    translator.item(
      { type: 'imageGeneration', id: 'g', status: 'generating', revisedPrompt: null, failure: null },
      false,
    )
    expect(translator.items.get('cx-g')).toMatchObject({ name: 'imageGeneration', status: 'running', output: '' })
    translator.item(
      {
        type: 'imageGeneration',
        id: 'g',
        status: 'completed',
        revisedPrompt: '像素风夜空',
        failure: null,
        savedPath: path,
        result: 'AAAA',
        generationId: null,
      },
      true,
    )
    const item = translator.items.get('cx-g')
    expect(item).toMatchObject({ kind: 'tool', title: '像素风夜空', output: '', status: 'completed' })
    expect(item?.kind === 'tool' && item.images?.[0]).toMatchObject({
      mediaType: 'image/png',
      name: 'gen.png',
      dataBase64: png.toString('base64'),
    })
  })

  it('没有 savedPath 时用 result 的 base64；认不出格式、超过上限的不要', () => {
    expect(codexGeneratedImage({ result: png.toString('base64') }, 'cx-g')).toMatchObject({
      name: 'image.png',
      mediaType: 'image/png',
    })
    expect(codexGeneratedImage({ result: 'data:image/png;base64,' + png.toString('base64') }, 'x')?.bytes).toBe(
      png.length,
    )
    expect(codexGeneratedImage({ result: Buffer.from('not an image').toString('base64') }, 'x')).toBeNull()
    expect(codexGeneratedImage({ result: 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) }, 'x')).toBeNull()
    // 相对路径不读（Codex 给的是绝对路径）
    expect(codexGeneratedImage({ savedPath: 'gen.png' }, 'x')).toBeNull()
  })

  it('回归（审查）：完成了却没拿到图，写一句原因，不留空行', () => {
    const translator = new CodexTranslator(() => {})
    const base = { type: 'imageGeneration', status: 'completed', revisedPrompt: 'p', failure: null }
    translator.item({ ...base, id: 'a', savedPath: join(root, 'gone.png'), result: '' }, true)
    expect(translator.items.get('cx-a')).toMatchObject({
      status: 'completed',
      output: expect.stringContaining('gone.png'),
    })
    translator.item({ ...base, id: 'b', fileId: 'file_1' }, true)
    expect(translator.items.get('cx-b')).toMatchObject({ output: '没拿到图片（Codex 没有给本地文件）' })
    translator.item({ ...base, id: 'c', status: 'generating' }, false)
    expect(translator.items.get('cx-c')).toMatchObject({ output: '' })
  })

  it('额度用完：标失败，写什么时候恢复', () => {
    const translator = new CodexTranslator(() => {})
    const resetsAt = Math.floor(new Date(2026, 10, 16, 18, 5).getTime() / 1000)
    translator.item(
      {
        type: 'imageGeneration',
        id: 'f',
        status: 'failed',
        revisedPrompt: null,
        failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt },
        result: '',
      },
      true,
    )
    expect(translator.items.get('cx-f')).toMatchObject({ status: 'failed' })
    expect(codexGenerationFailure({ type: 'usageLimitExceeded', resetsAt }, new Date(2026, 10, 16, 9).getTime())).toBe(
      '生图额度用完了，今天 18:05 恢复',
    )
    expect(codexGenerationFailure({ type: 'usageLimitExceeded', resetsAt }, new Date(2026, 10, 15, 9).getTime())).toBe(
      '生图额度用完了，11 月 16 日 18:05 恢复',
    )
    expect(codexGenerationFailure({ type: 'usageLimitExceeded', resetsAt: null })).toBe('生图额度用完了')
    expect(codexGenerationFailure(null)).toBe('')
  })
})
