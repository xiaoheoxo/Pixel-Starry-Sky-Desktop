export type DotComposerFile = { name: string; path: string } | { name: string; file: File }

export function dotPathReference(path: string): DotComposerFile {
  const name = path.startsWith('/') ? path.split('/').at(-1) : path.split(/[\\/]/).filter(Boolean).at(-1)
  return { name: name || path, path }
}

export function dotTransferFiles(
  transfer: DataTransfer,
  source: 'paste' | 'drop',
  pathForFile: (file: File) => string,
): { files: DotComposerFile[]; missingPath: boolean } {
  const items = Array.from(transfer.items).filter(item => item.kind === 'file')
  const entries = items.length
    ? items.map(item => ({ file: item.getAsFile(), directory: item.webkitGetAsEntry?.()?.isDirectory }))
    : Array.from(transfer.files, file => ({ file, directory: false }))
  const files: DotComposerFile[] = []
  let missingPath = false
  for (const { file, directory } of entries) {
    const path = file && pathForFile(file)
    if (path) files.push(dotPathReference(path))
    else if (source === 'paste' && file && !directory) files.push({ file, name: file.name })
    else missingPath = true
  }
  return { files, missingPath }
}

export function dotMessageWithReferences(text: string, files: readonly DotComposerFile[]): string {
  const references = files.flatMap(file => {
    if (!('path' in file)) return []
    const { path } = file
    return /[\s"]/.test(path) ? `@"${path.replaceAll('"', '\\"')}"` : `@${path}`
  })
  return references.length ? [text, references.join('\n')].filter(Boolean).join('\n\n') : text
}
