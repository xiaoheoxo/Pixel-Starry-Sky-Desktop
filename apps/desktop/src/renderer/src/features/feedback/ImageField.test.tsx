import type { ClipboardEvent, DragEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFeedbackImages, type FeedbackImages } from './ImageField'
import { readImage } from '@/features/session/attachments/images'
import { FEEDBACK_LIMITS } from '../../../../shared/types/feedback'

vi.mock('@/features/session/attachments/images', () => ({ readImage: vi.fn() }))
vi.mock('@/features/session/attachments/ImageAttachments', () => ({ ImageAttachments: () => null }))
vi.mock('@/ui', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }))

// 在 React 内创建真实 hook，直接验证表单事件是否把文件交给图片读取器。
function images(locked = false): FeedbackImages {
  let state!: FeedbackImages
  function Probe() {
    state = useFeedbackImages(undefined, locked)
    return null
  }
  renderToStaticMarkup(<Probe />)
  return state
}

function drop(files: File[], types = ['Files']): DragEvent {
  return {
    dataTransfer: { files, types, dropEffect: 'none' },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as DragEvent
}

beforeEach(() => {
  vi.mocked(readImage).mockReset()
  vi.mocked(readImage).mockResolvedValue({
    id: 'image',
    name: 'shot.png',
    mediaType: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
    dataBase64: 'AA==',
  })
})

describe('反馈图片拖放', () => {
  it('允许文件拖入并显示复制光标，即使拖动期间文件列表尚不可读', () => {
    const state = images()
    const event = drop([])
    state.onDragEnter(event)
    state.onDragOver(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.dataTransfer.dropEffect).toBe('copy')
  })

  it('接收无 MIME 类型的图片，过滤其他文件，并阻止默认打开文件和继续冒泡', () => {
    const state = images()
    const png = new File(['png'], 'shot.PNG')
    const jpg = new File(['jpg'], 'shot.jpg', { type: 'image/jpeg' })
    const event = drop([png, new File(['log'], 'app.log'), jpg])
    state.onDrop(event)
    expect(readImage).toHaveBeenCalledTimes(2)
    expect(vi.mocked(readImage).mock.calls.map(([file]) => file)).toEqual([png, jpg])
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('提交中不收新图，但仍拦住浏览器默认打开文件', () => {
    const state = images(true)
    const event = drop([new File(['png'], 'shot.png', { type: 'image/png' })])
    state.onDrop(event)
    expect(readImage).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('SVG 等不支持的图片交给读取器报错，不悄悄忽略', () => {
    const state = images()
    const svg = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })
    state.onDrop(drop([svg]))
    expect(vi.mocked(readImage).mock.calls.map(([file]) => file)).toEqual([svg])
  })

  it('保留普通文字拖放行为', () => {
    const state = images()
    const event = drop([], ['text/plain'])
    state.onDragEnter(event)
    state.onDragOver(event)
    state.onDrop(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(readImage).not.toHaveBeenCalled()
  })

  it('读取尚未完成时，连续拖入也不能超过上限', () => {
    vi.mocked(readImage).mockImplementation(() => new Promise(() => {}))
    const state = images()
    const pngs = (from: number, n: number) => Array.from({ length: n }, (_, i) => new File(['png'], `${from + i}.png`))
    // 先拖入差一张到上限，还在读取时再拖两张：后一批整批不收
    state.onDrop(drop(pngs(1, FEEDBACK_LIMITS.images - 1)))
    state.onDrop(drop(pngs(FEEDBACK_LIMITS.images, 2)))
    expect(readImage).toHaveBeenCalledTimes(FEEDBACK_LIMITS.images - 1)
  })

  it('粘贴也接收缺少 MIME 类型的图片', () => {
    const state = images()
    const file = new File(['png'], 'shot.png')
    const event = {
      clipboardData: { files: [file] },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent
    state.onPaste(event)
    expect(readImage).toHaveBeenCalledOnce()
    expect(vi.mocked(readImage).mock.calls[0][0]).toBe(file)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})
