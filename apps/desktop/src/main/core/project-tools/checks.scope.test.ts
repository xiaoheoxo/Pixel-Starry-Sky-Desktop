// 产出检查的范围（docs/ui/channel-checks-scope-mockup.html）：频道给了空清单就不扫文件，不给清单才看整个工作区
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Checks } from './checks'
import type { ToolsHost } from './common'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checks-scope-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})
const git = (...args: string[]) =>
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { windowsHide: true })

it('空清单不扫别的任务留下的文件；只看清单里的；不给清单看整个工作区', async () => {
  git('init', '-q')
  await writeFile(join(root, 'a.ts'), 'a\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  // 别的任务留下的：已跟踪文件的改动、新文件
  await writeFile(join(root, 'a.ts'), 'a\n// TODO 别的任务留的\n')
  await writeFile(join(root, 'b.ts'), '// TODO 也是别的任务留的\n')
  const host = { resolve: () => ({ projectId: 'p1', name: 'p', path: root }) } as unknown as ToolsHost
  const checks = new Checks(join(root, '.store'), host)
  await checks.init()
  await checks.saveConfig('p1', { commands: [], text: true, channel: true })
  const text = async (files?: string[]) =>
    (await checks.run({ projectId: 'p1' }, { files, when: 'channel' }))!.items.find(i => i.kind === 'text')

  expect(await text([])).toMatchObject({ status: 'skipped', findings: [] })
  // 改的文件都不在项目里，换算完也是空的
  expect(await text([join(root, '..', 'elsewhere.ts')])).toMatchObject({ status: 'skipped', findings: [] })
  expect((await text(['b.ts']))?.findings.map(f => f.file)).toEqual(['b.ts'])
  expect((await text())?.findings.map(f => f.file).sort()).toEqual(['a.ts', 'b.ts'])
}, 60_000)
