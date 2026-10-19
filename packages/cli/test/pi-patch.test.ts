// 金丝雀：patches/@earendil-works__pi-coding-agent@1.3.0.patch 的每一处改动各一条断言。
// 断言的是「当前装好的、打过补丁的 Pi」。补丁整个打不上时 pnpm 自己会报错；这里防的是为新版本重做补丁时漏了某一块，
// 或者上游改写后补丁虽然打上了、却不再起作用。
// 补丁项与测试的对应表见 docs/own-cli.md §5.1。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// 包的 exports 只开放 "." 和 "./rpc-entry"：先解析入口 dist/index.js，再按它所在目录找 dist 里的其它文件
const distDir = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))
const packageDir = dirname(distDir)
const distFile = (rel: string): string => join(distDir, rel)
const distUrl = (rel: string): string => pathToFileURL(distFile(rel)).href
const distText = (rel: string): string => readFileSync(distFile(rel), 'utf8')

const tmp = mkdtempSync(join(tmpdir(), 'pixel-pi-patch-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('Pi 补丁：package.json 的 piConfig', () => {
  it('piConfig：品牌名 pixelsky、配置目录 .pixelsky-cli（不再是 pi / .pi）', () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      piConfig?: { name?: string; configDir?: string }
    }
    expect(pkg.piConfig?.name).toBe('pixelsky')
    expect(pkg.piConfig?.configDir).toBe('.pixelsky-cli')
  })
})

describe('Pi 补丁：slash-commands.js 去掉 4 条命令', () => {
  it('内置斜杠命令列表里没有 /share /bug /changelog /login（导出常量，直接断言）', async () => {
    const { BUILTIN_SLASH_COMMANDS } = (await import(/* @vite-ignore */ distUrl('core/slash-commands.js'))) as {
      BUILTIN_SLASH_COMMANDS: { name: string }[]
    }
    const names = BUILTIN_SLASH_COMMANDS.map(c => c.name)
    for (const removed of ['share', 'bug', 'changelog', 'login']) expect(names).not.toContain(removed)
  })

  it('内置斜杠命令列表里保留 /logout 和 /export（补丁没有误删别的命令）', async () => {
    const { BUILTIN_SLASH_COMMANDS } = (await import(/* @vite-ignore */ distUrl('core/slash-commands.js'))) as {
      BUILTIN_SLASH_COMMANDS: { name: string }[]
    }
    const names = BUILTIN_SLASH_COMMANDS.map(c => c.name)
    expect(names).toContain('logout')
    expect(names).toContain('export')
  })
})

describe('Pi 补丁：interactive-mode.js', () => {
  // InteractiveMode 是要整套 TUI 才能构造的类，输入分发在一个超长方法里，没有可单独调用的导出，所以只能读文本。
  const text = distText('modes/interactive/interactive-mode.js')

  it('输入 /share /bug /changelog /login 时拦下并提示不可用（interactive-mode.js 的 pixelskyDisabled 块）', () => {
    expect(text).toContain('["share", "bug", "changelog", "login"]')
    expect(text).toContain('在像素星空命令行中不可用')
    // 拦截必须在 /settings 等正常命令分发之前，否则 /share 仍可能走到 Pi 自己的处理
    expect(text.indexOf('在像素星空命令行中不可用')).toBeLessThan(text.indexOf('text === "/settings"'))
  })

  it('启动时不显示 Pi 的更新日志（interactive-mode.js 里 changelogMarkdown 直接置 undefined）', () => {
    expect(text).toContain('this.changelogMarkdown = undefined;')
    expect(text).not.toMatch(/this\.changelogMarkdown = this\.getChangelogForDisplay\(\)/)
  })
})

describe('Pi 补丁：tools-manager.js 不自动下载 fd / rg', () => {
  // 只记下、恢复改过的几个键：整个换掉 process.env 会丢掉 Windows 上环境变量名不分大小写的特性
  const keys = ['PIXELSKY_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'PATH', 'Path', 'PIXELSKY_ALLOW_TOOL_DOWNLOAD']
  const savedEnv = Object.fromEntries(keys.map(k => [k, process.env[k]]))

  it('ensureTool：PATH 和配置目录里都找不到时返回 undefined 并给出「已关闭自动下载」提示，不联网', async () => {
    // TOOLS_DIR 在模块加载时按环境变量算好：必须在 import 之前把配置目录和 PATH 指到空目录
    process.env.PIXELSKY_CODING_AGENT_DIR = tmp
    process.env.PI_CODING_AGENT_DIR = tmp
    process.env.PATH = tmp
    process.env.Path = tmp
    delete process.env.PIXELSKY_ALLOW_TOOL_DOWNLOAD
    // 万一补丁失效，任何联网下载都会失败而不是真的去下
    const realFetch = globalThis.fetch
    let fetched = 0
    globalThis.fetch = ((): Promise<Response> => {
      fetched++
      return Promise.reject(new Error('blocked by pi-patch test'))
    }) as typeof fetch
    try {
      const { ensureTool } = (await import(/* @vite-ignore */ distUrl('utils/tools-manager.js'))) as {
        ensureTool: (
          tool: 'fd' | 'rg',
          onStatus?: (s: { type: string; message: string }) => void,
        ) => Promise<string | undefined>
      }
      for (const tool of ['fd', 'rg'] as const) {
        const statuses: { type: string; message: string }[] = []
        const result = await ensureTool(tool, s => statuses.push(s))
        expect(result).toBeUndefined()
        expect(statuses.map(s => s.message).join('\n')).toContain('auto-download is disabled')
      }
      expect(fetched).toBe(0)
    } finally {
      globalThis.fetch = realFetch
      for (const k of keys) {
        const v = savedEnv[k]
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('PIXELSKY_ALLOW_TOOL_DOWNLOAD=1 开关还在（tools-manager.js；未导出的判断，读文本）', () => {
    expect(distText('utils/tools-manager.js')).toContain('process.env.PIXELSKY_ALLOW_TOOL_DOWNLOAD !== "1"')
  })
})

describe('Pi 补丁：cli/args.js 的 --help', () => {
  it('printHelp 的命令列表里没有 install / remove / uninstall / update，保留 list / config / auth / mcp', async () => {
    const { printHelp } = (await import(/* @vite-ignore */ distUrl('cli/args.js'))) as {
      printHelp: (extensionFlags?: unknown[]) => void
    }
    const lines: string[] = []
    const origLog = console.log
    console.log = (...a: unknown[]): void => {
      lines.push(a.join(' '))
    }
    try {
      printHelp([])
    } finally {
      console.log = origLog
    }
    // 去掉 chalk 的颜色码（ESC [ ... m），再按行取每行第一个词，免得「install」之类的词出现在说明文字里造成误判
    const esc = String.fromCharCode(27)
    const NL = String.fromCharCode(10)
    const help = lines
      .join(NL)
      .split(esc)
      .map((part, i) => (i === 0 ? part : part.slice(part.indexOf('m') + 1)))
      .join('')
    const start = help.indexOf('Commands:')
    const commands = help
      .slice(start, help.indexOf('Options:'))
      .split(NL)
      .slice(1)
      .map(l => l.trim().split(' ').slice(0, 2)[1])
    expect(start).toBeGreaterThan(-1)
    for (const removed of ['install', 'remove', 'uninstall', 'update']) expect(commands).not.toContain(removed)
    for (const kept of ['list', 'config', 'auth', 'mcp']) expect(commands).toContain(kept)
  })
})
