// Claude Code 多账号（docs/ui/engine-accounts-claude.md §2）：账号目录接回原目录、不写原目录、有进程时不同步、
// 三方合并、MCP 现读、「所有项目」规则、额度用完的判断
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineEvent, Item } from '@pixelsky/protocol'
import {
  CLAUDE_SHARED_DIRS,
  ClaudeUserRules,
  allowRuleStrings,
  claudeAccountEnv,
  holdConfigDir,
  merge3,
  nativeMcpServers,
  prepareClaudeAccount,
  resetConfigDirHolds,
  seedGlobalConfig,
  writeAccountMcpFile,
} from '../src/claude/accounts'
import { parseAuthStatus } from '../src/claude/discover'
import { ClaudeTranslator, USAGE_LIMIT_TEXT } from '../src/claude/translate'
import { makeTmp, removeTmp } from './helpers/tmp'

const roots: string[] = []
afterEach(() => {
  resetConfigDirHolds()
  roots.splice(0).forEach(removeTmp)
})
const tmp = (name: string): string => {
  const dir = makeTmp(name)
  roots.push(dir)
  return dir
}

const json = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

/** 原目录里每个文件的内容哈希（不跟进联接） */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name)
      if (name.isDirectory()) walk(p)
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}

/** 原目录：用 CLAUDE_CONFIG_DIR 指过去，.claude.json 也在里面 */
function setup() {
  const root = tmp('claude-accounts')
  const real = join(root, 'real'),
    dir = join(root, 'acc')
  mkdirSync(join(real, 'projects', 'D--work'), { recursive: true })
  writeFileSync(join(real, 'projects', 'D--work', 's1.jsonl'), '{"type":"user"}\n')
  writeFileSync(join(real, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"secret"}}')
  writeFileSync(join(real, 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] }, theme: 'dark' }))
  writeFileSync(join(real, 'CLAUDE.md'), '# 我的偏好\n')
  writeFileSync(
    join(real, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'me@example.com' },
      cachedGrowthBookFeatures: { a: 1 },
      modelAccessCache: { x: 1 },
      userID: 'u1',
      hasCompletedOnboarding: true,
      mcpServers: { github: { command: 'gh-mcp' } },
      projects: {
        'D:/work': {
          allowedTools: ['Bash(npm test)'],
          disabledMcpServers: ['slack'],
          mcpServers: { local: { command: 'local-mcp' } },
          lastCost: 1.5,
        },
      },
    }),
  )
  const env = { CLAUDE_CONFIG_DIR: real } as NodeJS.ProcessEnv
  return { root, real, dir, env }
}

