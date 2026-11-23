import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TurnReview } from '../../shared/types/ai'
import { ReviewStore, SESSION_LIMIT } from './store'

const review = (ids: string[] = ['a', 'b']): TurnReview => ({
  at: 1,
  model: 'm',
  files: 1,
  items: ids.map(id => ({ id, status: 'open', severity: 'high', file: 'x.ts', line: 1, title: id, detail: '' })),
  fix: null,
  rechecked: false,
})

const dirs: string[] = []
const stores: ReviewStore[] = []
afterEach(async () => {
  // 写盘是排队的：没写完就删目录会删不空
  for (const s of stores.splice(0)) await s.flush()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
async function file(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'reviews-'))
  dirs.push(d)
  return join(d, 'ai-reviews.json')
}

function open(path: string): ReviewStore {
  const store = new ReviewStore(path)
  stores.push(store)
  return store
}

describe('ReviewStore', () => {
  it('saves, reloads, deletes a turn and tells listeners', async () => {
    const path = await file()
    const store = open(path)
    const seen: unknown[] = []
    store.onChange(c => seen.push(c))
    store.set('s1', 't1', review())
    store.set('s1', 't2', review(['c']))
    store.set('s1', 't1', null)
    store.set('s1', 'missing', null)
    await store.flush()
    expect(seen).toHaveLength(3)
    const again = open(path)
    await again.load()
    expect(Object.keys(again.session('s1'))).toEqual(['t2'])
    store.set('s1', 't2', null)
    await store.flush()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({})
  })

  it('imports old localStorage results once, without overwriting, dropping junk', async () => {
    const store = open(await file())
    store.set('s1', 't1', review(['new']))
    const all = store.importLegacy({
      s1: { t1: review(['old']) },
      s2: { t1: review(), bad: { at: 'x' } },
      s3: 'junk',
    })
    expect(all.s1.t1.items[0].id).toBe('new')
    expect(Object.keys(all.s2)).toEqual(['t1'])
    expect(all.s3).toBeUndefined()
    expect(store.importLegacy(null)).toBe(all)
  })

  it('keeps only the most recent sessions', async () => {
    const store = open(await file())
    for (let i = 0; i <= SESSION_LIMIT; i++) store.set('s' + i, 't', review())
    store.set('s1', 't', review())
    const ids = Object.keys(store.all())
    expect(ids).toHaveLength(SESSION_LIMIT)
    expect(ids).not.toContain('s0')
    expect(ids.at(-1)).toBe('s1')
  })

  it('phone: ignore one item; send items to fix records the fix text unless already rechecked', async () => {
    const store = open(await file())
    store.set('s1', 't1', review())
    expect(store.setStatus('s1', 't1', 'a', 'ignored')).toBe(true)
    expect(store.setStatus('s1', 't1', 'zz', 'ignored')).toBe(false)
    store.markSent('s1', 't1', ['b'], 'fix it')
    const r = store.session('s1').t1
    expect(r.items.map(i => i.status)).toEqual(['ignored', 'sent'])
    expect(r.fix).toEqual({ text: 'fix it', ids: ['b'] })
    store.set('s1', 't1', { ...r, rechecked: true, fix: null })
    store.markSent('s1', 't1', ['a'], 'again')
    expect(store.session('s1').t1.fix).toBeNull()
  })

  it('keeps a .bad copy of a corrupt file before starting empty', async () => {
    const path = await file()
    await writeFile(path, '{not json', 'utf8')
    const store = open(path)
    await store.load()
    expect(store.all()).toEqual({})
    expect(await readFile(`${path}.bad`, 'utf8')).toBe('{not json')
  })
})
