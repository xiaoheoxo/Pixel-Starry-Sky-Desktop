import { useEffect, useState } from 'react'
import type { ServiceDefinition } from '../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'

export interface ServicesState {
  services: ServiceDefinition[]
  loading: boolean
  error: string | null
}
const NONE: ServiceDefinition[] = []

/**
 * 项目的服务列表（底栏端口页、状态栏用）。真实模式读 projectTools.services，服务状态变了（onChange）重新读，
 * 做法照 EnvironmentPanel；演示模式读 demo().projectTools.environment.services
 */
export function useServices(ref: WorkspaceRef | null): ServicesState {
  const key = ref ? JSON.stringify(ref) : ''
  // forKey：这份列表是哪个项目的；换项目后新列表回来前不拿上一个项目的服务给界面（点停止会停错项目）
  const [state, setState] = useState<ServicesState & { forKey: string }>({
    services: NONE,
    loading: !isDemo && !!ref,
    error: null,
    forKey: key,
  })
  useEffect(() => {
    if (isDemo) {
      setState({
        services: ref ? demo().projectTools.environment.services : NONE,
        loading: false,
        error: null,
        forKey: key,
      })
      return
    }
    if (!ref) {
      setState({ services: NONE, loading: false, error: null, forKey: key })
      return
    }
    let gone = false
    const read = (): void => {
      void window
        .pixelsky!.projectTools.services(ref)
        .then(services => {
          if (!gone) setState({ services, loading: false, error: null, forKey: key })
        })
        .catch((e: Error) => {
          if (!gone) setState(s => ({ ...s, loading: false, error: e.message }))
        })
    }
    setState(s =>
      s.forKey === key ? { ...s, loading: true } : { services: NONE, loading: true, error: null, forKey: key },
    )
    read()
    const off = window.pixelsky!.projectTools.onChange(read)
    return () => {
      gone = true
      off()
    }
    // ref 只在 key 变化时才会变（key 由 ref 序列化而来）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // 换项目那一帧 effect 还没跑：state 仍是上一个项目的，按「正在读」交出去
  if (state.forKey !== key) return { services: NONE, loading: !isDemo && !!ref, error: null }
  return state
}
