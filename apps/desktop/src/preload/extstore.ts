import type {
  ExtPackInfo,
  ExtStoreCatalogPage,
  ExtStoreCatalogQuery,
  ExtStoreCheckReport,
  ExtStoreDetail,
  ExtStoreInstallOptions,
  ExtStorePickUploadInput,
  ExtStorePickUploadResult,
  ExtStorePublisher,
  ExtStorePublisherState,
  ExtStoreRefreshResult,
  ExtStoreReportInput,
  ExtStoreState,
  ExtStoreUpdates,
  ExtStoreUploadResult,
} from '@pixelsky/protocol'

/** 扩展商店（发现、安装、更新、我的发布）；卸载和启停沿用 ExtPacksBridge */
export interface ExtStoreBridge {
  catalog(query: ExtStoreCatalogQuery): Promise<ExtStoreCatalogPage>
  detail(id: string): Promise<ExtStoreDetail | null>
  install(id: string, version: string, options?: ExtStoreInstallOptions): Promise<ExtPackInfo>
  cancel(id: string): Promise<void>
  /** auto:true 是打开扩展页时的自动检查（主进程按 10 分钟节流）；不带参数是点「检查更新」，立刻查 */
  checkUpdates(options?: { auto?: boolean }): Promise<ExtStoreUpdates>
  state(): Promise<ExtStoreState>
  /** 打开扩展页时让主进程读一次停用名单（主进程自己按 5 分钟节流） */
  refreshBlocklist(): Promise<ExtStoreRefreshResult>
  report(id: string, input: ExtStoreReportInput): Promise<void>
  publisher(): Promise<ExtStorePublisherState>
  register(name: string): Promise<ExtStorePublisher>
  /** null 弹选择框（zip 或文件夹）；bytes 是拖进来的 zip；不接受路径 */
  pickUpload(input: ExtStorePickUploadInput): Promise<ExtStorePickUploadResult | null>
  upload(token: string): Promise<ExtStoreUploadResult>
  withdraw(id: string, version: string): Promise<void>
  delist(id: string): Promise<void>
  relist(id: string): Promise<void>
  /** 读本机存的上传检查结果；没有回 null */
  publishCheck(id: string, version: string): Promise<ExtStoreCheckReport | null>
  onChange(callback: () => void): () => void
}
