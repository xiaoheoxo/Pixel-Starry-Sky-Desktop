// 设置 › 存储 › 数据位置（docs/ui/data-location.md §5）

export interface DataLocationInfo {
  /** 现在的数据位置 */
  path: string
  /** 是不是 AppData 里的默认位置 */
  inAppData: boolean
  /** 搬完后旧位置还留着数据（点「删除旧数据」才清掉） */
  previous: string | null
  /** 上次搬家失败的原因 */
  error: string | null
  /** 已经排好、等重启后搬过去 */
  pending: string | null
}

/** 选的文件夹不能用的原因（主进程 checkTarget） */
export type DataLocationProblem =
  | 'notAbsolute'
  | 'same'
  | 'insideCurrent'
  | 'containsCurrent'
  | 'insideInstall'
  | 'notWritable'
  | 'hasData'
  | 'noSpace'

export type DataLocationChoice =
  | { kind: 'cancelled' }
  | { kind: 'problem'; problem: DataLocationProblem; path: string }
  | { kind: 'ready'; path: string; bytes: number }
  /** 那里已经有像素星空的数据：可以直接接回去（不复制） */
  | { kind: 'existing'; path: string }

export interface DataLocationBridge {
  info(): Promise<DataLocationInfo>
  /** 弹系统对话框选文件夹并检查，不搬 */
  choose(): Promise<DataLocationChoice>
  /** 排好搬家并重启（重启后先搬、核对，再打开） */
  move(path: string): Promise<void>
  /** 接回已经有数据的文件夹并重启（choose 返回 existing 之后） */
  use(path: string): Promise<void>
  /** 取消排好的搬家 */
  cancelMove(): Promise<void>
  /** 把旧位置的数据移到回收站 */
  removeOld(): Promise<void>
  /** 不删旧数据，只是不再提示 */
  dismiss(): Promise<void>
}
