// 接力解析前去掉代码（withoutCode）：围栏按 Markdown 的规则认，和界面显示一致
import { describe, expect, it } from 'vitest'
import { flowPlanPrompt, flowRemindPrompt, withoutCode } from './prompt'

describe('withoutCode', () => {
  it('代码里的字符串含同样的围栏字符：不提前结束，后面的 @ 仍在代码里', () => {
    expect(withoutCode('~~~js\nconst d = "~~~";\n// @乙 仅供展示\n~~~')).not.toContain('@乙')
    expect(withoutCode('```js\nconst d = "```";\n// @乙 仅供展示\n```')).not.toContain('@乙')
  })

  it('结束围栏不能比开头短，可以更长、可以缩进最多 3 格、后面可以有空白', () => {
    expect(withoutCode('````\n```\n@乙\n````\n@甲 看看')).toBe('\n@甲 看看')
    expect(withoutCode('```\n@乙\n   `````  \n@甲')).toBe('\n@甲')
    // 不同字符不算结束
    expect(withoutCode('```\n~~~\n@乙\n```\n@甲')).toBe('\n@甲')
  })

  it('没闭合的围栏一直算到末尾；反引号围栏的信息串里有反引号时不是围栏', () => {
    expect(withoutCode('先看\n\n~~~\n@乙 改一下')).toBe('先看\n\n')
    expect(withoutCode('``` a`b\n@乙')).toContain('@乙')
  })

  it('代码块的位置留一个空行：前后两段仍是两段；行内代码照旧去掉', () => {
    expect(withoutCode('@甲 前面\n```\nx\n```\n@乙 后面')).toBe('@甲 前面\n\n@乙 后面')
    expect(withoutCode('用 `@乙` 这个写法，@甲 看看')).toBe('用  这个写法，@甲 看看')
  })

  it('引用里的围栏、列表项里缩进 4 格以上的围栏、缩进 4 格的代码块都算代码', () => {
    expect(withoutCode('> 看这段\n> ~~~js\n> // @乙\n> ~~~\n\n@甲')).not.toContain('@乙')
    expect(withoutCode('- 第一步\n\n    ```js\n    // @乙\n    ```\n\n@甲')).not.toContain('@乙')
    expect(withoutCode('例子：\n\n    // @乙 改一下\n\n@甲 看看')).toBe('例子：\n\n\n\n@甲 看看')
  })

  it('段落的续行缩进 4 格不是代码：@ 仍要认', () => {
    expect(withoutCode('先看这里\n    @乙 改一下')).toContain('@乙')
  })
})

describe('拆流程的提示词（docs/ui/channels-pipeline.md §12 第 2 条）', () => {
  it('跨层的活先定接口，同时做的步骤不改同一批文件', () => {
    const input = { channel: 'web', request: '加导出', members: [{ name: '画师', role: '' }] }
    const zh = flowPlanPrompt({ ...input, locale: 'zh-CN' })
    expect(zh).toContain('先安排一步定共用的接口和类型')
    expect(zh).toContain('同时做的步骤不要改同一批文件')
    expect(flowPlanPrompt({ ...input, locale: 'en-US' })).toContain('should not change the same files')
  })
})

// Codex 不把 MCP 工具直接列给模型：gpt-5 系列要 tool_search，gpt-6 系列在代码模式的 exec 里
describe('频道工具怎么找', () => {
  it('出计划和交付的提示词都教了，中英文都有', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const plan = flowPlanPrompt({ locale, channel: 'web', request: '改按钮', members: [] })
      for (const text of [plan, flowRemindPrompt(locale)]) {
        expect(text).toContain('tool_search')
        expect(text).toContain('tools.mcp__pixelsky_channel__')
      }
    }
  })
})
