import { describe, expect, it, vi } from 'vitest'
import type { ExtPackState } from '@pixelsky/protocol'
import { fakePack, fakeState } from '@/features/extpacks/testing'
import { tr } from '@/i18n/core'
import { matchModels } from '../account/platform'
import { envLines, parseEnvLines } from './engines/envLines'
import { SETTINGS_INDEX, searchSettings } from './searchIndex'

// 扩展状态：默认什么都没装；随扩展启停的设置项的测试里换掉
const packs = vi.hoisted(() => ({ state: null as ExtPackState | null }))
vi.mock('@/features/extpacks/store', async importOriginal => {
  const real = await importOriginal<typeof import('@/features/extpacks/store')>()
  return { ...real, getPackState: () => packs.state ?? real.getPackState() }
})

const label = (s: string) =>
  ({
    account: '账号',
    models: '模型通道',
    engines: '本机引擎',
    usage: '用量',
    appearance: '外观',
    shortcuts: '快捷键',
    about: '关于',
  })[s] ?? s

describe('设置搜索（plan-search-panes-compact §1）', () => {
  it('标题命中排在关键词命中前面', () => {
    const hits = searchSettings('压缩', label)
    expect(hits[0]).toMatchObject({ section: 'engines', title: '压缩上下文用的模型' })
  })
  it('关键词、页面名、英文都能搜，忽略大小写和空格', () => {
    expect(searchSettings('HTTPS_PROXY', label).map(h => h.title)).toContain('环境变量')
    expect(searchSettings('隐藏 模型', label).map(h => h.title)).toContain('菜单里显示的模型')
    expect(searchSettings('本机引擎', label).length).toBeGreaterThan(0)
    // 模型通道（docs/ui/model-channels.md §4.3）：新词能搜，老词「额度来源」「默认引擎」也能搜到
    expect(searchSettings('授权', label).map(h => h.title)).toEqual(
      expect.arrayContaining(['Claude 授权', 'ChatGPT 授权']),
    )
    expect(searchSettings('额度来源', label).map(h => h.title)).toContain('模型通道')
    expect(searchSettings('默认引擎', label).map(h => h.title)).toContain('模型通道')
    expect(searchSettings('默认模型', label).map(h => h.title)).toContain('新对话用')
    expect(searchSettings('完全放行', label).map(h => h.title)).toContain('完全放行时在输入框上方提示')
    expect(searchSettings('   ', label)).toEqual([])
    expect(searchSettings('完全不存在的设置', label)).toEqual([])
  })
  it('「停止时一起停掉后台子智能体」中文、英文关键词都搜得到', () => {
    expect(searchSettings('后台子智能体', label).map(h => h.title)).toContain('停止时一起停掉后台子智能体')
    expect(searchSettings('stop background', label).map(h => h.section)).toContain('appearance')
  })
  it('文件图标、代码配色随扩展启停：没有启用着的扩展时搜不到，启用后搜得到', () => {
    const titles = (q: string) => searchSettings(q, label).map(h => h.title)
    const icons = tr('extensions.appearance.fileIcons'),
      colors = tr('extensions.appearance.editorTheme')
    packs.state = fakeState()
    expect(titles(icons)).not.toContain(icons)
    expect(titles(colors)).not.toContain(colors)
    packs.state = fakeState(
      fakePack({ key: 'b-1', contributes: { iconThemes: [{ id: 'm', label: 'M', path: 'm.json' }] } }),
      fakePack({
        key: 'f-2',
        id: 'p.two',
        contributes: { themes: [{ id: 'n', label: 'N', uiTheme: 'dark', path: 'n.json' }] },
      }),
    )
    expect(titles(icons)).toContain(icons)
    expect(titles(colors)).toContain(colors)
    packs.state = null
  })
  it('索引没有重复的（页面，标题）', () => {
    const keys = SETTINGS_INDEX.map(e => `${e.section}/${e.title}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
  it('引擎详情页里的设置带上引擎，点结果时先打开详情（engine-settings-redesign §3.1）', () => {
    expect(searchSettings('输出风格', label)[0]).toMatchObject({
      section: 'engines',
      title: '输出风格',
      engine: 'claude',
    })
    expect(searchSettings('提问', label)[0]).toMatchObject({ title: '允许中途向我提问', engine: 'claude' })
    expect(searchSettings('升级', label).map(h => h.title)).toContain('检查更新')
    expect(searchSettings('autocompact', label)[0]).toMatchObject({ title: '自动压缩触发点' })
    // 只在列表页的不带
    expect(SETTINGS_INDEX.find(e => e.title === 'Codex')?.engine).toBeUndefined()
  })
})

describe('模型搜索', () => {
  it('忽略大小写、空格和连字符', () => {
    const all = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-5-20251101', 'gpt-5.5']
    expect(matchModels(all, 'opus')).toEqual(['claude-opus-5-5', 'claude-opus-4-5-20251101'])
    expect(matchModels(all, 'opus 5')).toEqual(['claude-opus-5-5'])
    expect(matchModels(all, 'OPUS55')).toEqual(['claude-opus-5-5'])
    expect(matchModels(all, '')).toEqual(all)
  })
})

describe('环境变量文本框', () => {
  it('KEY=VALUE 每行一条，空行和 # 注释忽略，值里可以有等号', () => {
    expect(parseEnvLines('HTTPS_PROXY=http://127.0.0.1:7890\n\n# 注释\nA=b=c')).toEqual({
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890', A: 'b=c' },
      bad: null,
    })
    expect(envLines({ A: '1', B: '2' })).toBe('A=1\nB=2')
  })
  it('变量名不对时指出是哪一行', () => {
    expect(parseEnvLines('OK=1\nBAD-NAME=2').bad).toBe('BAD-NAME=2')
    expect(parseEnvLines('没有等号').bad).toBe('没有等号')
  })
})

describe('设置搜索：扩展页签', () => {
  it.each([
    ['发现', 'discover'],
    ['discover', 'discover'],
    ['我的发布', 'publish'],
    ['publish', 'publish'],
  ])('搜「%s」能搜到 extTab=%s', (q, tab) => {
    expect(searchSettings(q, label).some(h => h.section === 'extensions' && h.extTab === tab)).toBe(true)
  })
})
