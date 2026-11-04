import { describe, expect, it } from 'vitest'
import type { ExtCommand, ExtPackInfo } from '@pixelsky/protocol'
import { fakePack, fakeState } from '../testing'
import { activeBindings, commandBlock, packCommands, type PackCommand } from './model'

const command = (over: Partial<ExtCommand> = {}): ExtCommand => ({ id: 'a', title: { zh: '甲', en: 'A' }, ...over })
const pack = (commands: ExtCommand[], over: Partial<ExtPackInfo> = {}): ExtPackInfo =>
  fakePack({ key: over.key ?? 'k', contributes: { commands }, ...over })
const item = (binding: PackCommand['binding'], id = 'a'): PackCommand => ({
  packKey: 'k',
  packName: 'K',
  id,
  title: id,
  description: null,
  where: ['palette'],
  requires: null,
  binding,
})

describe('packCommands', () => {
  it('取生效扩展的命令，按语言显示，默认只在命令面板', () => {
    const [c] = packCommands(fakeState(pack([command()])), 'en-US')
    expect(c).toMatchObject({ id: 'a', title: 'A', where: ['palette'], requires: null, binding: null })
  })
  it('商店里被拦下的发布者不列；被错误停用的那条不列', () => {
    expect(
      packCommands(fakeState(pack([command()], { script: { granted: [], missing: [], blocked: true } })), 'zh-CN'),
    ).toEqual([])
    expect(
      packCommands(fakeState(pack([command(), command({ id: 'b' })], { inactive: { commands: [0] } })), 'zh-CN').map(
        c => c.id,
      ),
    ).toEqual(['b'])
  })
})

describe('commandBlock', () => {
  const need = (requires: PackCommand['requires']): PackCommand => ({ ...item(null), requires })
  it('按 requires 判断', () => {
    expect(commandBlock(need(null), { hasEditor: false, hasSelection: false })).toBeNull()
    expect(commandBlock(need('editor'), { hasEditor: false, hasSelection: false })).toBe('editor')
    expect(commandBlock(need('selection'), { hasEditor: false, hasSelection: false })).toBe('editor')
    expect(commandBlock(need('selection'), { hasEditor: true, hasSelection: false })).toBe('selection')
    expect(commandBlock(need('selection'), { hasEditor: true, hasSelection: true })).toBeNull()
  })
})

describe('activeBindings', () => {
  const j = { code: 'KeyJ', mod: true, shift: false, alt: true }
  it('冲突的不生效：软件自带、必留的键、先到的扩展', () => {
    expect(activeBindings([item(j)], [j])).toEqual([])
    expect(activeBindings([item({ code: 'KeyC', mod: true, shift: false, alt: false })], [])).toEqual([])
    expect(activeBindings([item(j, 'first'), item(j, 'second')], []).map(c => c.id)).toEqual(['first'])
    expect(activeBindings([item(null)], [])).toEqual([])
  })
})
