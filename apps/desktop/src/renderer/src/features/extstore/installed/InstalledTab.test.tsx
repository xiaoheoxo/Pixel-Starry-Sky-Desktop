import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
// 图标地址模块在导入时读 window：先放一个空的
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {}
})
import type { ExtPackInfo, ExtStoreUpdates } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { namedPack as fakePack } from './testing'
import { InstalledTab, type InstalledTabProps } from './InstalledTab'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const SITE = 'https://cloud.test'
const receipt = (site = SITE) => ({ version: '1.0.0', installedAt: 1, sha256: 'x', keyId: 'k', site })
const noop = (): void => {}

function render(packs: ExtPackInfo[], over: Partial<InstalledTabProps> = {}, updates: ExtStoreUpdates = {}): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <InstalledTab
        packs={packs}
        updates={updates}
        site={SITE}
        blocklistAt={null}
        now={NOW}
        checking={false}
        installingIds={new Set()}
        busy={false}
        summary={null}
        error={null}
        onOpen={noop}
        onToggle={noop}
        onCheckUpdates={noop}
        onUpdateAll={noop}
        onUpdate={noop}
        onRollback={noop}
        onUninstall={noop}
        {...over}
      />
    </I18nProvider>,
  )
}

/** 取某一行的 HTML */
const rowOf = (html: string, key: string): string => {
  const start = html.indexOf(`data-pack-key="${key}"`)
  expect(start).toBeGreaterThan(-1)
  return html.slice(start, html.indexOf('</li>', start))
}

describe('InstalledTab 顶上的停用名单', () => {
  it('正常：停用名单：MM-DD HH:mm 更新', () => {
    const html = render([], { blocklistAt: new Date(NOW - 2 * 24 * 3600_000).toISOString() })
    expect(html).toMatch(/停用名单：\d\d-\d\d \d\d:\d\d 更新/)
  })
  it('3 天没读到：很久没更新了', () => {
    const html = render([], { blocklistAt: new Date(NOW - 3 * 24 * 3600_000 - 60_000).toISOString() })
    expect(html).toContain('停用名单很久没更新了')
  })
  it('没读到过：不显示这一行', () => {
    expect(render([])).not.toContain('data-blocklist-line')
  })
})

describe('InstalledTab 行', () => {
  const packs = [
    fakePack({ key: 'f', id: 'f.one', source: 'folder', addedAt: 1 }),
    fakePack({ key: 's', id: 's.one', source: 'store', store: receipt(), addedAt: 2 }),
    fakePack({ key: 'b', id: 'b.one', source: 'builtin', addedAt: 3 }),
  ]
  it('三种来源小标，顺序内置 → 商店 → 开发中；内置没有卸载', () => {
    const html = render(packs)
    expect(html.indexOf('data-pack-key="b"')).toBeLessThan(html.indexOf('data-pack-key="s"'))
    expect(html.indexOf('data-pack-key="s"')).toBeLessThan(html.indexOf('data-pack-key="f"'))
    expect(rowOf(html, 'b')).toContain('内置')
    expect(rowOf(html, 'b')).not.toContain('卸载')
    expect(rowOf(html, 's')).toContain('商店')
    expect(rowOf(html, 's')).toContain('卸载')
    expect(rowOf(html, 'f')).toContain('开发中')
    expect(rowOf(html, 'f')).toContain('text-warn')
  })
  it('有新版本：v1.0.0 → 有新版本 2.5.0 + 更新按钮 + 全部更新', () => {
    const html = render(packs, {}, { 's.one': { latest: '2.5.0', engineOk: true } })
    expect(rowOf(html, 's')).toContain('v1.0.0 → 有新版本 2.5.0')
    expect(rowOf(html, 's')).toContain('>更新<')
    expect(html).toContain('全部更新')
  })
  it('新版本要求更高的像素星空：写需要，不显示更新', () => {
    const html = render(packs, {}, { 's.one': { latest: '2.5.0', engineOk: false, engineNeed: '0.5.0' } })
    expect(rowOf(html, 's')).toContain('新版本需要像素星空 0.5.0')
    expect(rowOf(html, 's')).not.toContain('>更新<')
    expect(html).not.toContain('全部更新')
  })
  it('被平台停用：整行标红、开关 disabled、原因和日期、换回', () => {
    const blocked = fakePack({
      key: 'x',
      id: 'x.one',
      source: 'store',
      store: receipt(),
      live: false,
      blocked: { reason: '上传文件内容', at: '2026-10-14T08:00:00Z' },
    })
    const html = render([blocked], {}, { 'x.one': { latest: '1.0.0', engineOk: true, rollbackTo: '0.9.0' } })
    const row = rowOf(html, 'x')
    expect(row).toContain('data-tone="blocked"')
    expect(row).toContain('bg-danger')
    expect(row).toMatch(/role="switch"[^>]*disabled=""/)
    expect(row).toMatch(/已被平台停用：上传文件内容（10-1[34]）/)
    expect(row).toContain('换回 0.9.0')
    expect(row).toContain('卸载')
  })
  it('被停用但没有更早版本：不显示换回，只能卸载', () => {
    const blocked = fakePack({
      key: 'x',
      id: 'x.one',
      source: 'store',
      store: receipt(),
      live: false,
      blocked: { reason: 'r', at: '2026-10-14T08:00:00Z' },
    })
    const row = rowOf(render([blocked]), 'x')
    expect(row).not.toContain('换回')
    expect(row).toContain('卸载')
  })
  it('被替代：灰显，写被谁替代，开关保留', () => {
    const shadowed = fakePack({
      key: 'x',
      id: 'x.one',
      source: 'store',
      store: receipt(),
      live: false,
      shadowedBy: 'folder',
    })
    const row = rowOf(render([shadowed]), 'x')
    expect(row).toContain('data-tone="shadowed"')
    expect(row).toContain('opacity-60')
    expect(row).toContain('已被开发中的同名扩展替代')
    expect(row).not.toMatch(/role="switch"[^>]*disabled=""/)
  })
  it('从别的站点装的：来自站点，不检查更新，没有更新按钮', () => {
    const other = fakePack({ key: 'x', id: 'x.one', source: 'store', store: receipt('https://other.test') })
    const html = render([other], {}, { 'x.one': { latest: '9.0.0', engineOk: true } })
    expect(rowOf(html, 'x')).toContain('来自 https://other.test，不检查更新')
    expect(rowOf(html, 'x')).not.toContain('>更新<')
  })
  it('筛选数量写在按钮上', () => {
    const html = render(packs, {}, { 's.one': { latest: '2.5.0', engineOk: true } })
    expect(html).toContain('有更新 1')
    expect(html).toContain('已停用 0')
  })
})
