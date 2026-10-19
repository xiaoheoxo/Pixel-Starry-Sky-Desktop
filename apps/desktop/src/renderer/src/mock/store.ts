// 演示模式下的订阅套餐与充值目录（--demo），形状同 GET /v1/platform/store 解析后的结果
import type { StoreCatalog } from '../../../shared/types/account'

const none = { fiveHour: null, daily: null, weekly: null, monthly: null }

export const demoStore: StoreCatalog = {
  enabled: true,
  currency: 'CNY',
  plans: [
    {
      id: 1,
      name: '基础周卡',
      description: '适合偶尔使用',
      price: 30,
      originalPrice: null,
      currency: 'CNY',
      validityDays: 7,
      features: ['支持 Claude、Codex 引擎'],
      groupName: 'pixelsky-basic',
      groupId: 1,
      quotas: { ...none, fiveHour: 2, weekly: 20 },
      sort: 10,
    },
    {
      id: 2,
      name: 'Pro 月卡',
      description: '适合日常开发',
      price: 99,
      originalPrice: 129,
      currency: 'CNY',
      validityDays: 30,
      features: ['支持 Claude、Codex 引擎', '优先排队'],
      groupName: 'pixelsky-pro',
      groupId: 2,
      quotas: { fiveHour: 5, daily: 10, weekly: 50, monthly: 150 },
      sort: 20,
    },
    {
      id: 3,
      name: 'Max 季卡',
      description: '适合多会话并行',
      price: 799,
      originalPrice: null,
      currency: 'CNY',
      validityDays: 90,
      features: ['支持 Claude、Codex 引擎', '优先排队', '更高并发'],
      groupName: 'pixelsky-max',
      groupId: 3,
      quotas: { fiveHour: 20, daily: 40, weekly: 200, monthly: null },
      sort: 30,
    },
  ],
  recharge: {
    enabled: true,
    min: 5,
    max: 1000,
    multiplier: 1,
    feeRate: 0,
    bonusMode: 'bonus',
    bonusTiers: [
      { minAmount: 100, bonusPercent: 5 },
      { minAmount: 500, bonusPercent: 10 },
    ],
    usdToCnyRate: 7,
  },
  methods: [
    { type: 'alipay', label: '支付宝' },
    { type: 'wxpay', label: '微信支付' },
  ],
  checkout: { enabled: true, methods: ['alipay', 'wxpay'], orderTimeoutMinutes: 30 },
  helpText: '充值额度不会过期，订阅额度用完后从余额扣除。',
  purchaseUrl: 'https://panel.example.com/purchase',
  redeemUrl: 'https://panel.example.com/redeem',
}
