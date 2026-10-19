import { describe, expect, it } from 'vitest'
import { codedError } from '@pixelsky/protocol'
import {
  REPORT_DETAIL_MAX,
  defaultReportVersion,
  detailActions,
  engineMinVersion,
  formatSize,
  reportInputOf,
  reportProblem,
  type DetailActionsInput,
} from './detailActions'
import { reportErrorText } from './ReportDialog'

const base: DetailActionsInput = {
  latest: { version: '1.2.0', engineRange: '>=0.4.0' },
  local: null,
  appVersion: '0.4.10-beta',
}
const store = (over: Partial<NonNullable<DetailActionsInput['local']>> = {}): DetailActionsInput['local'] => ({
  source: 'store',
  version: '1.0.0',
  enabled: true,
  ...over,
})
const ids = (i: DetailActionsInput): string[] => detailActions(i).actions.map(a => a.id)

describe('detailActions', () => {
  it('没装：只有「安装」，装最新版', () => {
    const r = detailActions(base)
    expect(r.actions).toEqual([{ id: 'install', version: '1.2.0', disabled: false, reason: undefined }])
    expect(r.notes).toEqual([])
  })

  it('版本要求不满足：「安装」灰掉，原因写要求的版本', () => {
    const r = detailActions({ ...base, latest: { version: '1.2.0', engineRange: '>=0.5.0' } })
    expect(r.actions[0]).toMatchObject({
      id: 'install',
      disabled: true,
      reason: { kind: 'engineNeed', version: '0.5.0' },
    })
  })

  it('要求的写法认不了时不拦', () => {
    const r = detailActions({ ...base, latest: { version: '1.2.0', engineRange: '0.1 || 0.9' } })
    expect(r.actions[0].disabled).toBe(false)
  })

  it('本机有开发版：安装旁边写「会被开发版替代」', () => {
    expect(detailActions({ ...base, devCopy: true }).notes).toEqual([{ kind: 'devReplace' }])
    expect(detailActions({ ...base, local: { source: 'folder', version: '9.9.9', enabled: true } }).notes).toEqual([
      { kind: 'devReplace' },
    ])
  })

  it('已装同版：卸载和停用', () => {
    expect(ids({ ...base, local: store(), update: undefined })).toEqual(['uninstall', 'disable'])
  })

  it('已装、已关：卸载和启用', () => {
    const r = detailActions({ ...base, local: store({ enabled: false }) })
    expect(r.actions.map(a => [a.id, a.disabled])).toEqual([
      ['uninstall', false],
      ['enable', false],
    ])
  })

  it('有更新：「更新」排在最前', () => {
    const r = detailActions({ ...base, local: store(), update: { latest: '1.2.0', engineOk: true } })
    expect(r.actions.map(a => a.id)).toEqual(['update', 'uninstall', 'disable'])
    expect(r.actions[0].version).toBe('1.2.0')
  })

  it('新版本要求更高：没有「更新」，写「新版本需要像素星空 X」', () => {
    const r = detailActions({
      ...base,
      local: store(),
      update: { latest: '1.2.0', engineOk: false, engineNeed: '>=0.6.0' },
    })
    expect(r.actions.map(a => a.id)).toEqual(['uninstall', 'disable'])
    expect(r.notes).toEqual([{ kind: 'updateNeeds', version: '0.6.0' }])
  })

  it('被平台停用 + 有更早的可用版本：「换回 X」，「启用」灰掉', () => {
    const r = detailActions({
      ...base,
      local: store({ enabled: false, blocked: { reason: '恶意', at: '2026-10-16' } }),
      update: { latest: '0.9.0', engineOk: true, rollbackTo: '0.9.0' },
    })
    expect(r.actions.map(a => [a.id, a.disabled, a.version])).toEqual([
      ['rollback', false, '0.9.0'],
      ['uninstall', false, undefined],
      ['enable', true, undefined],
    ])
    expect(r.actions[2].reason).toEqual({ kind: 'blocked' })
  })

  it('被平台停用、没有可换回的版本：只能卸载', () => {
    const r = detailActions({ ...base, local: store({ enabled: false, blocked: { reason: 'x', at: 'y' } }) })
    expect(r.actions.map(a => a.id)).toEqual(['uninstall', 'enable'])
  })

  it('换回的版本不比本机低时不显示（防降级）', () => {
    const r = detailActions({
      ...base,
      local: store(),
      update: { latest: '1.0.0', engineOk: true, rollbackTo: '1.1.0' },
    })
    expect(r.actions.map(a => a.id)).not.toContain('rollback')
  })

  it('商店下架（latest 为 null）：没装没按钮，已装只有卸载 / 启停', () => {
    expect(detailActions({ ...base, latest: null }).actions).toEqual([])
    expect(ids({ ...base, latest: null, local: store() })).toEqual(['uninstall', 'disable'])
  })

  it('正在安装 / 卸载：按钮全灰', () => {
    const r = detailActions({ ...base, local: store(), update: { latest: '1.2.0', engineOk: true }, busy: true })
    expect(r.actions.every(a => a.disabled)).toBe(true)
  })

  it('只有内置版时按「没装」算', () => {
    expect(ids({ ...base, local: { source: 'builtin', version: '1.0.0', enabled: true } })).toEqual(['install'])
  })
})

