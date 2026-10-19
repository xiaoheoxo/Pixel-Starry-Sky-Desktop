// 官方语言扩展的验收（extensions/official/AUTHORING.md §5）：
// 每个扩展按开发者模式（文件夹）加载，必须零错误、生效；每个 .fixtures/<场景>/ 按软件的任务逻辑列任务，
// 和 expected.json 比对任务名、描述和 Linux（bash）/ Windows（PowerShell）下的完整命令。
// OFFICIAL_EXT=python 只跑一个扩展。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExtTaskTemplateWire } from '@pixelsky/protocol'
import { readExtTaskGroups } from '../core/project-tools/ext-tasks'
// 验收要用界面实际拼命令的同一个函数（纯函数，只引类型），所以这个测试破例从 renderer 导入
// eslint-disable-next-line no-restricted-imports
import { extTaskCommand } from '../../renderer/src/features/coding/tasks/extCommand'
import { loadPack } from './loader'

const ROOT = resolve(__dirname, '../../../../../extensions/official')
const APP_VERSION = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')).version as string
const only = process.env.OFFICIAL_EXT

const packs = existsSync(ROOT)
  ? readdirSync(ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(ROOT, d.name, 'pixelsky-extension.json')))
      .map(d => d.name)
      .filter(name => !only || name === only)
  : []

interface ExpectedTask {
  name: string
  description?: string
  linux: string
  windows: string
}
interface ExpectedGroup {
  template: string
  file: string
  tasks: ExpectedTask[]
}

/** 列任务：platform 决定选哪个运行器，shell 决定引号和 cd 的写法 */
async function listTasks(
  root: string,
  wires: ExtTaskTemplateWire[],
  platform: NodeJS.Platform,
  shell: string,
): Promise<
  Array<{ template: string; file: string; tasks: Array<{ name: string; description?: string; command: string }> }>
> {
  const io = {
    platform,
    async read(path: string, maxBytes: number) {
      let handle
      try {
        handle = await open(path, 'r')
        const buffer = Buffer.alloc(maxBytes)
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
        return buffer.subarray(0, bytesRead).toString('utf8')
      } catch {
        return null
      } finally {
        await handle?.close().catch(() => undefined)
      }
    },
    async exists(path: string) {
      try {
        await stat(path)
        return true
      } catch {
        return false
      }
    },
  }
  const { groups } = await readExtTaskGroups(root, wires, io)
  return groups.map(g => ({
    template: g.ext!.templateId,
    file: g.file,
    tasks: g.tasks.map(t => {
      const description =
        t.extDetail === undefined ? undefined : typeof t.extDetail === 'string' ? t.extDetail : t.extDetail.zh
      return {
        name: t.name,
        ...(description !== undefined ? { description } : {}),
        command: extTaskCommand(g, t, shell),
      }
    }),
  }))
}

describe('官方语言扩展', () => {
  it('extensions/official 下有扩展', () => {
    expect(packs.length).toBeGreaterThan(0)
  })

  for (const name of packs) {
    describe(name, () => {
      const dir = join(ROOT, name)
      const manifest = JSON.parse(readFileSync(join(dir, 'pixelsky-extension.json'), 'utf8'))

      it('按文件夹加载：零错误零警告、生效', async () => {
        const pack = await loadPack({
          key: `f-official-${name}`,
          root: dir,
          source: 'folder',
          enabled: true,
          addedAt: 1,
          options: {},
          revision: 1,
          appVersion: APP_VERSION,
        })
        const problems = pack.info.issues
          .filter(i => i.severity === 'error' || (i.severity === 'warning' && i.upload !== 'hint'))
          .map(i => `${i.severity} ${i.code} ${i.path ?? ''} ${i.message.zh}`)
        expect(problems).toEqual([])
        expect(pack.info.status).not.toBe('error')
        expect(pack.info.live).toBe(true)
        expect(manifest.id).toBe(`pixelsky.${name}`)
      })

      const templates = (manifest.contributes?.taskTemplates ?? []) as ExtTaskTemplateWire['template'][]
      const wires: ExtTaskTemplateWire[] = templates.map((template, index) => ({
        packKey: `f-official-${name}`,
        packId: manifest.id,
        index,
        template,
      }))
      const fixtureRoot = join(dir, '.fixtures')
      const fixtures = existsSync(fixtureRoot)
        ? readdirSync(fixtureRoot, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
        : []

      if (templates.length) {
        it('每个任务模板至少被一个用例列出任务', async () => {
          const seen = new Set<string>()
          for (const f of fixtures) {
            const expected = JSON.parse(readFileSync(join(fixtureRoot, f, 'expected.json'), 'utf8')) as ExpectedGroup[]
            for (const g of expected) seen.add(g.template)
          }
          expect(templates.map(t => t.id).filter(id => !seen.has(id))).toEqual([])
        })
      }

      for (const f of fixtures) {
        it(`任务用例 ${f}`, async () => {
          const root = join(fixtureRoot, f)
          const expected = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8')) as ExpectedGroup[]
          const linux = await listTasks(root, wires, 'linux', 'bash')
          const windows = await listTasks(root, wires, 'win32', 'pwsh.exe')
          const merged = linux.map((g, gi) => ({
            template: g.template,
            file: g.file,
            tasks: g.tasks.map((t, ti) => ({
              name: t.name,
              ...(t.description !== undefined ? { description: t.description } : {}),
              linux: t.command,
              windows: windows[gi]?.tasks[ti]?.command ?? '(Windows 上没有这个任务)',
            })),
          }))
          expect(windows.length).toBe(linux.length)
          expect(merged).toEqual(expected)
        })
      }
    })
  }
})
