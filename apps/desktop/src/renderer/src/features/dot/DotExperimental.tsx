import { tr } from '@/i18n/core'

/** 「实验」小标签：Dot 走 ChatGPT 网页协议，随时可能失效（docs/ui/dot-optimize.md §6 问题 4） */
export function DotExperimental() {
  return (
    <span
      title={tr('dot.experimentalHint')}
      className="shrink-0 rounded border border-warn/35 bg-warn/10 px-1 text-meta leading-4 text-warn"
    >
      {tr('dot.experimental')}
    </span>
  )
}