describe('engineMinVersion / formatSize', () => {
  it('取出版本号', () => {
    expect(engineMinVersion('>=0.4.0')).toBe('0.4.0')
    expect(engineMinVersion('^0.4.0')).toBe('0.4.0')
    expect(engineMinVersion('0.4')).toBe('0.4')
  })
  it('大小', () => {
    expect(formatSize(100)).toBe('100 B')
    expect(formatSize(52 * 1024)).toBe('52 KB')
    expect(formatSize(1.5 * 1024 * 1024)).toBe('1.5 MB')
  })
})

describe('举报表单', () => {
  const detail = { latest: { version: '1.2.0' } }
  it('默认版本：本机装了用本机的，没装用最新版', () => {
    expect(defaultReportVersion({ version: '1.0.0' }, detail)).toBe('1.0.0')
    expect(defaultReportVersion(null, detail)).toBe('1.2.0')
    expect(defaultReportVersion({ version: null }, detail)).toBe('1.2.0')
  })

  it('原因没选不能交；选「其他」时说明必填', () => {
    expect(reportProblem({ reason: null, detail: '', version: '1.0.0' })).toBe('noReason')
    expect(reportProblem({ reason: 'other', detail: '', version: '1.0.0' })).toBe('detailRequired')
    expect(reportProblem({ reason: 'other', detail: '   ', version: '1.0.0' })).toBe('detailRequired')
    expect(reportProblem({ reason: 'other', detail: '它偷了我的代码', version: '1.0.0' })).toBeNull()
    expect(reportProblem({ reason: 'broken', detail: '', version: '1.0.0' })).toBeNull()
  })

  it('说明最多 2000 字', () => {
    expect(reportProblem({ reason: 'broken', detail: 'a'.repeat(REPORT_DETAIL_MAX), version: '1' })).toBeNull()
    expect(reportProblem({ reason: 'broken', detail: 'a'.repeat(REPORT_DETAIL_MAX + 1), version: '1' })).toBe(
      'detailTooLong',
    )
  })

  it('提交内容去掉首尾空白', () => {
    expect(reportInputOf({ reason: 'broken', detail: ' 不能用 ', version: '1.0.0' })).toEqual({
      reason: 'broken',
      detail: '不能用',
      version: '1.0.0',
    })
  })

  it('云端错误翻成文案：rate_limited / already_reported', () => {
    expect(reportErrorText(codedError('extstore.api.reportRateLimited'))).toContain('今天的举报次数用完了')
    expect(reportErrorText(codedError('extstore.api.alreadyReported'))).toContain('7 天内已经举报过')
  })
})
