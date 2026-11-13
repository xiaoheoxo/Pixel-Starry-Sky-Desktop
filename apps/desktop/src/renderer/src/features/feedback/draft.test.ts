import { describe, expect, it } from 'vitest'
import type { ImageAttachment } from '@pixelsky/protocol'
import {
  EMPTY_DRAFT,
  clearDraft,
  draftKey,
  loadDraft,
  loadDraftImages,
  sanitizeDraft,
  saveDraft,
  saveDraftImages,
} from './draft'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

describe('feedback draft', () => {
  it('round-trips per account', () => {
    const s = fakeStorage()
    const draft = {
      ...EMPTY_DRAFT,
      type: 'feature' as const,
      title: 't',
      body: 'b',
      logs: true,
      window: '24h' as const,
    }
    saveDraft('a@x.com', draft, s)
    expect(s.map.has('pixelsky.feedback.draft.v1:a@x.com')).toBe(true)
    expect(loadDraft('a@x.com', s)).toEqual(draft)
    expect(loadDraft('b@x.com', s)).toEqual(EMPTY_DRAFT)
  })
  it('does not keep an empty draft, and clears on demand', () => {
    const s = fakeStorage()
    saveDraft('a@x.com', { ...EMPTY_DRAFT, title: 't' }, s)
    saveDraft('a@x.com', { ...EMPTY_DRAFT, diagnostics: false }, s)
    expect(s.map.size).toBe(0)
    saveDraft('a@x.com', { ...EMPTY_DRAFT, body: 'x' }, s)
    clearDraft('a@x.com', s)
    expect(s.map.has(draftKey('a@x.com'))).toBe(false)
  })
  it('survives corrupt data', () => {
    const s = fakeStorage()
    s.map.set(draftKey('a@x.com'), '{nope')
    expect(loadDraft('a@x.com', s)).toEqual(EMPTY_DRAFT)
    expect(sanitizeDraft({ type: 'zzz', title: 5, logs: 'x', window: 'y' })).toEqual(EMPTY_DRAFT)
  })

  it('图片按账号留在内存里，提交成功（clearDraft）后清掉', () => {
    const shot = { id: 'i1', name: 'shot.png' } as ImageAttachment
    saveDraftImages('a@x.com', [shot])
    expect(loadDraftImages('a@x.com')).toEqual([shot])
    expect(loadDraftImages('b@x.com')).toEqual([])
    clearDraft('a@x.com', fakeStorage())
    expect(loadDraftImages('a@x.com')).toEqual([])
  })
})
