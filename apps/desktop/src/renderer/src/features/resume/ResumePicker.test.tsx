// 接着终端里的 Claude Code 会话：选择框的展示（分组、状态、选择面板、空 / 错误 / 读取中）
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
// 引擎的 store 在导入时读 window.pixelsky：先放一个空的 window
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
// 输入框是 CodeMirror，这里不需要
vi.mock('@/features/session/composerInput/ComposerInput', () => ({ composerInputFor: () => null }))
import { I18nProvider } from '@/i18n/I18nProvider'
import type { NativeSessionDetail, NativeSessionSummary } from '@pixelsky/protocol'
import { ResumePickerView, type PickerViewProps } from './ResumePicker'
import { filterRows, groupRows, mergeRows } from './model'

const NOW = Date.now()
const MIN = 60_000
const DAY = 24 * 60 * MIN
const id = (n: number): string => `3f1c2a10-6d7e-4b88-9a31-0c5d8e7a100${n}`
const row = (
  n: number,
  extra: Partial<NativeSessionSummary> & { ago: number; last: string },
): [NativeSessionSummary, NativeSessionDetail] => {
  const { ago, last, ...rest } = extra
  const summary: NativeSessionSummary = {
    id: id(n),
    title: `会话 ${n}`,
    firstPrompt: '',
    lastPrompt: null,
    branch: 'main',
    subdir: null,
    updatedAt: NOW - ago,
    size: 1_000_000,
    model: null,
    source: 'terminal',
    ownerId: null,
    live: null,
    ...rest,
  }
  return [
    summary,
    {
      id: id(n),
      lastPrompt: last,
      title: summary.title,
      lastActive: summary.updatedAt,
      model: null,
      branch: 'main',
      superseded: false,
      skipped: false,
    },
  ]
}
// 和演示数据同样的 7 行：普通、子文件夹、已被占用、终端里正开着、别的程序正开着、很大的、可能还开着
const FIXTURE = [
  row(1, { title: '修复 Caddy 超时', ago: 12 * MIN, last: '部署后再看一下 499 还有没有' }),
  row(2, { title: '调手机端布局', subdir: 'apps/mobile', ago: 4 * DAY, last: '再截一张图' }),
  row(3, { title: '规划 /resume', ownerId: 'demo-claude-tools', ago: 120 * MIN, last: '先出规划' }),
  row(4, { title: '发布 0.4.7', live: 'terminal', ago: 40_000, last: '检查一下 CI 有没有过' }),
  row(5, { title: '整理项目清单', source: 'other', live: 'other', ago: 3 * MIN, last: '好了，帮我提交' }),
  row(6, {
    title: '重构 extpacks 校验',
    source: 'other',
    size: 221 * 1024 * 1024,
    ago: 3 * DAY,
    last: '跑一下全量检查',
  }),
  row(7, { title: '调试模型菜单', source: 'other', live: 'maybe', ago: 90_000, last: '再试一次' }),
]

const demoRows = (query = '') =>
  groupRows(
    filterRows(
      mergeRows(
        FIXTURE.map(([summary]) => summary),
        new Map(FIXTURE.map(([, detail]) => [detail.id, detail] as const)),
      ),
      query,
    ),
  )

const render = (extra: Partial<PickerViewProps> = {}): string => {
  const groups = extra.groups ?? demoRows()
  const props: PickerViewProps = {
    engine: 'claude',
    groups,
    query: '',
    selectedId: groups.all[0]?.id ?? null,
    loading: false,
    error: null,
    reading: false,
    notice: null,
    busy: null,
    waiting: new Set(),
    help: false,
    projectPath: 'D:\\PixelSky',
    noProject: false,
    onQuery: () => undefined,
    onSelect: () => undefined,
    onActivate: () => undefined,
    onWait: () => undefined,
    onCancelImport: () => undefined,
    onRetry: () => undefined,
    onHelp: () => undefined,
    onClose: () => undefined,
    ...extra,
  }
  return renderToStaticMarkup(
    <I18nProvider>
      <ResumePickerView {...props} />
    </I18nProvider>,
  )
}

