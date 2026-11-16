import { randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import type { ImageAttachment, LogEntry } from '@pixelsky/protocol'
import { FEEDBACK_LIMITS } from '../../shared/types/feedback'
import {
  buildAttachFields,
  buildDiagnostics,
  buildLogs,
  checkErrorSnippet,
  packLogs,
  prepareImages,
  sanitizeLogText,
  phoneInput,
} from './attachments'

const win = { home: 'C:\\Users\\Alice', platform: 'win32' }
const posix = { home: '/home/bob', platform: 'linux' }

describe('sanitizeLogText', () => {
  it('把主目录换成 ~（两种斜杠、JSON 转义的反斜杠，Windows 不分大小写）', () => {
    const text = [
      'open C:\\Users\\Alice\\proj\\a.ts',
      'then c:/users/alice/proj/b.ts',
      '{"path":"C:\\\\Users\\\\Alice\\\\y"}',
    ].join('\n')
    const out = sanitizeLogText(text, win)
    expect(out.toLowerCase()).not.toContain('alice')
    expect(out).toContain('~\\proj\\a.ts')
    expect(out).toContain('~/proj/b.ts')
  })

  it('不替换名字更长的目录；非 Windows 区分大小写', () => {
    expect(sanitizeLogText('/home/bobby/x /home/bob/y /home/Bob/z', posix)).toBe('/home/bobby/x ~/y /home/Bob/z')
    expect(sanitizeLogText('C:\\Users\\AliceX\\a', win)).toBe('C:\\Users\\AliceX\\a')
  })

  it('脱敏幂等', () => {
    const raw =
      'Authorization: Bearer abc.def-123 url=https://x/y?access_token=zzz&a=1 key sk-abcdef123456 C:\\Users\\Alice\\f'
    const once = sanitizeLogText(raw, win)
    expect(once).not.toMatch(/abc\.def|zzz|abcdef123456|Alice/)
    expect(sanitizeLogText(once, win)).toBe(once)
  })
})

const entry = (i: number, size = 10): LogEntry => ({
  ts: Date.UTC(2026, 9, 12, 10, 0, 0) + i,
  level: 'info',
  scope: 'app',
  message: `m${i}-${'x'.repeat(size)}`,
})

describe('buildLogs', () => {
  it('取最多 1000 条，开头注明，行内替换主目录', async () => {
    const read = vi.fn(async () => [{ ...entry(1), message: 'at C:\\Users\\Alice\\a Bearer tok123' }, entry(2)])
    const preview = await buildLogs({ read }, 1000, 5000, win)
    expect(read).toHaveBeenCalledWith({ since: 1000, until: 5000, limit: 1000 })
    expect(preview.lines).toBe(2)
    expect(preview.truncated).toBe(false)
    expect(preview.text.split('\n')[0]).toContain('最多包含 1000 条')
    expect(preview.text).toMatch(/at ~\\+a \[redacted\]/)
    expect(preview.text).not.toContain('Alice')
    expect(preview.text).not.toContain('tok123')
    expect(preview.bytes).toBe(Buffer.byteLength(preview.text))
  })

  it('超过 1 MB 丢最早的行并注明', async () => {
    const entries = Array.from({ length: 1000 }, (_, i) => entry(i, 2000))
    const preview = await buildLogs({ read: async () => entries }, 0, 1, win)
    expect(preview.truncated).toBe(true)
    expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(FEEDBACK_LIMITS.logBytes)
    const lines = preview.text.split('\n')
    const omitted = Number(/（更早的 (\d+) 行已省略）/.exec(lines[1])?.[1])
    expect(omitted).toBeGreaterThan(0)
    expect(preview.lines).toBe(1000 - omitted)
    expect(lines).toHaveLength(2 + preview.lines)
    expect(preview.text).not.toContain('m0-')
    expect(preview.text).toContain('m999-')
  })
})

describe('packLogs', () => {
  it('gzip + base64，能还原', () => {
    const packed = packLogs('hello 日志\nC:\\Users\\Alice\\x', win)
    expect(gunzipSync(Buffer.from(packed.base64, 'base64')).toString('utf8')).toBe('hello 日志\n~\\x')
  })

  it('压缩后超过 512 KB 报中文错误', () => {
    const noisy = randomBytes(700_000).toString('base64')
    expect(Buffer.byteLength(noisy)).toBeLessThan(FEEDBACK_LIMITS.logBytes)
    expect(() => packLogs(noisy, win)).toThrow(/512 KB/)
  })

  it('原文超过 1 MB 报错', () => {
    expect(() => packLogs('a'.repeat(FEEDBACK_LIMITS.logBytes + 1), win)).toThrow(/1 MB/)
  })
})

describe('buildDiagnostics', () => {
  it('只有版本、系统等字段，没有路径和地址', () => {
    const info = {
      name: '像素星空',
      version: '0.2.15',
      channel: 'installed' as const,
      electron: '33.0.0',
      chrome: '130.0',
      node: '20.0',
      v8: '13',
      os: 'Windows 10.0.28000',
      arch: 'x64',
      authUrl: 'https://auth.example.com',
      dataDir: 'C:\\Users\\Alice\\AppData\\Roaming\\pixelsky',
      repoUrl: 'https://github.com/x/y',
    }
    const { diagnostics, text } = buildDiagnostics(
      info,
      [{ name: 'Claude Code', version: '2.1.289', status: 'ready' }],
      'zh',
    )
    const all = JSON.stringify(diagnostics) + text
    expect(all).not.toMatch(/Alice|AppData|auth\.example|dataDir|github/)
    expect(diagnostics).toMatchObject({
      appVersion: '0.2.15',
      locale: 'zh',
      engines: [{ name: 'Claude Code', version: '2.1.289' }],
    })
    expect(text).toContain('Claude Code 2.1.289')
  })
})

const png = (bytes: number) => ({
  name: 'a.png',
  mediaType: 'image/png',
  data: Buffer.alloc(bytes, 1).toString('base64'),
})

describe('prepareImages', () => {
  const shrink = vi.fn((img: ImageAttachment, edge: number): ImageAttachment | null => {
    const bytes = edge >= 1920 ? FEEDBACK_LIMITS.imageBytes + 1 : 1000
    return { ...img, name: 'a.jpg', mediaType: 'image/jpeg', bytes, dataBase64: Buffer.alloc(bytes).toString('base64') }
  })

  it('够小的原样发送', () => {
    shrink.mockClear()
    const out = prepareImages([png(100)], shrink)
    expect(out).toEqual([
      expect.objectContaining({ kind: 'image', name: 'a.png', media_type: 'image/png', encoding: '' }),
    ])
    expect(shrink).not.toHaveBeenCalled()
  })

  it('太大的先缩，还大就继续缩小边长', () => {
    shrink.mockClear()
    const out = prepareImages([png(FEEDBACK_LIMITS.imageBytes + 10)], shrink)
    expect(shrink.mock.calls.map(c => c[1])).toEqual([2560, 1920, 1280])
    expect(out[0]).toMatchObject({ media_type: 'image/jpeg', name: 'a.jpg' })
  })

  it('校验格式、数量和能否解码', () => {
    expect(() => prepareImages([{ ...png(10), mediaType: 'image/gif' }], shrink)).toThrow(/格式/)
    expect(() => prepareImages([png(1), png(1), png(1), png(1), png(1), png(1)], shrink)).toThrow(/最多/)
    expect(() => prepareImages([png(FEEDBACK_LIMITS.imageBytes + 1)], () => null)).toThrow(/无法读取/)
  })
})

describe('checkErrorSnippet / buildAttachFields', () => {
  it('校验长度并脱敏', () => {
    expect(checkErrorSnippet({ text: 'bad Bearer abc', sessionId: 's1', at: 5 }).text).toBe('bad [redacted]')
    expect(() => checkErrorSnippet({ text: 'x'.repeat(4001), sessionId: 's1', at: 5 })).toThrow()
    expect(() => checkErrorSnippet({ text: '', sessionId: 's1', at: 5 })).toThrow()
  })

  it('诊断按勾选，日志压缩，报错片段转成云端字段', async () => {
    const diagnostics = vi.fn(
      async () =>
        buildDiagnostics(
          { version: '1', channel: 'dev', os: 'o', arch: 'a', electron: 'e', chrome: 'c', node: 'n' },
          [],
          'zh',
        ).diagnostics,
    )
    const deps = {
      diagnostics,
      client: () => ({ app_version: '1', channel: 'dev', os: 'o', arch: 'a', locale: 'zh' }),
      shrink: () => null,
      sanitize: win,
    }
    const off = await buildAttachFields({ diagnostics: false, logs: null, images: [], error: null }, deps)
    expect(off).toMatchObject({ diagnostics: null, error: null, attachments: [] })
    expect(diagnostics).not.toHaveBeenCalled()
    const on = await buildAttachFields(
      { diagnostics: true, logs: 'line', images: [], error: { text: 'e', sessionId: 's', at: Date.UTC(2026, 0, 1) } },
      deps,
    )
    expect(on.diagnostics?.app_version).toBe('1')
    expect(on.error).toEqual({ text: 'e', session_id: 's', at: '2026-01-01T00:00:00.000Z' })
    expect(on.attachments).toEqual([
      expect.objectContaining({ kind: 'log', encoding: 'gzip', media_type: 'text/plain' }),
    ])
  })
})

// 手机经网关提交（docs/mobile-app.md §8.5）：日志给时间窗、在电脑上取；出错片段不收手机的
describe('phoneInput', () => {
  const logs = async (w: unknown) => ({
    text: 'LOG ' + JSON.stringify(w),
    lines: 1,
    bytes: 1,
    truncated: false,
    since: 1,
    until: 2,
  })
  it('turns the log window into log text, keeps other fields, drops the error snippet', async () => {
    const r = await phoneInput(
      {
        type: 'bug',
        title: 't',
        body: 'b',
        diagnostics: true,
        logs: { since: 1 },
        images: [{ name: 'a' }],
        error: { text: 'x' },
      },
      logs,
    )
    expect(r).toEqual({
      type: 'bug',
      title: 't',
      body: 'b',
      diagnostics: true,
      logs: 'LOG {"since":1}',
      images: [{ name: 'a' }],
      error: null,
    })
  })
  it('no logs without a window; diagnostics only when exactly true; images default to none', async () => {
    const r = await phoneInput({ body: 'b', diagnostics: 'yes', logs: null }, logs)
    expect(r).toMatchObject({ diagnostics: false, logs: null, images: [], error: null })
    await expect(phoneInput(null, logs)).rejects.toThrow('反馈参数不对')
    await expect(phoneInput([], logs)).rejects.toThrow('反馈参数不对')
  })
})
