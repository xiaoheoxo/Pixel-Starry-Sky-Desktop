import type { ExtPackInfo } from '@pixelsky/protocol'
import { fakePack } from '@/features/extpacks/testing'

/** 已安装页测试用：在 fakePack 上补清单的名称、版本、发布者（列表要显示名字） */
export function namedPack(
  over: Parameters<typeof fakePack>[0] = {},
  name = 'Example',
  publisher = 'acme',
): ExtPackInfo {
  const p = fakePack(over)
  return {
    ...p,
    manifest: {
      ...p.manifest,
      name,
      version: p.store?.version ?? '1.0.0',
      publisher,
      description: '',
    } as ExtPackInfo['manifest'],
  }
}
