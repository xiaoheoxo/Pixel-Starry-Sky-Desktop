import { useEffect } from 'react'
import type { AddProjectsResult } from '@pixelsky/protocol'
import { tr } from '@/i18n/core'
import { useToast } from '@/ui'
import { PROJECTS_ADDED_EVENT, getEngineState } from '@/features/engine/store'
import { hintEngine, hintText, openResumeFor, prefetchResumeCounts } from './hint'

/**
 * 项目从侧栏、拖文件夹、导入对话框等入口加进来之后，查一下终端里有没有原来的会话，有就弹一句提示。
 * 设置 › 项目自己在结果行里显示（事件带 quiet），这里不重复提示。查不到、没有、远程项目都不出声
 */
export function ResumeHintHost() {
  const toast = useToast()
  useEffect(() => {
    const onAdded = (event: Event): void => {
      const detail = (event as CustomEvent<AddProjectsResult & { quiet?: boolean }>).detail
      if (!detail || detail.quiet || !detail.added.length) return
      void prefetchResumeCounts(detail.added.map(p => p.id)).then(
        found => {
          if (found.size === 1) {
            const [[id, counts]] = [...found]
            const text = hintText(counts)
            if (text)
              toast(text, {
                action: {
                  label: tr('resume.hint.action'),
                  run: () => openResumeFor(id, hintEngine(counts, getEngineState().defaults?.engine)),
                },
              })
          } else if (found.size > 1) toast(tr('resume.hint.toastMany', { n: found.size }), { duration: 5000 })
        },
        () => undefined,
      )
    }
    window.addEventListener(PROJECTS_ADDED_EVENT, onAdded)
    return () => window.removeEventListener(PROJECTS_ADDED_EVENT, onAdded)
  }, [toast])
  return null
}
