import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ExtStoreCheckReport, ExtStorePublisherState } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { PublishTab, type PublishTabProps } from './PublishTab'
import { extension, issue, publisherState, report, version } from './fixtures'

vi.mock('@/ui/ConfirmDialog', () => ({
  ConfirmDialog: (p: { title: string; description: string; confirmLabel: string }) => (
    <div data-confirm>
      {p.title}
      {p.description}
      {p.confirmLabel}
    </div>
  ),
}))

const props = (over: Partial<PublishTabProps> = {}): PublishTabProps => ({
  signedIn: true,
  email: 'alice@example.com',
  state: publisherState([extension()]),
  onSignIn: () => {},
  onRefresh: () => {},
  onRegister: async () => {},
  onWithdraw: async () => {},
  onDelist: async () => {},
  onRelist: async () => {},
  onLoadReport: async () => null,
  picked: null,
  uploading: false,
  onPick: () => {},
  onSubmitUpload: () => {},
  onCancelUpload: () => {},
  ...over,
})

const render = (over: Partial<PublishTabProps> = {}): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <PublishTab {...props(over)} />
    </I18nProvider>,
  )

const withState = (state: ExtStorePublisherState): string => render({ state })

describe('PublishTab', () => {
  it('没登录：说明和登录按钮', () => {
    const html = render({ signedIn: false })
    expect(html).toContain('data-publish="signed-out"')
    expect(html).toContain('登录后才能发布扩展')
    expect(html).not.toContain('data-extension=')
  })

  it('没有发布者：注册表单', () => {
    const html = render({ state: { publisher: null, extensions: [] } })
    expect(html).toContain('data-register')
    expect(html).toContain('发布者名（id 前缀，注册后不能改）')
  })

  it('有发布者：邮箱打码，完整邮箱不出现', () => {
    const html = render()
    expect(html).toContain('lin')
    expect(html).toContain('a•••@example.com')
    expect(html).not.toContain('alice@example.com')
    expect(html).toContain('上传新扩展 / 新版本')
  })

  it('不显示「作者文档」链接', () => {
    const html = render()
    expect(html).not.toContain('作者文档')
    expect(html).not.toContain('authoring-spec')
    expect(html).not.toMatch(/href="[^"]*authoring-spec/)
  })

  it('扩展：下载量、已上架版本、下架按钮', () => {
    const html = render()
    expect(html).toContain('↓ 1284')
    expect(html).toContain('已上架 1.2.0')
    expect(html).toContain('下架')
    expect(html).not.toContain('重新上架')
  })

  it('平台下架：写原因，不显示「重新上架」', () => {
    const html = withState(publisherState([extension({ delisted: true, delistedBy: 'admin', delistReason: '侵权' })]))
    expect(html).toContain('平台下架：侵权')
    expect(html).not.toContain('重新上架')
  })

  it('作者自己下架：显示「重新上架」', () => {
    const html = withState(publisherState([extension({ delisted: true, delistedBy: 'author' })]))
    expect(html).toContain('重新上架')
  })

  it('版本：待审核带撤回；未通过写原因；N 条提示', () => {
    const html = withState(
      publisherState([
        extension({
          versions: [
            version({ version: '1.1.0', status: 'rejected', rejectReason: '缺少 LICENSE' }),
            version({ version: '1.3.0', status: 'pending', hints: 2 }),
          ],
        }),
      ]),
    )
    expect(html).toContain('待审核')
    expect(html).toContain('撤回')
    expect(html).toContain('未通过')
    expect(html).toContain('缺少 LICENSE')
    expect(html).toContain('2 条提示')
  })

  it('点开的版本：有本机结果画三组，没有写「逐条结果只在上传的那台电脑上有」', () => {
    const state = publisherState([
      extension({ versions: [version({ version: '1.2.0' }), version({ version: '1.3.0' })] }),
    ])
    const reports: Record<string, ExtStoreCheckReport | null> = {
      'lin.swift-support@1.3.0': report([
        issue({ zh: '缺 LICENSE', severity: 'error' }),
        issue({ zh: '建议加图标', upload: 'hint' }),
        issue({ zh: '仅本地提示' }),
      ]),
      'lin.swift-support@1.2.0': null,
    }
    const html = render({
      state,
      initialExpanded: ['lin.swift-support@1.3.0', 'lin.swift-support@1.2.0'],
      initialReports: reports,
    })
    expect(html).toContain('data-issue-group="reject"')
    expect(html).toContain('data-issue-group="hint"')
    expect(html).toContain('data-issue-group="note"')
    expect(html).toContain('要改的')
    expect(html).toContain('建议')
    expect(html).toContain('缺 LICENSE')
    expect(html).toContain('逐条结果只在上传的那台电脑上有')
  })

  it('下架确认框文案', () => {
    const html = render({ initialDelist: 'lin.swift-support' })
    expect(html).toContain('下架后不在商店里显示、不能新装；已经装了的人照常能用')
  })

  it('点上传后右侧出现上传面板', () => {
    expect(render({ initialUploadOpen: true })).toContain('data-upload-panel')
    expect(render()).not.toContain('data-upload-panel')
  })
})