describe('Claude 账号目录', () => {
  it('文件夹联接回原目录、凭据不共享；原目录一个字节都不变', () => {
    const { real, dir, env } = setup()
    const before = snapshot(real)
    expect(prepareClaudeAccount(env, dir)).toBe(true)
    // 共享的文件夹：读得到原目录的对话记录，新写的进原目录
    expect(readFileSync(join(dir, 'projects', 'D--work', 's1.jsonl'), 'utf8')).toContain('user')
    for (const name of CLAUDE_SHARED_DIRS) expect(existsSync(join(dir, name))).toBe(true)
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
    // 联接时补建的空文件夹不算改动，文件一个都没变
    expect(snapshot(real)).toEqual(before)
    // 账号目录里写设置、写 .claude.json：原目录照样不变
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'light' }))
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com' } }))
    expect(prepareClaudeAccount(env, dir)).toBe(true)
    expect(snapshot(real)).toEqual(before)
  })

  it('新账号的 .claude.json：去掉登录信息、缓存和 MCP 服务器，项目只留共用的设置', () => {
    const { dir, env } = setup()
    prepareClaudeAccount(env, dir)
    const seeded = json(join(dir, '.claude.json'))
    expect(seeded.oauthAccount).toBeUndefined()
    expect(seeded.cachedGrowthBookFeatures).toBeUndefined()
    expect(seeded.modelAccessCache).toBeUndefined()
    expect(seeded.userID).toBeUndefined()
    expect(seeded.mcpServers).toBeUndefined()
    expect(seeded.hasCompletedOnboarding).toBe(true)
    expect(seeded.projects).toEqual({
      'D:/work': { allowedTools: ['Bash(npm test)'], disabledMcpServers: ['slack'] },
    })
  })

  it('账号有 Claude Code 进程在跑：什么都不写，等下次', () => {
    const { dir, env } = setup()
    const release = holdConfigDir(dir)
    expect(prepareClaudeAccount(env, dir)).toBe(false)
    expect(existsSync(dir)).toBe(false)
    release()
    expect(prepareClaudeAccount(env, dir)).toBe(true)
    expect(existsSync(join(dir, '.claude.json'))).toBe(true)
  })

  it('三方合并：原目录改的带过来、账号自己改的保留、登录信息不动', () => {
    const { real, dir, env } = setup()
    prepareClaudeAccount(env, dir)
    // 账号这边：Claude Code 写了登录信息，会话里关掉了一个 MCP，settings 里加了一条
    const account = json(join(dir, '.claude.json'))
    account.oauthAccount = { emailAddress: 'work@example.com' }
    ;(account.projects as Record<string, Record<string, unknown>>)['D:/work'].disabledMcpServers = ['slack', 'jira']
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(account))
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read', 'Bash(ls)'] }, theme: 'dark', fastMode: true }),
    )
    // 原目录这边：信任了另一个项目，settings 里换了主题、加了一条规则
    const original = json(join(real, '.claude.json'))
    ;(original.projects as Record<string, unknown>)['D:/other'] = { hasTrustDialogAccepted: true }
    writeFileSync(join(real, '.claude.json'), JSON.stringify(original))
    writeFileSync(
      join(real, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read', 'Grep'] }, theme: 'light' }),
    )
    writeFileSync(join(real, 'CLAUDE.md'), '# 新偏好\n')
    prepareClaudeAccount(env, dir)
    const merged = json(join(dir, '.claude.json'))
    expect(merged.oauthAccount).toEqual({ emailAddress: 'work@example.com' })
    expect(merged.projects).toEqual({
      'D:/work': { allowedTools: ['Bash(npm test)'], disabledMcpServers: ['slack', 'jira'] },
      'D:/other': { hasTrustDialogAccepted: true },
    })
    expect(json(join(dir, 'settings.json'))).toEqual({
      permissions: { allow: ['Read', 'Grep', 'Bash(ls)'] },
      theme: 'light',
      fastMode: true,
    })
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# 新偏好\n')
  })

  it('账号目录里已经有自己的文件夹：不挪进原目录，这一项不共享', () => {
    const { real, dir, env } = setup()
    mkdirSync(join(dir, 'skills'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'mine.md'), 'm')
    const before = snapshot(real)
    prepareClaudeAccount(env, dir)
    expect(readFileSync(join(dir, 'skills', 'mine.md'), 'utf8')).toBe('m')
    expect(existsSync(join(real, 'skills', 'mine.md'))).toBe(false)
    expect(snapshot(real)).toEqual(before)
  })

  it('环境：配置目录换成账号目录，去掉会让凭据共用的 CLAUDE_SECURESTORAGE_CONFIG_DIR', () => {
    const env = claudeAccountEnv({ CLAUDE_SECURESTORAGE_CONFIG_DIR: 'X', PATH: 'p' }, 'D:/acc')
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: 'D:/acc', PATH: 'p' })
  })
})

describe('三方合并', () => {
  it('只有一边改了用那边的；两边都改了用原目录的；数组按并集、原目录删掉的照删', () => {
    expect(merge3({ a: 1 }, { a: 1 }, { a: 2 })).toEqual({ a: 2 })
    expect(merge3({ a: 1 }, { a: 3 }, { a: 1 })).toEqual({ a: 3 })
    expect(merge3({ a: 1 }, { a: 3 }, { a: 2 })).toEqual({ a: 2 })
    expect(merge3({ a: 1, b: 1 }, { a: 1, b: 1 }, { a: 1 })).toEqual({ a: 1 })
    expect(merge3(['x', 'y'], ['x', 'y', 'z'], ['x'])).toEqual(['x', 'z'])
  })

  it('seedGlobalConfig 不带任何缓存键', () => {
    const seeded = seedGlobalConfig({ fooCache: 1, cachedBar: 2, theme: 'dark' })
    expect(seeded).toEqual({ theme: 'dark', projects: {} })
  })
})

