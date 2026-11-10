import type { AccountQuota, EngineQuotaProvider, QuotaRefreshOptions, ResetCreditOutcome } from '@pixelsky/protocol'

/** 预加载暴露的 window.pixelsky.quota（docs/ui/account-quota.md §5） */
export interface QuotaBridge {
  /** 读主进程的缓存，不发请求；当前账号还没读过为 null */
  get(provider: EngineQuotaProvider): Promise<AccountQuota | null>
  /**
   * 按需读取：快照比 maxAgeMs 新就直接返回；force 是手动刷新。同一账号同一时间只有一个在途请求。
   * 不会抛错：失败时返回 status 'error' 的快照（保留上一次的数据）
   */
  refresh(provider: EngineQuotaProvider, opts?: QuotaRefreshOptions): Promise<AccountQuota>
  /** 用一张 Codex 重置卡（真实扣卡，不能撤回）；用完主进程会重读额度并广播 */
  useResetCredit(): Promise<ResetCreditOutcome>
  /** 当前账号的快照变了（读取完成、对话里收到事件、换了账号） */
  onChange(callback: (quota: AccountQuota) => void): () => void
}
