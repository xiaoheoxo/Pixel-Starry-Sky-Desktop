import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { UploadPanel } from './UploadPanel'
import { issue, picked, report } from './fixtures'

type Props = Parameters<typeof UploadPanel>[0]
const render = (over: Partial<Props> = {}): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <UploadPanel
        publisherName="lin"
        picked={picked()}
        previous={null}
        uploading={false}
        onPick={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        {...over}
      />
    </I18nProvider>,
  )
const submitDisabled = (html: string): boolean =>
  /<button[^>]*data-submit[^>]*>/.exec(html)?.[0].includes(' disabled=""') ?? false

describe('UploadPanel', () => {
  it('三行核对都在，都过时没有标红的行', () => {
    const html = render()
    expect(html).toContain('不运行代码，不需要权限')
    expect(html).toContain('id 前缀 lin 属于你')
    expect(html).toContain('版本 1.3.0 比已上架的都大')
    expect(html).not.toContain('data-check-ok="false"')
    expect(submitDisabled(html)).toBe(false)
  })

  it('前缀 / 版本号没过的行标红，提交变灰', () => {
    const html = render({ picked: picked({ checks: { permissions: [], prefixOk: false, versionNewer: false } }) })
    expect(html.match(/data-check-ok="false"/g)).toHaveLength(2)
    expect(html).toContain('id 前缀不是你的发布者名 lin')
    expect(html).toContain('不比已上架的版本大')
    expect(submitDisabled(html)).toBe(true)
  })

  it('固定两句版本号提示', () => {
    expect(render({ picked: null })).toContain('被撤回或没通过的版本号可以再用；上架过的版本号永远不能再用。')
  })

  it('三组结果；有会被拒绝的项时提交变灰', () => {
    const html = render({
      picked: picked({
        report: report([
          issue({ zh: '缺 LICENSE', severity: 'error' }),
          issue({ zh: '建议加图标', upload: 'hint' }),
          issue({ zh: '仅本地' }),
        ]),
      }),
    })
    for (const g of ['reject', 'hint', 'note']) expect(html).toContain(`data-issue-group="${g}"`)
    expect(submitDisabled(html)).toBe(true)
  })

  it('只有建议和提示时能提交', () => {
    const html = render({ picked: picked({ report: report([issue({ zh: '建议', upload: 'hint' })]) }) })
    expect(submitDisabled(html)).toBe(false)
  })

  it('本机没检查完：能提交，但写明会占额度', () => {
    const html = render({ picked: picked({ report: report([], { incomplete: true }) }) })
    expect(submitDisabled(html)).toBe(false)
    expect(html).toContain('本机没检查完，可能会被云端拒收，并占用一次上传额度（每天 20 次）')
  })

  it('「（新增）」标记：上一个上架版本没有的种类', () => {
    const html = render({
      picked: picked({ contributes: { grammars: [{}], iconThemes: [{}] } as never }),
      previous: { grammars: [{}] } as never,
    })
    expect(html.match(/（新增）/g)).toHaveLength(1)
    expect(html).toMatch(/文件图标 1[^]*?（新增）/)
  })

  it('上传中：写「云端检查中（最多 1 分钟）」，提交变灰', () => {
    const html = render({ uploading: true })
    expect(html).toContain('云端检查中（最多 1 分钟）')
    expect(submitDisabled(html)).toBe(true)
  })

  it('check_failed：画出云端带回来的结果', () => {
    const html = render({
      cloudReport: report([issue({ zh: '云端发现 X', severity: 'error' })], { blocking: 1 }),
    })
    expect(html).toContain('data-cloud-report')
    expect(html).toContain('云端发现 X')
  })

  it('还没选包：提交变灰，没有核对行', () => {
    const html = render({ picked: null })
    expect(submitDisabled(html)).toBe(true)
    expect(html).not.toContain('data-check-ok')
  })
})
