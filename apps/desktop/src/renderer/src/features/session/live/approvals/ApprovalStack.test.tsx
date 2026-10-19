// 等你决定的审批：1 项单张卡、2 项以上合并成列表、提问单独成卡其余收成一行、只能拒绝的、分组
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import { I18nProvider } from '@/i18n/I18nProvider'
import type { ApprovalRequest } from '@pixelsky/protocol'
import { ApprovalStack } from './ApprovalStack'

const ALWAYS: ApprovalRequest['alwaysScopes'] = ['session', 'project', 'user']
const grep = (id: string, pattern: string, path: string): ApprovalRequest => ({
  requestId: id,
  itemId: `item-${id}`,
  kind: 'tool',
  title: '使用 mcp__fastctx__grep',
  toolName: 'mcp__fastctx__grep',
  description: 'fastctx · grep',
  input: { pattern, path, output_mode: 'content' },
  alwaysScopes: ALWAYS,
})
const pr: ApprovalRequest = {
  requestId: 'pr',
  itemId: 'item-pr',
  kind: 'tool',
  title: '使用 mcp__github__create_pull_request',
  toolName: 'mcp__github__create_pull_request',
  description: 'github · create_pull_request',
  input: { title: '输入框草稿按会话保存', head: 'feat/draft', base: 'main' },
  alwaysScopes: ALWAYS,
}
const CWD = 'C:/Users/me/Desktop/dsh-usage-statistics-panel'
const three = [
  grep('g1', 'providerOf|function providerOf', `${CWD}/src/client/format.ts`),
  grep('g2', 'provider|anthropic', 'C:/Users/me/Desktop/Proxy/deeperseeker/app.py'),
  grep('g3', 'provider', `${CWD}/src/wire.ts`),
]

const render = (pending: ApprovalRequest[]): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <ApprovalStack
        sessionId="s1"
        pending={pending}
        cwd={CWD}
        bounds={{ current: null }}
        onAnswer={() => undefined}
        onEscape={() => undefined}
      />
    </I18nProvider>,
  )
const count = (html: string, needle: string): number => html.split(needle).length - 1

describe('ApprovalStack', () => {
  it('没有审批时什么都不画', () => {
    expect(render([])).toBe('')
  })
  it('只有 1 项：和原来一样的完整单张卡', () => {
    const html = render([three[0]])
    expect(count(html, 'data-approval-card')).toBe(1)
    expect(html).not.toContain('data-approval-list')
    expect(html).toContain('允许一次')
  })
  it('2 项以上：合并成一张列表卡，标题写项数，有全部拒绝 / 全部允许一次', () => {
    const html = render([pr, ...three])
    expect(html).toContain('data-approval-list')
    expect(html).not.toContain('data-approval-card')
    expect(html).toContain('4 项等你决定')
    expect(count(html, 'data-approval-row=')).toBe(4)
    expect(html).toContain('data-approval-deny-all')
    expect(html).toContain('全部允许一次')
  })
  it('同一个工具成组：组头写「服务 · 工具 × 3」和「始终允许 grep」；组里的行不再重复工具名', () => {
    const html = render([pr, ...three])
    expect(count(html, 'data-approval-group=')).toBe(1)
    expect(html).toMatch(/fastctx · grep<\/span> × 3/)
    expect(html).toContain('始终允许 grep')
    // 单独的那一行写工具名，组里的三行不写
    expect(count(html, 'github · create_pull_request')).toBeGreaterThan(0)
    expect(count(html, '>fastctx · grep</span>')).toBe(1)
  })
  it('每行摘要：pattern + 路径最后两段；项目外的标出来', () => {
    const html = render(three)
    expect(html).toContain('providerOf|function providerOf')
    expect(html).toContain('· client/format.ts')
    expect(count(html, '项目外')).toBe(1)
  })
  it('Codex 命令外层带了参数：那一行带「外层带参数」，没带的不加', () => {
    const cmd = (id: string, extra: string[]): ApprovalRequest => ({
      ...three[0],
      requestId: id,
      itemId: null,
      kind: 'command',
      title: '运行命令',
      command: 'ls',
      wrapper: { line: 'powershell.exe -Command "ls"', shell: 'powershell', extra },
    })
    const html = render([cmd('w1', ['-NoProfile']), cmd('w2', [])])
    expect(count(html, '外层带参数')).toBe(1)
  })
  it('只能拒绝的：行上没有允许，写「这一项只能拒绝」；全部允许写跳过几项', () => {
    const html = render([three[0], { ...three[1], canAllow: false }])
    expect(html).toContain('这一项只能拒绝')
    expect(html).toContain('全部允许一次（跳过 1 项）')
    // 只有能允许的那一行有「允许」，两行都有「拒绝」
    expect(count(html, 'data-approval-allow=')).toBe(1)
    expect(count(html, 'data-approval-deny=')).toBe(2)
  })
  it('有提问时：提问单独一张完整卡，其余收成一行「另有 N 项等你决定」', () => {
    const question: ApprovalRequest = {
      requestId: 'q',
      itemId: 'item-q',
      kind: 'question',
      title: '草稿放多久没动就清掉？',
      questions: [
        {
          question: '草稿放多久没动就清掉？',
          header: '过期',
          multiSelect: false,
          options: [
            { label: '7 天', description: '' },
            { label: '30 天', description: '' },
          ],
        },
      ],
      alwaysScopes: [],
    }
    const html = render([question, ...three])
    expect(count(html, 'data-approval-card')).toBe(1)
    expect(html).toContain('data-approval-more')
    expect(html).toContain('另有 3 项等你决定：fastctx · grep × 3')
    expect(html).not.toContain('data-approval-list')
  })
  it('行上的允许带 ▾（始终允许的范围）；没有范围的不带', () => {
    expect(count(render(three), 'data-approval-always')).toBe(3)
    expect(count(render(three.map(r => ({ ...r, alwaysScopes: [] }))), 'data-approval-always')).toBe(0)
  })
})
