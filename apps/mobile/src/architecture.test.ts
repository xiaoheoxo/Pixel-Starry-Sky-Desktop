// 依赖规则（docs/mobile-remote.md §8.5.1）：按目录检查 import
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('.', import.meta.url))
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [path] : []
  })
const files = walk(root).map(path => ({
  file: relative(root, path).replace(/\\/g, '/'),
  imports: [...readFileSync(path, 'utf8').matchAll(/from '([^']+)'/g)].map(m => m[1]),
}))
const area = (file: string) => file.split('/')[0]
const feature = (file: string) => (file.startsWith('features/') ? file.split('/')[1] : null)

describe('mobile dependency rules', () => {
  it('has the expected top-level directories only', () => {
    const top = new Set(files.map(f => (f.file.includes('/') ? area(f.file) : f.file)))
    for (const t of top)
      expect([
        'app',
        'connection',
        'data',
        'features',
        'i18n',
        'styles',
        'ui',
        'platform',
        'main.tsx',
        'env.d.ts',
        'architecture.test.ts',
      ]).toContain(t)
  })

  it('lets only connection/ use packages/link', () => {
    for (const f of files) if (f.imports.includes('@pixelsky/link')) expect(area(f.file), f.file).toBe('connection')
  })

  it('keeps features apart from each other and from app/', () => {
    for (const f of files) {
      const own = feature(f.file)
      if (!own) continue
      for (const imp of f.imports) {
        expect(imp.startsWith('@/app'), `${f.file} → ${imp}`).toBe(false)
        const other = /^@\/features\/([^/]+)/.exec(imp)?.[1]
        if (other) expect(other, `${f.file} → ${imp}`).toBe(own)
      }
    }
  })

  it('keeps connection/, data/ and ui/ free of the screens', () => {
    for (const f of files) {
      const a = area(f.file)
      if (!['connection', 'data', 'ui'].includes(a)) continue
      for (const imp of f.imports) {
        expect(/^@\/(features|app)/.test(imp), `${f.file} → ${imp}`).toBe(false)
        if (a === 'ui') expect(/^@\/(data|connection)/.test(imp), `${f.file} → ${imp}`).toBe(false)
        if (a === 'connection') expect(imp.startsWith('@/data'), `${f.file} → ${imp}`).toBe(false)
      }
    }
  })

  it('lets only platform/ use Capacitor', () => {
    for (const f of files)
      for (const imp of f.imports)
        if (/^@capacitor\/|^@capawesome/.test(imp)) expect(area(f.file), `${f.file} → ${imp}`).toBe('platform')
  })

  it('never imports the desktop app', () => {
    for (const f of files)
      for (const imp of f.imports) expect(imp, f.file).not.toMatch(/apps\/desktop|@pixelsky\/desktop/)
  })
})
