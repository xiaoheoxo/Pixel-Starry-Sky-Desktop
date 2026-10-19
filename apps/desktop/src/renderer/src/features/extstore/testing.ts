import type { ExtStoreItem } from '@pixelsky/protocol'
import type { ExtStoreBridge } from '../../../../preload/extstore'

// 测试用的假预加载桥（渲染层测试共用）：只读通道回空数据，覆盖项用 over 传

export function fakeExtStoreBridge(over: Partial<ExtStoreBridge> = {}): ExtStoreBridge {
  return {
    catalog: async () => ({ items: [], nextBefore: null }),
    detail: async () => null,
    install: async () => {
      throw new Error('not implemented')
    },
    cancel: async () => {},
    checkUpdates: async () => ({}),
    state: async () => ({ site: 'https://example.test', updates: {}, blocklistAt: null, installing: {} }),
    refreshBlocklist: async () => ({ blocklistAt: null }),
    report: async () => {},
    publisher: async () => ({ publisher: null, extensions: [] }),
    register: async name => ({ name, official: false, createdAt: null }),
    pickUpload: async () => null,
    upload: async () => {
      throw new Error('not implemented')
    },
    withdraw: async () => {},
    delist: async () => {},
    relist: async () => {},
    publishCheck: async () => null,
    onChange: () => () => {},
    ...over,
  } satisfies ExtStoreBridge
}

/** 假的目录项（发现页测试用） */
export function fakeStoreItem(over: Partial<ExtStoreItem> = {}): ExtStoreItem {
  return {
    id: 'acme.hello',
    name: 'Hello',
    description: 'Hello extension',
    publisher: { name: 'acme', official: false },
    version: '1.0.0',
    iconUrl: '/cloud/extensions/acme.hello/1.0.0/icon',
    kinds: ['grammars'],
    categories: ['code'],
    downloads: 12,
    installs: 7,
    updatedAt: '2026-10-01T08:00:00Z',
    ...over,
  }
}