describe('MCP 服务器现读', () => {
  it('用户级 + 这个目录的本地级（路径写法不同也认）；和扩展的合成一个文件，同名扩展为准', () => {
    const { root, env } = setup()
    const servers = nativeMcpServers(env, 'D:\\work\\')
    expect(Object.keys(servers).sort()).toEqual(['github', 'local'])
    const ext = join(root, 'ext.json')
    writeFileSync(ext, JSON.stringify({ mcpServers: { github: { command: 'mine' }, history: { command: 'h' } } }))
    const file = writeAccountMcpFile(join(root, 'real'), servers, ext)!
    expect(json(file)).toEqual({
      mcpServers: { github: { command: 'mine' }, local: { command: 'local-mcp' }, history: { command: 'h' } },
    })
    expect(writeAccountMcpFile(root, {}, undefined)).toBeNull()
  })
})

describe('「始终允许（所有项目）」在添加的账号下', () => {
  it('规则换成设置文件的写法、去重后记下', () => {
    const rules = allowRuleStrings([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
        destination: 'session',
      },
      { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Read' }] },
      { type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Write' }] },
    ])
    expect(rules).toEqual(['Bash(npm test:*)', 'Read'])
    const store = new ClaudeUserRules(join(tmp('rules'), 'claude-user-rules.json'))
    store.add(rules)
    store.add(['Read', 'Grep'])
    expect(store.list()).toEqual(['Bash(npm test:*)', 'Read', 'Grep'])
  })
})

describe('auth status', () => {
  it('订阅登录、未登录、不是 JSON', () => {
    expect(
      parseAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'me@example.com',
          subscriptionType: 'max',
          projectsDirectory: 'C:/u/.claude/projects',
        }),
      ),
    ).toEqual({
      loggedIn: true,
      method: 'claude.ai',
      account: { email: 'me@example.com', plan: 'max' },
      projectsDir: 'C:/u/.claude/projects',
    })
    expect(parseAuthStatus('{"loggedIn":false}')?.loggedIn).toBe(false)
    expect(parseAuthStatus('Usage: claude ...')).toBeNull()
  })
})

describe('额度用完的判断', () => {
  const run = (rejected: boolean): Extract<Item, { kind: 'notice' }> | undefined => {
    const events: EngineEvent[] = []
    const t = new ClaudeTranslator('D:/work', {
      emit: e => events.push(e),
      sessionId: () => {},
      permissionMode: () => {},
      turnEnded: () => {},
      fastState: () => {},
    })
    t.startTurn('turn-1')
    if (rejected) t.markUsageLimit()
    const raw = "You've hit your limit · resets 5pm"
    t.handle({
      type: 'assistant',
      message: { id: 'msg_1', model: '<synthetic>', content: [{ type: 'text', text: raw }] },
      error: 'rate_limit',
      parent_tool_use_id: null,
    })
    t.handle({ type: 'result', subtype: 'success', is_error: true, result: raw })
    return events.flatMap(e =>
      e.type === 'item_completed' && e.item.kind === 'notice' && e.item.level === 'error' ? [e.item] : [],
    )[0]
  }

  it('这一轮收到过 rejected 额度事件：报错带 usageLimitExceeded、归到额度一类', () => {
    const notice = run(true)
    expect(notice?.error).toEqual({ kind: 'balance', code: 'usageLimitExceeded' })
    expect(notice?.text).toBe(USAGE_LIMIT_TEXT)
  })

  it('没收到过（普通的 429 限流）：照旧', () => {
    expect(run(false)?.error?.code).toBe('rate_limit')
  })
})

it('账号目录不在原目录里', () => {
  const { real, dir, env } = setup()
  prepareClaudeAccount(env, dir)
  expect(statSync(dir).isDirectory()).toBe(true)
  expect(existsSync(join(real, '.pixelsky-base'))).toBe(false)
})
