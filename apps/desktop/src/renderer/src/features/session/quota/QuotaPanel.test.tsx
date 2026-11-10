import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { quotaWindowId, type AccountQuota, type QuotaWindow } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { setCurrentLocale } from '@/i18n/core'
import { QuotaPanel, type QuotaPanelProps } from './QuotaPanel'

// 弹窗内容的各状态与无障碍标记（静态渲染，不依赖 DOM）。定位、Esc、焦点回按钮、点外面关在 QuotaPopover 的 effect 里，没有 DOM 环境测。

const at = (hour: number, minute: number, day = 0): number => new Date(2026, 9, 19 + day, hour, minute).getTime()
const NOW = at(14, 32)

afterEach(() => {
  vi.unstubAllGlobals()
  setCurrentLocale('zh-CN')
})

const win = (
  durationMins: number,
  usedPercent: number,
  resetsAt: number | null = null,
  extra: Partial<QuotaWindow> = {},
): QuotaWindow => ({ id: quotaWindowId(durationMins), durationMins, usedPercent, resetsAt, ...extra })

const quota = (over: Partial<AccountQuota> = {}): AccountQuota => ({
  provider: 'claude',
  status: 'ok',
  plan: 'max',
  account: 'linxia@example.com',
  windows: [],
  extras: {},
  blocked: null,
  observedAt: at(14, 31),
  fetchedAt: at(14, 31),
  source: 'usage',
  refreshable: true,
  error: null,
  ...over,
})

const claude = (): AccountQuota =>
  quota({
    windows: [win(300, 42, at(16, 45)), win(10_080, 18, at(9, 0, 3))],
    extras: {
      models: [{ name: 'Opus', durationMins: 10_080, usedPercent: 61, resetsAt: at(9, 0, 3) }],
      extraUsage: { enabled: true, used: 12.4, limit: 50, currency: 'USD', usedPercent: 24.8 },
    },
  })

function render(
  props: Partial<QuotaPanelProps> & { q?: AccountQuota | null },
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): string {
  vi.stubGlobal('localStorage', { getItem: () => locale, setItem: () => undefined })
  setCurrentLocale(locale)
  const { q, ...rest } = props
  const quotaValue = q === undefined ? claude() : q
  return renderToStaticMarkup(
    <I18nProvider>
      <QuotaPanel provider={quotaValue?.provider ?? 'claude'} quota={quotaValue} now={NOW} {...rest} />
    </I18nProvider>,
  )
}

const count = (html: string, needle: string): number => html.split(needle).length - 1

describe('弹窗外壳与无障碍', () => {
  it('role=dialog，aria-label 是标题，没有 aria-modal（右侧浏览器按它判断藏不藏）', () => {
    const html = render({})
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="Claude 账号额度"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('data-quota-popover')
    expect(html).not.toContain('aria-modal')
    expect(html).toContain('w-[344px]')
  })
  it('刷新和关闭按钮有名字', () => {
    const html = render({})
    expect(html).toContain('aria-label="刷新额度"')
    expect(html).toContain('aria-label="关闭"')
  })
})

