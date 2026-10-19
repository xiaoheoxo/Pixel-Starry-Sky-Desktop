import type { ExtStoreBridge } from '../../../../preload/extstore'

/** 扩展商店的预加载桥；没有 window（node 测试）或桥不存在时是 undefined */
export const extstoreBridge = (): ExtStoreBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.pixelsky?.extstore
