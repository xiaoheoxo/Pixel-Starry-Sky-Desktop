// 执行机（docs/multica-learn.md §9、§11.7）：SSH 机器上常驻的 `helper.cjs runner run`，桌面关着也接团队活。
// 桌面经 SSH 把配置推给它（config.json），它把状态写在 status.json 里给桌面读。两边都不信对方的输入，读的时候整理一遍。
import type { AgentConfig, TeammateRules } from './channels'

/** 执行机上的成员：和桌面的成员同一个 id（云端登记的 localId），项目按路径给（执行机有自己的项目表） */
export type RunnerMember = Omit<AgentConfig, 'machineId' | 'projectId' | 'copyId' | 'sharedSessionId'> & {
  projectPath: string
}

export interface RunnerConfig {
  format: 1
  /** 装它的那台桌面的设备 id：只认它推的配置（同一账号别的桌面不来回覆盖） */
  installer: string
  locale: 'zh-CN' | 'en-US'
  selfName: string
  /** 队友派来的活的限制（第 4 批）；projects 是项目路径 */
  teammate: TeammateRules
  members: RunnerMember[]
}

/** status.json：执行机每 15 秒写一次 */
export interface RunnerStatus {
  /** helper.cjs 的版本（文件哈希前 12 位） */
  version: string
  /** signed-in 正常；signed-out 没登录；revoked 被停用或重新配对过（4001）；seats 席位满（4010） */
  auth: 'signed-in' | 'signed-out' | 'revoked' | 'seats'
  running: number
  queued: number
  /** 配置是哪台桌面推的、推的时间 */
  configFrom: string | null
  configAt: number | null
  updatedAt: number
}

/** 机器页「执行机」一行（channels:runners）：一台 SSH / WSL 机器一条 */
export interface RunnerView {
  machineId: string
  /** 这台机器上装的执行机；没装是 null */
  runnerId: string | null
  /** 云端看到的：连着没有、版本 */
  online: boolean
  version: string | null
  /** 连上机器时读到的（没连上是 null） */
  local: {
    installed: boolean
    auth: RunnerStatus['auth'] | null
    running: number
    queued: number
    /** linger 没开：重启机器后要登录一次执行机才会起来 */
    linger: boolean
    /** 是不是这台桌面装的（只有装它的桌面推配置） */
    mine: boolean
  } | null
  /** 团队活绑在它上面的我的成员 id */
  members: string[]
  /** 能不能装：Linux 机器且连着 */
  installable: boolean
  error: string | null
}
