// 「/」菜单里像素星空处理的命令按组加标题（docs/ui/codex-flow-slash-feedback.md B，D277）
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SkillCommand } from '@pixelsky/protocol'
import type { AppCommand } from '@/features/resume/useResumeCommand'
import { I18nProvider } from '@/i18n/I18nProvider'
import { CommandMenu } from './CommandMenu'

const app = (name: string, group?: AppCommand['group']): AppCommand => ({
  invocation: 'app',
  name,
  description: name,
  source: 'app',
  group,
})
const compact: SkillCommand = {
  name: 'compact',
  description: 'Summarize',
  source: 'engine',
  builtin: true,
  invocation: 'slash',
}

describe('CommandMenu', () => {
  it('每组第一条前面一行标题，同组的不重复；引擎的命令和 /resume 没有标题', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <CommandMenu
          id="m"
          commands={[
            compact,
            app('resume'),
            app('new', 'chat'),
            app('fork', 'chat'),
            app('model', 'mode'),
            app('mcp', 'view'),
          ]}
          selected={0}
          onChoose={() => {}}
          onSettings={() => {}}
        />
      </I18nProvider>,
    )
    const headings = [...html.matchAll(/role="presentation"[^>]*>([^<]+)</g)].map(m => m[1])
    expect(headings).toEqual(['对话', '模型与模式', '查看'])
    // 标题不占选项的序号：键盘上下选仍按命令走
    expect(html.match(/data-command-index=/g)).toHaveLength(6)
  })
})
