import type { EngineConfig, EngineId, EngineInfo } from '@pixelsky/protocol'

/**
 * 目录要不要重新请求只看这几项：状态、版本、路径、启动方式、授权方式 / 账号 / 当前线路，本机配置里的命令 / 参数 / 环境变量，
 * 以及「重新检测」的次数（检测完这些常常不变，但引擎侧已经清了缓存，界面要重新取）。
 * 引擎信息对象每次广播都是新的，直接放进依赖会让每次广播都起一次握手进程
 */
export function catalogSignature(
  info: EngineInfo | undefined,
  config: EngineConfig[EngineId] | undefined,
  detectGen = 0,
): string {
  return JSON.stringify([
    info?.status ?? null,
    info?.version ?? null,
    info?.path ?? null,
    info?.launch ?? null,
    info?.launchError ?? null,
    config?.path ?? null,
    config?.args ?? null,
    config?.env ?? null,
    info?.auth ?? null,
    info?.account ?? null,
    detectGen,
  ])
}
