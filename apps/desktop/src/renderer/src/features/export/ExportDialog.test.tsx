// 导出对话框的展示（docs/ui/conversation-export.md §3）：没有命中 / 有命中 / 选定轮次
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import type { Item } from '@pixelsky/protocol'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
const sessions: Record<string, { record: object; items: Item[] }> = {}
vi.mock('@/features/engine', () => ({ bridge: null, useSession: (id: string) => sessions[id] ?? null }))
// 外框用 portal 挂到 document.body，服务端渲染没有：换成就地渲染，只看里面的内容和按钮文字
vi.mock('@/ui/ConfirmDialog', () => ({
  ConfirmDialog: (p: {
    title: string
    description: ReactNode
    confirmLabel: string
    extra?: { label: string }
    warn?: boolean
    confirmDisabled?: boolean
  }) => (
    <div data-warn={p.warn ? 'yes' : 'no'} data-disabled={p.confirmDisabled ? 'yes' : 'no'}>
      <h3>{p.title}</h3>
      {p.description}
      <button>{p.confirmLabel}</button>
      {p.extra && <button>{p.extra.label}</button>}
    </div>
  ),
}))
import { I18nProvider } from '@/i18n/I18nProvider'
import { ExportDialog } from './ExportDialog'

const KEY = 'sk-proj-' + 'DEMO0DEMO0DEMO0DEMO0DEMO0' + 'Qm2z'
const user = (id: string, text: string): Item => ({ kind: 'user', id, text, createdAt: 0 })
const reply = (id: string, text: string): Item => ({ kind: 'assistant', id, text, status: 'completed' })
const record = { title: '修复登录页', engine: 'claude', model: 'claude-opus-5-5' }

sessions.clean = { record, items: [user('u1', '你好'), reply('a1', '你好呀'), user('u2', '再见'), reply('a2', '再见')] }
sessions.leaky = {
  record,
  items: [user('u1', '你好'), reply('a1', '好'), user('u2', `key: OPENAI_API_KEY=${KEY}`), reply('a2', '收到')],
}
sessions.omp = { record: { ...record, engine: 'omp' }, items: sessions.leaky.items }
sessions.empty = { record, items: [] }
// 标题里有密钥，但只导出范围外没有命中的那一轮
sessions.titled = {
  record: { ...record, title: `export OPENAI_API_KEY=${KEY}` },
  items: [user('u1', '你好'), reply('a1', '好'), user('u2', '再见'), reply('a2', '再见')],
}

const render = (sessionId: string, itemId?: string, format?: 'omp') =>
  renderToStaticMarkup(
    <I18nProvider>
      <ExportDialog request={{ sessionId, itemId, format }} />
    </I18nProvider>,
  )

describe('ExportDialog', () => {
  it('没有命中：只有一行绿色提示，按钮是「导出…」', () => {
    const html = render('clean')
    expect(html).toContain('已检查所选内容，没有发现疑似密钥')
    expect(html).toContain('<button>导出…</button>')
    expect(html).toContain('复制到剪贴板')
    expect(html).toContain('2 条用户消息 · 2 条回复 · 0 次工具调用')
    expect(html).toContain('修复登录页.md')
    expect(html).not.toContain('data-export-secrets')
  })

  it('有命中：列出类型、轮次和打码片段，默认打码，不出现明文', () => {
    const html = render('leaky')
    expect(html).toContain('发现 1 处疑似密钥')
    expect(html).toContain('第 2 轮 · 用户消息')
    expect(html).toContain('导出（已打码 1 处）…')
    expect(html).toContain('data-warn="no"')
    expect(html).toContain('KEY=')
    expect(html).not.toContain(KEY)
    expect(html).not.toContain('DEMO0DEMO0')
  })

  it('从消息菜单打开：范围预选那一轮，范围外的命中不出现', () => {
    const html = render('leaky', 'a1')
    expect(html).toContain('value="1"')
    expect(html).not.toContain('发现 1 处疑似密钥')
    expect(html).toContain('修复登录页（第 1 轮）.md')
  })

  it('范围里没命中，标题里的密钥也打码，文件名不带明文', () => {
    const html = render('titled', 'a2')
    expect(html).toContain('没有发现疑似密钥')
    // 对话框副标题仍显示原标题（只在界面里），文件名是打码后的
    expect(html).toContain('export OPENAI_API_KEY=••••（第 2 轮）.md')
  })

  it('没有内容：导出按钮不可点', () => {
    expect(render('empty')).toContain('data-disabled="yes"')
  })

  it('oh-my-pi 会话多一种它自己的 HTML：整个会话、不能打码、没有复制，有命中要再确认', () => {
    expect(render('clean')).not.toContain('HTML（oh-my-pi）')
    expect(render('omp')).toContain('HTML（oh-my-pi）')
    const html = render('omp', 'a2', 'omp')
    expect(html).toContain('打开时要联网加载查看器')
    expect(html).toContain('会话里有 1 处疑似密钥，这种格式会原样带上')
    expect(html).toContain('<button>原样导出…</button>')
    expect(html).toContain('修复登录页.html')
    expect(html).toContain('data-warn="yes"')
    expect(html).not.toContain('复制到剪贴板')
    expect(html).not.toContain('export-secret-choice')
  })
})
