import { describe, expect, it, vi } from 'vitest'
import { dotMessageWithReferences, dotTransferFiles } from './composerFiles'

function transfer(files: File[]): DataTransfer {
  return { files, items: [] } as unknown as DataTransfer
}

describe('Dot composer file input', () => {
  it('sends pasted local documents and photos as references, retaining pathless screenshots as attachments', () => {
    const doc = new File(['document'], 'test data.txt')
    const photo = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' })
    const screenshot = new File(['screenshot'], 'image.png', { type: 'image/png' })
    const resolve = (file: File) => (file === screenshot ? '' : `D:\\Project\\${file.name}`)
    const { files, missingPath } = dotTransferFiles(transfer([doc, photo, screenshot]), 'paste', resolve)
    expect(missingPath).toBe(false)
    expect(files).toEqual([
      { name: doc.name, path: 'D:\\Project\\test data.txt' },
      { name: photo.name, path: 'D:\\Project\\photo.jpg' },
      { name: screenshot.name, file: screenshot },
    ])
    expect(dotMessageWithReferences('Review these', files)).toBe(
      'Review these\n\n@"D:\\Project\\test data.txt"\n@D:\\Project\\photo.jpg',
    )
    expect(dotMessageWithReferences('', [files[1]])).toBe('@D:\\Project\\photo.jpg')
  })

  it('keeps a dropped directory as a reference and never attaches pathless drops', () => {
    const folder = new File([], 'notes')
    const image = new File(['content'], 'image.png')
    const data = {
      files: [],
      items: [
        { kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) },
        { kind: 'file', getAsFile: () => image },
      ],
    } as unknown as DataTransfer
    expect(dotTransferFiles(data, 'drop', file => (file === folder ? '/home/me/notes' : ''))).toEqual({
      files: [{ name: 'notes', path: '/home/me/notes' }],
      missingPath: true,
    })
  })

  it('leaves ordinary text paste to the textarea', () => {
    const pathForFile = vi.fn()
    expect(dotTransferFiles(transfer([]), 'paste', pathForFile)).toEqual({ files: [], missingPath: false })
    expect(pathForFile).not.toHaveBeenCalled()
    expect(dotMessageWithReferences('  message  ', [])).toBe('  message  ')
  })
})