describe('Claude：两张卡片 + 其它', () => {
  const html = render({})
  it('头部：标题、套餐小标签、打码的账号和更新时间', () => {
    expect(html).toContain('Claude 账号额度')
    expect(html).toContain('>Max<')
    expect(html).toContain('l•••@example.com · 14:31 更新')
    expect(html).toContain('title="linxia@example.com"')
  })
  it('卡片：左 5 小时右本周，大数字 + 已用 + 恢复时间；悬停全写', () => {
    expect(html).toContain('>5 小时内<')
    expect(html).toContain('42%<small')
    expect(html).toContain('>已用</small>')
    expect(html).toContain('16:45 恢复')
    expect(html).toContain('周四 09:00 恢复')
    expect(html).toContain('title="2 小时 13 分后恢复（今天 16:45）"')
    expect(html.indexOf('>5 小时内<')).toBeLessThan(html.indexOf('>本周<'))
  })
  it('其它：分模型周额度、额外用量', () => {
    expect(html).toContain('>其它<')
    expect(html).toContain('本周 · Opus')
    expect(html).toContain('61%')
    expect(html).toContain('额外用量（本月）')
    expect(html).toContain('$12.40 / $50')
  })
  it('进度条 role=progressbar 带 aria 属性（两张卡片 + 两行）', () => {
    expect(count(html, 'role="progressbar"')).toBe(4)
    expect(html).toContain('aria-label="5 小时内" aria-valuenow="42" aria-valuemin="0" aria-valuemax="100"')
    expect(html).toContain('aria-label="本周 · Opus" aria-valuenow="61"')
  })
  it('底部：在 claude.ai 查看（外链）、额度按钮设置；没有演示数据标记', () => {
    expect(html).toContain('href="https://claude.ai/settings/usage"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('在 claude.ai 查看')
    expect(html).toContain('额度按钮设置')
    expect(html).not.toContain('演示数据')
  })
  it('没有提示', () => {
    expect(html).not.toContain('role="status"')
  })
})

describe('ChatGPT', () => {
  const q = quota({
    provider: 'chatgpt',
    plan: 'plus',
    windows: [win(300, 27, at(18, 12)), win(10_080, 54, at(11, 20, 1))],
    extras: { credits: { hasCredits: true, unlimited: false, balance: 120 } },
  })
  it('两张卡片 + 点数在「其它」里', () => {
    const html = render({ q })
    expect(html).toContain('ChatGPT 账号额度')
    expect(html).toContain('>Plus<')
    expect(html).toContain('Codex 额度点数')
    expect(html).toContain('剩余 120')
    expect(html).toContain('href="https://chatgpt.com/codex/settings/usage"')
    expect(html).toContain('在 ChatGPT 查看')
  })
  it('只有一个窗口：一张铺满', () => {
    const html = render({ q: quota({ provider: 'chatgpt', plan: 'free', windows: [win(10_080, 36, at(8, 0, 3))] }) })
    expect(html).toContain('grid-cols-1')
    expect(html).not.toContain('grid-cols-2')
    expect(html).toContain('36%')
  })
  it('没有窗口只有点数：一张点数卡片，没有进度条', () => {
    const html = render({
      q: quota({
        provider: 'chatgpt',
        plan: 'business',
        extras: { credits: { hasCredits: true, unlimited: false, balance: 2480 } },
      }),
    })
    expect(html).toContain('grid-cols-1')
    expect(html).toContain('2,480')
    expect(html).toContain('>剩余</small>')
    expect(html).toContain('没有 5 小时 / 每周上限，点数用完前都能用')
    expect(html).not.toContain('role="progressbar"')
  })
})

describe('平台', () => {
  const q = quota({
    provider: 'platform',
    plan: 'Pro 月卡',
    account: '林夏',
    windows: [win(300, 25, null, { money: { used: 0.5, limit: 2, currency: 'USD' } })],
    extras: { balance: { amount: 12.34, currency: 'USD' } },
  })
  const html = render({
    q,
    balanceText: '$12.34',
    planLimits: [{ id: 'daily', used: 1.2, limit: 10, currency: 'USD' }],
  })
  it('左 5 小时（金额，不写恢复时间），右余额', () => {
    expect(html).toContain('像素星空账号额度')
    expect(html).toContain('$0.50 / $2.00')
    expect(html).not.toContain('恢复')
    expect(html).toContain('>余额<')
    expect(html).toContain('$12.34')
  })
  it('套餐额度进「其它」', () => {
    expect(html).toContain('套餐 · 每天')
    expect(html).toContain('$1.20 / $10.00')
  })
  it('底部是「账号设置」，不是外链；账号名不打码', () => {
    expect(html).toContain('账号设置')
    expect(html).not.toContain('target="_blank"')
    expect(html).toContain('林夏 · ')
  })
})

describe('提示', () => {
  it('快用完：橙色提示，不给换通道', () => {
    const html = render({ q: quota({ windows: [win(300, 86, at(15, 18)), win(10_080, 39, at(9, 0, 3))] }) })
    expect(html).toContain('role="status"')
    expect(html).toContain('5 小时内已用 86%')
    expect(html).toContain('，用完后要等到 15:18 才能继续用这个账号。')
    expect(html).toContain('text-warn')
    expect(html).not.toContain('换通道')
  })
  it('用完：整块红底、数字写已用完、恢复时间红色，提示里有换通道', () => {
    const q = quota({
      provider: 'chatgpt',
      plan: 'plus',
      windows: [win(300, 12, at(18, 37)), win(10_080, 100, at(11, 20, 1))],
    })
    const html = render({ q, onSwitchChannel: () => undefined })
    expect(html).toContain('bg-danger/10')
    expect(html).toContain('>已用完<')
    expect(html).toContain('本周额度已用完')
    expect(html).toContain('，明天 11:20 恢复；在这之前发消息会被拒绝。')
    expect(html).toContain('>换通道<')
    expect(html).toContain('text-danger')
  })
})

describe('读取中、失败、刷新完成', () => {
  it('读取中：占位卡片，不出现刷新按钮，不闪动画时 motion-reduce 关掉', () => {
    const html = render({ q: null, loading: true })
    expect(count(html, 'animate-pulse')).toBe(2)
    expect(html).toContain('motion-reduce:animate-none')
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('aria-label="刷新额度"')
    expect(html).not.toContain('role="progressbar"')
  })
  it('失败且没有数据：原因 + 对话不受影响', () => {
    const html = render({
      q: quota({ status: 'error', error: { code: 'network', message: '连不上 claude.ai' }, observedAt: null }),
    })
    expect(html).toContain('没能读到额度：连不上 claude.ai')
    expect(html).toContain('对话不受影响，可以稍后点右上角刷新再试。')
    expect(html).toContain('text-danger')
    expect(html).not.toContain('role="progressbar"')
  })
  it('失败但有旧数据：照常显示卡片，下面一行红字', () => {
    const html = render({
      q: { ...claude(), status: 'error', error: { code: 'timeout', message: '读取额度超时' } },
    })
    expect(html).toContain('42%<small')
    expect(html).toContain('读取额度超时')
    expect(html).not.toContain('刷新失败：读取额度超时')
  })
  it('失败原因只带一层前缀：读取额度失败不再套「没能读到额度：」', () => {
    const failed = quota({
      status: 'error',
      error: { code: 'failed', message: '读取额度失败：boom' },
      observedAt: null,
    })
    const zh = render({ q: failed })
    expect(zh).toContain('读取额度失败：boom')
    expect(zh).not.toContain('没能读到额度：读取额度失败')
    const en = render({ q: failed }, 'en-US')
    expect(en).toContain('Failed to read usage limits: boom')
    expect(en).not.toContain("Couldn't read usage limits: Failed to read")
    const stale = render({
      q: { ...claude(), status: 'error', error: { code: 'failed', message: '读取额度失败：boom' } },
    })
    expect(stale).not.toContain('刷新失败：读取额度失败')
    expect(stale).toContain('读取额度失败：boom')
  })
  it('network / engine-unavailable 是名词短语，照旧套前缀', () => {
    const error = { code: 'engine-unavailable' as const, message: 'Codex 现在不可用' }
    expect(render({ q: quota({ status: 'error', error }) })).toContain('没能读到额度：Codex 现在不可用')
    expect(render({ q: { ...claude(), status: 'error', error } })).toContain('刷新失败：Codex 现在不可用')
  })
  it('还没有数据也没在读取', () => {
    expect(render({ q: quota({ status: 'empty' }) })).toContain('还没有读到额度数据')
    expect(render({ q: quota({ status: 'empty', refreshable: false }) })).toContain('每轮对话结束后才会更新额度')
  })
  it('刷新完成：对勾（绿色）、aria-label 变成已刷新', () => {
    const html = render({ refreshed: true })
    expect(html).toContain('aria-label="已刷新"')
    expect(html).toContain('text-success')
    expect(html).not.toContain('aria-label="刷新额度"')
  })
  it('刷新中（有旧数据）：图标转，按钮 aria-disabled', () => {
    const html = render({ loading: true })
    expect(html).toContain('animate-spin')
    expect(html).toContain('aria-disabled="true"')
  })
  it('refreshable=false：刷新禁用并说明原因', () => {
    const html = render({ q: { ...claude(), refreshable: false } })
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain(
      'title="这个版本的 Claude Code 不能主动读取额度，每轮对话后会自动更新；更新 Claude Code 后可以手动刷新"',
    )
  })
})

describe('演示数据', () => {
  it('弹窗底部写演示数据', () => {
    expect(render({ q: { ...claude(), source: 'demo' }, demo: true })).toContain('演示数据')
  })
})

describe('英文界面', () => {
  const html = render({ q: { ...claude(), plan: 'pro' }, demo: true }, 'en-US')
  it('标题、卡片、其它、底部', () => {
    expect(html).toContain('aria-label="Claude usage limits"')
    expect(html).toContain('>5-hour limit<')
    expect(html).toContain('>Weekly limit<')
    expect(html).toContain('Weekly limit · Opus')
    expect(html).toContain('Extra usage (this month)')
    expect(html).toContain('>used</small>')
    expect(html).toContain('Resets 4:45 PM')
    expect(html).toContain('View on claude.ai')
    expect(html).toContain('Usage button settings')
    expect(html).toContain('Demo data')
    expect(html).toContain('Updated 2:31 PM')
    expect(html).toContain('aria-label="Refresh usage"')
  })
})

describe('重置卡（docs/ui/codex-reset-card.md §2）', () => {
  const NOW_RC = 1_800_000_000_000
  const withResets = (onUse?: () => void, auto: number | null = null) =>
    renderToStaticMarkup(
      <I18nProvider>
        <QuotaPanel
          provider="chatgpt"
          now={NOW_RC}
          resetAuto={auto}
          onUseResetCredit={onUse}
          quota={
            {
              provider: 'chatgpt',
              status: 'ok',
              plan: 'pro',
              account: null,
              windows: [{ id: 'seven_day', durationMins: 10_080, usedPercent: 91, resetsAt: NOW_RC + 3 * 86_400_000 }],
              extras: {
                resetCredits: {
                  available: 5,
                  credits: [
                    { id: 'a', expiresAt: NOW_RC + 86_400_000, title: null },
                    { id: 'b', expiresAt: null, title: '活动赠送' },
                  ],
                },
              },
              blocked: null,
              observedAt: NOW_RC,
              fetchedAt: NOW_RC,
              source: 'usage',
              refreshable: true,
              error: null,
            } as AccountQuota
          }
        />
      </I18nProvider>,
    )

  it('显示张数、快过期、不过期、还有几张；给了回调才有「使用一张」', () => {
    const html = withResets(() => undefined)
    expect(html).toContain('重置卡 5 张')
    expect(html).toContain('快过期')
    expect(html).toContain('不过期')
    expect(html).toContain('还有 3 张')
    expect(html).toContain('使用一张')
    expect(html).toContain('自动使用没开')
    expect(withResets()).not.toContain('使用一张')
    expect(withResets(undefined, 95)).toContain('本周到 95% 时')
  })
})
