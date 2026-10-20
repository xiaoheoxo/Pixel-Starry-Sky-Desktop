// 附件暂存（files:stage，PR #103 的后续）：分块校验、合计上限、闲置上传、移除、启动清理
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  FILE_STAGE_CHUNK_BYTES,
  MAX_STAGED_FILE_BYTES,
  MAX_STAGED_TOTAL_BYTES,
  STAGE_IDLE_MS,
  STAGED_FILE_TTL_MS,
} from '@pixelsky/protocol'
import { WorkspaceFiles } from './workspace-files'

let folder: string, stageDir: string, service: WorkspaceFiles
const ref = { projectId: 'project' }
const b64 = (text: string): string => Buffer.from(text).toString('base64')

beforeEach(async () => {
  const scratch = resolve('../../scratch')
  await mkdir(scratch, { recursive: true })
  folder = await mkdtemp(join(scratch, 'stage-test-'))
  stageDir = join(folder, 'attachments')
  const root = join(folder, 'project')
  await mkdir(root)
  service = new WorkspaceFiles(
    value => {
      if (value.projectId !== ref.projectId) throw new Error('项目已不存在')
      return { ref: value, name: '测试项目', path: root }
    },
    { attachmentDir: stageDir },
  )
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(folder, { recursive: true, force: true })
})

/** 传一个小文件，返回暂存路径 */
async function upload(name: string, text: string): Promise<string> {
  const id = randomUUID()
  await service.stage(ref, { action: 'begin', id, name, bytes: Buffer.byteLength(text) })
  if (text) await service.stage(ref, { action: 'chunk', id, offset: 0, dataBase64: b64(text) })
  return (await service.stage(ref, { action: 'finish', id })).path!
}

describe('分块上传', () => {
  it('按块写完、大小对上才落成文件；文件名去掉目录和非法字符', async () => {
    const id = randomUUID()
    await service.stage(ref, { action: 'begin', id, name: '../../evil:name?.zip', bytes: 10 })
    await service.stage(ref, { action: 'chunk', id, offset: 0, dataBase64: b64('hello') })
    await expect(service.stage(ref, { action: 'finish', id })).rejects.toThrow('大小不匹配')
    await service.stage(ref, { action: 'chunk', id, offset: 5, dataBase64: b64('world') })
    const { path } = await service.stage(ref, { action: 'finish', id })
    expect(path).toBe(join(stageDir, id, 'file-evil_name_.zip'))
    expect(await readFile(path!, 'utf8')).toBe('helloworld')
  })

  it('拒绝：编号不是 UUID、偏移跳块、超出声明大小、不规范的 Base64、超大块、编号重复、上传不存在', async () => {
    await expect(service.stage(ref, { action: 'begin', id: '../x', name: 'a', bytes: 1 })).rejects.toThrow('编号不正确')
    const id = randomUUID()
    await service.stage(ref, { action: 'begin', id, name: 'a.bin', bytes: 4 })
    await expect(service.stage(ref, { action: 'begin', id, name: 'a.bin', bytes: 4 })).rejects.toThrow('已使用')
    await expect(service.stage(ref, { action: 'chunk', id, offset: 2, dataBase64: b64('ab') })).rejects.toThrow(
      '数据块',
    )
    await expect(service.stage(ref, { action: 'chunk', id, offset: 0, dataBase64: b64('abcdef') })).rejects.toThrow(
      '数据块',
    )
    await expect(service.stage(ref, { action: 'chunk', id, offset: 0, dataBase64: 'YWJj ZA==' })).rejects.toThrow(
      '数据块',
    )
    const huge = 'A'.repeat(Math.ceil((FILE_STAGE_CHUNK_BYTES + 2) / 3) * 4 + 4)
    await expect(service.stage(ref, { action: 'chunk', id, offset: 0, dataBase64: huge })).rejects.toThrow('数据块')
    await expect(service.stage(ref, { action: 'finish', id: randomUUID() })).rejects.toThrow('已过期')
    await expect(service.stage({ projectId: 'gone' }, { action: 'begin', id, name: 'a', bytes: 1 })).rejects.toThrow(
      '项目已不存在',
    )
  })

  it('取消：删掉半截文件', async () => {
    const id = randomUUID()
    await service.stage(ref, { action: 'begin', id, name: 'a.bin', bytes: 4 })
    await service.stage(ref, { action: 'cancel', id })
    expect(await readdir(stageDir)).toEqual([])
  })
})

