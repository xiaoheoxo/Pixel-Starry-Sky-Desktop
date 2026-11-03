// 回复里的 Mermaid 图表（docs/ui/mermaid.md）
export const mermaidMessages = {
  'mermaid.view': { zh: '图', en: 'Diagram' },
  'mermaid.source': { zh: '源码', en: 'Source' },
  'mermaid.switch': { zh: '源码 / 图', en: 'Source / diagram' },
  'mermaid.zoom': { zh: '放大查看', en: 'Enlarge' },
  'mermaid.loading': { zh: '正在加载图表…', en: 'Loading diagram…' },
  'mermaid.diagramLabel': { zh: 'Mermaid 图表', en: 'Mermaid diagram' },
  'mermaid.failed': {
    zh: '图表渲染失败，已显示源码：{reason}',
    en: "Couldn't render the diagram; showing the source: {reason}",
  },
  'mermaid.failedLine': { zh: '第 {line} 行附近 ', en: 'near line {line}: ' },
  'mermaid.retry': { zh: '重试', en: 'Retry' },
  'mermaid.tooLarge': {
    zh: '图表较大，没有自动画图（画图时界面可能卡住几秒）',
    en: 'Large diagram; not drawn automatically (drawing may freeze the app for a few seconds)',
  },
  'mermaid.renderAnyway': { zh: '仍然画图', en: 'Draw anyway' },
  // 回复里的 ```svg 代码块（ui/markdown/SvgBlock.tsx），工具按钮和 Mermaid 共用
  'svg.imageLabel': { zh: 'SVG 图', en: 'SVG image' },
  'svg.failed': { zh: 'SVG 画不出来，已显示源码：{reason}', en: "Couldn't draw the SVG; showing the source: {reason}" },
  'svg.notSvg': { zh: '最外层不是 <svg>', en: 'the outermost element is not <svg>' },
  'svg.cannotDraw': { zh: '浏览器画不出这张图', en: "the browser couldn't draw it" },
  'svg.backdrop': { zh: '底色', en: 'Background' },
  'svg.backdrop.check': { zh: '棋盘格（看得出透明部分）', en: 'Checkerboard (shows transparency)' },
  'svg.backdrop.white': { zh: '白底', en: 'White' },
  'svg.backdrop.black': { zh: '黑底', en: 'Black' },
} as const
