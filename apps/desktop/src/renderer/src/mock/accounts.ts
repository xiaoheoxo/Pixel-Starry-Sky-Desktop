// 订阅账号多开的演示数据（docs/ui/engine-accounts.md、engine-accounts-claude.md，照样式稿 docs/ui/multi-account-mockup.html）
import type { AccountEngine, EngineAccountQuota, EngineAccounts } from '@pixelsky/protocol'
import type { DemoAccounts } from '@/data/demo'

const hour = 3_600_000
const now = Date.now()

/** 两个引擎同样三个账号（原来的 / 公司 / 备用，备用登录失效），套餐名各按各家的 */
function accounts(
  engine: AccountEngine,
  plans: [string, string, string],
): { list: EngineAccounts; quota: EngineAccountQuota[] } {
  return {
    list: {
      engine,
      current: 'default',
      accounts: [
        { id: 'default', email: 'linxia@example.com', plan: plans[0], label: null, addedAt: 0, status: 'ok' },
        {
          id: 'a_0d3f9a1c2b7e',
          email: 'work@company.com',
          plan: plans[1],
          label: '公司',
          addedAt: now - 30 * 24 * hour,
          status: 'ok',
        },
        {
          id: 'a_7c2e5b8d1f04',
          email: 'side@example.com',
          plan: plans[2],
          label: '备用',
          addedAt: now - 60 * 24 * hour,
          status: 'expired',
        },
      ],
      auto: { enabled: false, order: 'list', switchBack: true, notice: true },
    },
    quota: [
      {
        id: 'default',
        windows: [
          { id: 'five_hour', durationMins: 300, usedPercent: engine === 'claude' ? 39 : 82, resetsAt: now + 2 * hour },
          {
            id: 'seven_day',
            durationMins: 10080,
            usedPercent: engine === 'claude' ? 61 : 47,
            resetsAt: now + 3 * 24 * hour,
          },
        ],
        blocked: false,
        observedAt: now,
      },
      {
        id: 'a_0d3f9a1c2b7e',
        windows: [
          { id: 'five_hour', durationMins: 300, usedPercent: 4, resetsAt: now + 4 * hour },
          { id: 'seven_day', durationMins: 10080, usedPercent: 12, resetsAt: now + 5 * 24 * hour },
        ],
        blocked: false,
        observedAt: now,
      },
    ],
  }
}

export const demoAccounts: DemoAccounts = {
  codex: accounts('codex', ['plus', 'team', 'pro']),
  claude: accounts('claude', ['max', 'team', 'pro']),
}