describe('合计上限', () => {
  /** 声明 n 个 1 GB 的上传占位（不传数据，正在传的按声明大小算） */
  const reserve = async (n: number): Promise<void> => {
    for (let k = 0; k < n; k++)
      await service.stage(ref, { action: 'begin', id: randomUUID(), name: `r${k}.zip`, bytes: MAX_STAGED_FILE_BYTES })
  }

  it('已有副本 + 正在传的 + 这次超过上限：拒收，不删保留期里的旧副本', async () => {
    const kept = await upload('old.txt', 'old')
    await reserve(4)
    const id = randomUUID()
    await expect(
      service.stage(ref, {
        action: 'begin',
        id,
        name: 'big.zip',
        bytes: MAX_STAGED_TOTAL_BYTES - 4 * MAX_STAGED_FILE_BYTES,
      }),
    ).rejects.toThrow('合计超过 5 GB')
    expect(await readFile(kept, 'utf8')).toBe('old')
    // 正好放得下的照收
    await service.stage(ref, {
      action: 'begin',
      id,
      name: 'fit.zip',
      bytes: MAX_STAGED_TOTAL_BYTES - 4 * MAX_STAGED_FILE_BYTES - 3,
    })
  })

  it('超了先清过期的再算：过期副本删掉后放得下就收', async () => {
    const old = await upload('old.txt', 'x'.repeat(16))
    const past = new Date(Date.now() - STAGED_FILE_TTL_MS - 60_000)
    await utimes(join(old, '..'), past, past)
    await reserve(4)
    const id = randomUUID()
    await service.stage(ref, {
      action: 'begin',
      id,
      name: 'big.zip',
      bytes: MAX_STAGED_TOTAL_BYTES - 4 * MAX_STAGED_FILE_BYTES - 8,
    })
    await expect(stat(old)).rejects.toThrow()
  })
})

describe('移除和清理', () => {
  it('移除：只删暂存目录里 <uuid>/file-* 这种路径所在的目录，别的路径一律拒绝', async () => {
    const path = await upload('a.txt', 'a')
    const outside = join(folder, 'project', 'keep.txt')
    await writeFile(outside, 'keep')
    await expect(service.stage(ref, { action: 'remove', path: outside })).rejects.toThrow('只能删除')
    await expect(service.stage(ref, { action: 'remove', path: join(stageDir, '..', 'project') })).rejects.toThrow(
      '只能删除',
    )
    await expect(service.stage(ref, { action: 'remove', path: stageDir })).rejects.toThrow('只能删除')
    await expect(service.stage(ref, { action: 'remove', path: 'relative/file-a' })).rejects.toThrow()
    await service.stage(ref, { action: 'remove', path })
    expect(await readdir(stageDir)).toEqual([])
    expect(await readFile(outside, 'utf8')).toBe('keep')
  })

  it('上传闲置超过 10 分钟：下次请求时当放弃，记录和半截文件都删掉', async () => {
    const id = randomUUID()
    await service.stage(ref, { action: 'begin', id, name: 'a.bin', bytes: 4 })
    const now = Date.now()
    vi.useFakeTimers({ now: now + STAGE_IDLE_MS + 1000, toFake: ['Date'] })
    await service.stage(ref, { action: 'cancel', id: randomUUID() })
    expect(await readdir(stageDir)).toEqual([])
    await expect(service.stage(ref, { action: 'chunk', id, offset: 0, dataBase64: b64('abcd') })).rejects.toThrow(
      '已过期',
    )
  })

  it('启动清理：删过期副本和上次进程留下的半截上传，留下新的副本', async () => {
    const fresh = await upload('fresh.txt', 'f')
    const expired = await upload('expired.txt', 'e')
    const long = new Date(Date.now() - STAGED_FILE_TTL_MS - 60_000)
    await utimes(join(expired, '..'), long, long)
    const leftover = join(stageDir, randomUUID())
    await mkdir(leftover)
    await writeFile(join(leftover, 'payload.part'), 'half')
    const idle = new Date(Date.now() - STAGE_IDLE_MS - 60_000)
    await utimes(leftover, idle, idle)
    // 这个进程里正在传的不动
    const id = randomUUID()
    await service.stage(ref, { action: 'begin', id, name: 'live.bin', bytes: 4 })
    const liveDir = join(stageDir, id)
    await utimes(liveDir, idle, idle)
    await service.cleanExpiredStages()
    expect((await readdir(stageDir)).sort()).toEqual(
      [join(fresh, '..'), liveDir].map(p => p.split(/[\\/]/).pop()).sort(),
    )
  })
})