describe('ResumePickerView', () => {
  it('演示数据：未被占用的在上，已被占用的收进底部「已在像素星空里」一组', () => {
    const html = render()
    expect(html).toContain('data-resume-picker')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('role="listbox"')
    expect(html.match(/data-resume-row=/g)).toHaveLength(7)
    expect(html).toContain('已在像素星空里（1）')
    expect(html.indexOf('data-resume-group="owned"')).toBeGreaterThan(html.lastIndexOf('data-live='))
    expect(html).toMatch(/data-resume-row="3f1c2a10-6d7e-4b88-9a31-0c5d8e7a1003"[^>]*data-owned/)
  })
  it('第二行写最后一句、来源，正开着的行带状态标签，子文件夹有标签', () => {
    const html = render()
    expect(html).toContain('最后：部署后再看一下 499 还有没有')
    expect(html).toContain('终端里正开着')
    expect(html).toContain('别的程序正开着')
    expect(html).toContain('可能还开着')
    expect(html).toContain('apps/mobile')
    expect(html).toContain('其他程序')
  })
  it('选中正开着的行展开「复制一份接着聊」和「我去那边关掉再来」', () => {
    const groups = demoRows()
    const live = groups.all.find(r => r.live === 'terminal')!
    const html = render({ groups, selectedId: live.id })
    expect(html).toContain('data-resume-choice')
    expect(html).toContain('data-resume-action="copy"')
    expect(html).toContain('data-resume-action="close-there"')
    expect(html.indexOf('复制一份接着聊')).toBeLessThan(html.indexOf('我去那边关掉再来'))
    // 没选中它时不展开
    const plain = groups.all.find(r => !r.live && !r.ownerId)!
    expect(render({ groups, selectedId: plain.id })).not.toContain('data-resume-choice')
  })
  it('可能还开着：主按钮是直接接着聊，复制放次要位置', () => {
    const groups = demoRows()
    const maybe = groups.all.find(r => r.live === 'maybe')!
    const html = render({ groups, selectedId: maybe.id })
    expect(html.indexOf('data-resume-action="inplace"')).toBeLessThan(html.indexOf('data-resume-action="copy"'))
    expect(html).not.toContain('data-resume-action="close-there"')
  })
  it('可能还开着的说明按引擎区分：Codex 说写入锁，Claude 说最近写过', () => {
    const groups = demoRows()
    const maybe = groups.all.find(r => r.live === 'maybe')!
    expect(render({ groups, selectedId: maybe.id })).toContain('最近几分钟内被写过')
    const codex = render({ engine: 'codex', groups, selectedId: maybe.id })
    expect(codex).toContain('写入锁还在')
    expect(codex).not.toContain('最近几分钟')
  })
  it('点过「我去那边关掉再来」的行提示关掉后再按 Enter，不再展开按钮', () => {
    const groups = demoRows()
    const live = groups.all.find(r => r.live === 'terminal')!
    const html = render({ groups, selectedId: live.id, waiting: new Set([live.id]) })
    expect(html).toContain('关掉后再按 Enter')
    expect(html).not.toContain('data-resume-choice')
  })
  it('导入大文件：行内显示百分比和取消', () => {
    const groups = demoRows()
    const big = groups.all.find(r => r.size > 200 * 1024 * 1024)!
    const html = render({ groups, selectedId: big.id, busy: { id: big.id, percent: 42 } })
    expect(html).toContain('正在读取 42%')
    expect(html).toContain('data-resume-action="cancel"')
  })
  it('过滤后没有匹配 / 没有任何会话 / 读不到目录 / 读取中', () => {
    expect(render({ groups: demoRows('不存在的词'), query: '不存在的词' })).toContain('没有匹配的会话')
    const none = groupRows([])
    expect(render({ groups: none })).toContain('这个文件夹还没有 Claude Code 会话记录')
    const error = render({ groups: none, error: '无权限' })
    expect(error).toContain('读不到 Claude Code 的会话目录：无权限')
    expect(error).toContain('data-resume-action="retry"')
    expect(render({ groups: none, loading: true })).toContain('正在读取会话…')
    expect(render({ reading: true })).toContain('data-resume-reading')
    expect(render({ groups: none, noProject: true })).toContain('先打开一个项目')
  })
  it('重新查找：头部一直有（读取中、没有项目时灰掉）；没有任何会话时空状态里也有，过滤没匹配时没有', () => {
    const none = groupRows([])
    expect(render()).toMatch(/<button[^>]*aria-label="重新查找"[^>]*data-resume-action="recheck"(?![^>]*disabled)/)
    expect(render({ loading: true })).toMatch(/<button[^>]*data-resume-action="recheck"[^>]*disabled/)
    expect(render({ groups: none, noProject: true })).toMatch(/<button[^>]*data-resume-action="recheck"[^>]*disabled/)
    expect(render({ groups: none })).toContain('data-resume-action="recheck-empty"')
    const filtered = render({ groups: demoRows('不存在的词'), query: '不存在的词' })
    expect(filtered).not.toContain('data-resume-action="recheck-empty"')
  })
  it('engine 为 codex：标题、空状态、错误、帮助是 Codex 的', () => {
    const none = groupRows([])
    expect(render({ engine: 'codex' })).toContain('接着 Codex 会话')
    expect(render({ engine: 'claude' })).toContain('接着 Claude Code 会话')
    expect(render({ engine: 'codex', groups: none })).toContain('这个文件夹还没有 Codex 会话记录')
    // 引擎真实抛的整句，后面接原因：不再套一层「读不到 Codex 的会话：」
    const error = render({ engine: 'codex', groups: none, error: 'Codex 没装好，读不到它的会话：spawn ENOENT' })
    expect(error).toContain('Codex 没装好，读不到它的会话：spawn ENOENT')
    expect(error).not.toContain('读不到 Codex 的会话')
    expect(error).not.toContain('Claude Code')
    expect(render({ engine: 'codex', groups: none, error: 'EACCES' })).toContain('读不到 Codex 的会话：EACCES')
    const help = render({ engine: 'codex', help: true })
    expect(help).toContain('Codex 不让两个程序同时写一个会话')
    expect(help).not.toContain('--resume')
    expect(render({ engine: 'claude', help: true })).toContain('--resume')
  })
  it('状态栏的一句话和帮助', () => {
    expect(render({ notice: '这个会话的记录已经不在了' })).toContain('这个会话的记录已经不在了')
    const html = render({ help: true })
    expect(html).toContain('data-resume-help')
    expect(html).toContain('新开一个对话，当前对话不动')
  })
})
