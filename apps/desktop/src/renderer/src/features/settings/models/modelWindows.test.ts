// 设置 › 模型通道 › 菜单里显示的模型：三个引擎合在一起、每个模型一个上下文窗口
import { describe, expect, it } from 'vitest'
import { mergedModels, modelBadge, routeCount, sharedWindow, windowBackfill, windowEngines } from './modelWindows'

const lists = {
  claude: ['claude-opus-5-5'],
  codex: ['gpt-6.1'],
  // 像素星空两种线路都能跑，还有只有它能跑的（Chat Completions、只给像素星空的线路）
  pixel: ['claude-opus-5-5', 'gpt-6.1', 'deepseek-v4'],
}

describe('模型列表', () => {
  it('三个引擎的模型合在一起，只有像素星空能跑的也列出来', () => {
    expect(mergedModels(lists)).toEqual(['claude-opus-5-5', 'gpt-6.1', 'deepseek-v4'])
    expect(mergedModels({ claude: ['a'], pixel: [] })).toEqual(['a'])
  })

  it('能跑这个模型的引擎', () => {
    expect(windowEngines('claude-opus-5-5', lists)).toEqual(['claude', 'pixel'])
    expect(windowEngines('deepseek-v4', lists)).toEqual(['pixel'])
  })

  it('图标：Claude Code 能跑的不画，只有 Codex / Pixel 能跑的画那个引擎', () => {
    expect(modelBadge('claude-opus-5-5', lists)).toBeNull()
    expect(modelBadge('gpt-6.1', lists)).toBe('codex')
    expect(modelBadge('deepseek-v4', lists)).toBe('pixel')
  })

  it('线路数：各引擎目录里同一个分组只算一次', () => {
    const a = { id: 'a', models: ['claude-opus-5-5'] }
    const o = { id: 'o', models: ['gpt-6.1'] }
    const d = { id: 'd', models: ['deepseek-v4', 'claude-opus-5-5'] }
    const groups = { claude: [a], codex: [o], pixel: [a, o, d] }
    expect(routeCount('claude-opus-5-5', groups)).toBe(2)
    expect(routeCount('gpt-6.1', groups)).toBe(1)
    expect(routeCount('deepseek-v4', groups)).toBe(1)
  })
})

describe('上下文窗口', () => {
  it('显示能跑它的引擎里第一个填了的；都没填是自动（null）', () => {
    expect(sharedWindow('claude-opus-5-5', lists, { claude: { 'claude-opus-5-5': 200_000 } })).toBe(200_000)
    expect(sharedWindow('deepseek-v4', lists, { pixel: { 'deepseek-v4': 128_000 } })).toBe(128_000)
    // 别的引擎跑不了这个模型，它那份不算
    expect(sharedWindow('deepseek-v4', lists, { claude: { 'deepseek-v4': 1 } })).toBeNull()
    expect(sharedWindow('gpt-6.1', lists, {})).toBeNull()
  })

  it('老版本只写了 Claude Code 的：补给像素星空（不然它按系列自动定，和显示的不一样）', () => {
    expect(windowBackfill(mergedModels(lists), lists, { claude: { 'claude-opus-5-5': 200_000 } })).toEqual([
      { engine: 'pixel', model: 'claude-opus-5-5', value: 200_000 },
    ])
  })

  it('都填了、或都没填时不补；填了不同值的不动', () => {
    const windows = {
      claude: { 'claude-opus-5-5': 200_000 },
      codex: { 'gpt-6.1': 400_000 },
      pixel: { 'claude-opus-5-5': 300_000, 'gpt-6.1': 400_000 },
    }
    expect(windowBackfill(mergedModels(lists), lists, windows)).toEqual([])
    expect(windowBackfill(mergedModels(lists), lists, {})).toEqual([])
  })
})
