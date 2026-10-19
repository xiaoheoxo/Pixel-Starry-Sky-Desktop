import type { ExtPackInfo } from '@pixelsky/protocol'

// 扩展商店主进程模块之间传递的接口（只有类型）。install.ts 等不能值导入 service.ts（会成环），
// 要改 service 状态时走这里的回调，由 market/ipc.ts 用 service 的方法拼出来。

/** 商店扩展的安装回执（store/<id>/install.json） */
export interface StoreInstallRecord {
  id: string
  version: string
  sha256: string
  size: number
  signature: string
  keyId: string
  site: string
  /** 解压目录名（sha256 前 16 位） */
  dir: string
  installedAt: number
}

/** installer 用到的 service 能力 */
export interface StoreHost {
  /** 排进 service 的串行队列，里面改状态不会和启停、卸载交叉 */
  mutate<T>(fn: () => Promise<T>): Promise<T>
  /** 换上（新装、更新、换回）一份商店扩展并 commit：回执和解压目录（root）已经写好；必须在 mutate 里调，回的是换上后的扩展 */
  replaceStorePack(record: StoreInstallRecord, root: string): Promise<ExtPackInfo>
  /** 卸载的内存和设置那一半：去掉这一项、删设置、让贡献消失（文件由调用方再删）；必须在 mutate 里调 */
  removeStorePack(id: string): Promise<void>
  /** 本机装的这份商店扩展的回执；没装是 null */
  storeInfo(id: string): StoreInstallRecord | null
  appVersion: string
  storeDir: string
  /** 就是 service.ready() */
  ready(): Promise<void>
  /** 就是 () => service.state().packs */
  packs(): ExtPackInfo[]
}

/** service 要调的 installer 能力（service.attachStoreTasks 收它） */
export interface StoreTasks {
  /** 取消这个 id 正在进行的任务并等它退出 */
  cancel(id: string): Promise<void>
}
