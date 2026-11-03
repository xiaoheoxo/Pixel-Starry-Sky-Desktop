// 回复里的 ```svg 代码块（示意图 docs/ui/svg-render-mockup.html）：默认画成图，和 Mermaid 图块同一套工具（图 / 源码、放大、复制）；
// 回复还在输出时先显示源码；写错（解析不了 / 画不出来）时提示原因并显示源码。透明底的图垫棋盘格，可换白 / 黑底
import { memo, useContext, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { CodeBlock } from '@/ui/code/CodeBlock'
import { cn } from '@/ui/cn'
import { ImageViewer } from '@/ui/ImageViewer'
import { DiagramTools, StreamingContext } from './MermaidBlock'
import { svgDataUrl } from './mermaid'
import { prepareSvg, SVG_BACKDROP, svgParseError, type SvgBackdrop } from './svg'

const BACKDROPS: SvgBackdrop[] = ['check', 'white', 'black']

function BackdropPicker({ value, onChange }: { value: SvgBackdrop; onChange(v: SvgBackdrop): void }) {
  return (
    <span role="group" aria-label={tr('svg.backdrop')} className="mr-1 inline-flex items-center gap-1">
      {BACKDROPS.map(b => (
        <button
          key={b}
          type="button"
          title={tr(`svg.backdrop.${b}`)}
          aria-label={tr(`svg.backdrop.${b}`)}
          aria-pressed={value === b}
          onClick={() => onChange(b)}
          className={cn(
            'press no-drag h-3.5 w-3.5 rounded border border-line',
            SVG_BACKDROP[b],
            b === 'check' && 'bg-[length:6px_6px]!',
            value === b && 'outline outline-2 outline-offset-1 outline-accent',
          )}
        />
      ))}
    </span>
  )
}

export const SvgBlock = memo(function SvgBlock({ code }: { code: string }) {
  useI18n()
  const streaming = useContext(StreamingContext)
  const [showSource, setShowSource] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const [backdrop, setBackdrop] = useState<SvgBackdrop>('check')
  const [broken, setBroken] = useState<string | null>(null)
  const prepared = useMemo(() => {
    if (streaming) return null
    const svg = prepareSvg(code)
    if (!svg) return { error: { line: null, reason: tr('svg.notSvg') } }
    const error = svgParseError(svg)
    return error ? { error } : { url: svgDataUrl(svg) }
  }, [code, streaming])

  if (streaming || !prepared) return <CodeBlock code={code} lang="svg" />

  const url = 'url' in prepared && broken !== prepared.url ? prepared.url : null
  const error = 'error' in prepared ? prepared.error : url ? null : { line: null, reason: tr('svg.cannotDraw') }
  const diagram = !!url && !showSource
  const tools = (
    <DiagramTools
      enabled={!!url}
      diagram={diagram}
      onSource={setShowSource}
      onZoom={() => setZoomed(true)}
      before={url && diagram ? <BackdropPicker value={backdrop} onChange={setBackdrop} /> : undefined}
    />
  )
  const notice = error && (
    <div className="flex items-start gap-1.5 border-b border-line-subtle bg-[color-mix(in_srgb,var(--danger)_8%,var(--bg-surface))] px-3 py-1.5 text-meta text-danger">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">
        {tr('svg.failed', {
          reason: (error.line ? tr('mermaid.failedLine', { line: error.line }) : '') + error.reason,
        })}
      </span>
    </div>
  )
  const view = diagram ? (
    <div className={cn('flex justify-center px-3 py-3.5', SVG_BACKDROP[backdrop])}>
      <img
        src={url}
        alt={tr('svg.imageLabel')}
        draggable={false}
        onError={() => setBroken(url)}
        onDoubleClick={() => setZoomed(true)}
        className="h-auto max-h-[480px] max-w-full"
      />
    </div>
  ) : undefined

  return (
    <>
      <CodeBlock code={code} lang="svg" tools={tools} notice={notice} view={view} />
      {zoomed && url && <ImageViewer src={url} name="svg" onClose={() => setZoomed(false)} />}
    </>
  )
})
