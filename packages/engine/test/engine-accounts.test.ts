// 订阅账号多开（docs/ui/engine-accounts.md、engine-accounts-claude.md）：账号目录接回原目录、宿主的添加 / 切换 / 移除、
// 额度用完自动换账号（Codex、Claude 同一套）、提示条的字段、额度恢复后换回；订阅额度都用完时改用平台（§5.2）
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENGINES, type EngineAccounts, type EngineInfo, type HostEvent, type Item } from '@pixelsky/protocol'
import { EngineHost, type EngineAdapter, type EngineHostOptions } from '../src'
import type { AccountProbe, LoginProcess, SessionContext } from '../src/adapter'
import { removeOwnFiles } from '../src/accounts-home'
import { forgetCodexAccount, prepareAccountHome } from '../src/codex/accounts'
import type { QuotaReading } from '../src/quota'
import { HostAccounts, readAccountsFile } from '../src/host/accounts'
import { makeTmp, removeTmp } from './helpers/tmp'

const roots: string[] = []
const hosts: EngineHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(h => h.shutdown()))
  roots.splice(0).forEach(removeTmp)
})
const tmp = (name: string): string => {
  const dir = makeTmp(name)
  roots.push(dir)
  return dir
}

describe('账号目录接回原目录', () => {
  it('文件夹链过去、文件硬链接，凭据不共享；删掉账号目录不动原目录', () => {
    const root = tmp('accounts-home')
    const real = join(root, 'codex'),
      dir = join(root, 'acc')
    mkdirSync(join(real, 'sessions', '2026'), { recursive: true })
    writeFileSync(join(real, 'sessions', '2026', 'rollout.jsonl'), 'x')
    writeFileSync(join(real, 'config.toml'), 'model = "a"\n')
    writeFileSync(join(real, 'auth.json'), '{"secret":1}')
    prepareAccountHome(real, dir)
    expect(readFileSync(join(dir, 'sessions', '2026', 'rollout.jsonl'), 'utf8')).toBe('x')
    // 硬链接：账号目录里追加，原目录里看得到
    writeFileSync(join(dir, 'config.toml'), 'model = "b"\n')
    expect(readFileSync(join(real, 'config.toml'), 'utf8')).toBe('model = "b"\n')
    expect(existsSync(join(dir, 'auth.json'))).toBe(false)
    // 账号里新建的会话写进原目录
    writeFileSync(join(dir, 'sessions', 'new.jsonl'), 'y')
    expect(readFileSync(join(real, 'sessions', 'new.jsonl'), 'utf8')).toBe('y')
    rmSync(dir, { recursive: true, force: true })
    expect(readFileSync(join(real, 'sessions', '2026', 'rollout.jsonl'), 'utf8')).toBe('x')
    expect(existsSync(join(real, 'config.toml'))).toBe(true)
  })

  it('Codex 整个重写了 config.toml（链接断开）：新内容拷回原目录再重新链上；再调一次不变', () => {
    const root = tmp('accounts-home')
    const real = join(root, 'codex'),
      dir = join(root, 'acc')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'config.toml'), 'old\n')
    prepareAccountHome(real, dir)
    rmSync(join(dir, 'config.toml'))
    writeFileSync(join(dir, 'config.toml'), 'new\n')
    const later = new Date(Date.now() + 5000)
    utimesSync(join(dir, 'config.toml'), later, later)
    prepareAccountHome(real, dir)
    expect(readFileSync(join(real, 'config.toml'), 'utf8')).toBe('new\n')
    const a = statSync(join(real, 'config.toml'), { bigint: true }),
      b = statSync(join(dir, 'config.toml'), { bigint: true })
    expect(a.ino).toBe(b.ino)
    prepareAccountHome(real, dir)
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe('new\n')
  })

  it('链上之前 Codex 自己建了文件夹：里面的东西挪回原目录', () => {
    const root = tmp('accounts-home')
    const real = join(root, 'codex'),
      dir = join(root, 'acc')
    mkdirSync(join(dir, 'skills'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'mine.md'), 'm')
    prepareAccountHome(real, dir)
    expect(readFileSync(join(real, 'skills', 'mine.md'), 'utf8')).toBe('m')
    expect(readFileSync(join(dir, 'skills', 'mine.md'), 'utf8')).toBe('m')
  })

  it('删除账号只删账号目录里自己的凭据文件：接回原目录的文件夹、路径里带分隔符的名字一律不碰', () => {
    const root = tmp('accounts-forget')
    const real = join(root, 'codex'),
      dir = join(root, 'acc')
    mkdirSync(join(real, 'sessions'), { recursive: true })
    writeFileSync(join(real, 'sessions', 'auth.json'), 'keep')
    writeFileSync(join(real, 'auth.json'), '{"original":1}')
    prepareAccountHome(real, dir)
    writeFileSync(join(dir, 'auth.json'), '{"account":1}')
    expect(forgetCodexAccount(dir)).toEqual(['auth.json'])
    expect(existsSync(join(dir, 'auth.json'))).toBe(false)
    expect(readFileSync(join(real, 'auth.json'), 'utf8')).toBe('{"original":1}')
    // 链接、文件夹、带路径的名字：什么都不删
    expect(removeOwnFiles(dir, ['sessions', '..', 'sessions/auth.json', join('sessions', 'auth.json')])).toEqual([])
    expect(readFileSync(join(real, 'sessions', 'auth.json'), 'utf8')).toBe('keep')
    expect(existsSync(join(dir, 'sessions'))).toBe(true)
  })

  it('账号目录建不起来：不抛错，返回 false 让调用方下次再试；建得起来返回 true', () => {
    const root = tmp('accounts-home')
    const real = join(root, 'codex'),
      blocker = join(root, 'blocker')
    // 父路径是个文件：mkdir 失败
    writeFileSync(blocker, '')
    expect(prepareAccountHome(real, join(blocker, 'acc'))).toBe(false)
    rmSync(blocker)
    expect(prepareAccountHome(real, join(blocker, 'acc'))).toBe(true)
  })
})

describe('账号文件', () => {
  it('Dot 可解析未写入账号文件的原有默认登录；隐藏的默认账号和未知账号仍拒绝', () => {
    const accounts = (saved: unknown) =>
      new HostAccounts({
        store: { loadAccounts: () => saved },
        opts: { dataDir: 'test-data' },
      } as never)
    // list() 在尚未添加账号时动态返回 default，持久化的 accounts 仍是空数组。
    expect(accounts({}).knownDir('codex', 'default')).toBeNull()
    const managed = accounts({
      codex: {
        hideDefault: true,
        current: 'a_111111111111',
        accounts: [{ id: 'a_111111111111', email: 'work@example.com' }],
      },
    })
    expect(() => managed.knownDir('codex', 'default')).toThrow(/unavailable/)
    expect(() => managed.knownDir('codex', '../invalid')).toThrow(/unavailable/)
    expect(managed.knownDir('codex', 'a_111111111111')).toBe(join('test-data', 'accounts', 'codex', 'a_111111111111'))
  })

  it('不合法的项丢掉，当前账号不在列表里时回到原来的；自动切换默认关', () => {
    const file = readAccountsFile({
      codex: {
        current: 'a_000000000000',
        accounts: [{ id: 'default', email: 'a@x.com' }, { id: '../evil' }, { id: 'a_111111111111', status: 'ok' }],
        auto: { enabled: 'yes' },
      },
    })
    expect(file.codex?.current).toBe('default')
    expect(file.codex?.accounts.map(a => a.id)).toEqual(['default', 'a_111111111111'])
    expect(file.codex?.auto).toEqual({ enabled: false, order: 'list', switchBack: true, notice: true, platform: false })
  })

  it('原来的账号隐藏着：要还有添加的账号才成立，列表里不留它，当前账号不会落回它；待删凭据只留合法的 id', () => {
    const file = readAccountsFile({
      codex: {
        current: 'default',
        hideDefault: true,
        cleanup: ['a_222222222222', 'a_111111111111', 'bad', 'a_222222222222', 3],
        accounts: [
          { id: 'default', email: 'me@example.com' },
          { id: 'a_111111111111', email: 'work@example.com' },
        ],
      },
      claude: { current: 'default', hideDefault: true, accounts: [{ id: 'default', email: 'me@example.com' }] },
    })
    expect(file.codex?.accounts.map(a => a.id)).toEqual(['a_111111111111'])
    expect(file.codex?.current).toBe('a_111111111111')
    expect(file.codex?.hideDefault).toBe(true)
    // 还在列表里的不算待删
    expect(file.codex?.cleanup).toEqual(['a_222222222222'])
    expect(file.claude?.hideDefault).toBe(false)
    expect(file.claude?.accounts.map(a => a.id)).toEqual(['default'])
  })
})

/** 假引擎：每个账号目录一个邮箱；会话按创建次序决定这一轮是额度用完还是正常完成 */
function setup(
  opts: {
    limited?: (session: number) => boolean
    engine?: 'codex' | 'claude'
    /** 额度用完时顺带报的恢复时间（会话的额度事件，宿主按原账号记下） */
    resetsAt?: () => number
    /** 适配器报某个账号目录还有进程在用 */
    inUse?: (dir: string) => boolean
    /** 第 n 个会话的这一轮等它放行才出结果（让额度用完的失败晚到） */
    gate?: (session: number) => Promise<void>
    /** 会话进程借来读额度时回的账号邮箱（第 n 个会话）；不给就没有这个能力 */
    sessionQuota?: (session: number) => string
    /** 订阅额度都用完时改用平台挑线路（主进程提供的那个） */
    platformRoute?: EngineHostOptions['platformRoute']
  } = {},
) {
  const engine = opts.engine ?? 'codex'
  const root = tmp('accounts-host')
  const events: HostEvent[] = []
  const emails = new Map<string | null, string>([[null, 'me@example.com']])
  let nextEmail = 'work@example.com'
  const loggedOut: (string | null)[] = []
  const forgotten: string[] = []
  /** 每次发送：哪个进程、发的什么、这时会话用的线路（null 是自己的订阅）和模型 */
  const sends: { session: number; text: string; platform: string | null; model: string | null }[] = []
  /** 哪些会话进程被借去读了额度；临时进程（adapter.accountQuota）读了几次 */
  const borrowed: number[] = []
  let tempQuota = 0
  let sessions = 0
  const done = (): LoginProcess => ({
    write() {},
    kill() {},
    done: Promise.resolve({ ok: true, started: true, stdout: '', stderr: '', error: null }),
  })
  const adapter: EngineAdapter = {
    info: async () =>
      ({
        ...ENGINES[engine],
        status: 'ready',
        version: 'test',
        path: engine,
        message: null,
        account: { email: 'me@example.com', plan: 'plus' },
      }) as EngineInfo,
    login: async () => done(),
    ...(opts.inUse ? { accountInUse: opts.inUse } : {}),
    ...(opts.sessionQuota
      ? {
          accountQuota: async () => {
            tempQuota++
            return quotaOf('work@example.com')
          },
        }
      : {}),
    accountLogin: async dir => {
      emails.set(dir, nextEmail)
      return done()
    },
    accountLogout: async dir => {
      loggedOut.push(dir)
      emails.delete(dir)
      return { ok: true, output: '', version: null }
    },
    accountForget: dir => {
      forgotten.push(dir)
      emails.delete(dir)
    },
    accountProbe: async (dir): Promise<AccountProbe> => {
      const email = emails.get(dir) ?? null
      return {
        signedIn: !!email,
        email,
        plan: 'plus',
        quota: email
          ? {
              kind: 'ok',
              plan: 'plus',
              account: email,
              windows: [{ id: 'five_hour', durationMins: 300, usedPercent: 10, resetsAt: null }],
              extras: {},
              blocked: null,
              observedAt: Date.now(),
            }
          : null,
      }
    },
    createSession: (ctx: SessionContext) => {
      const n = ++sessions
      return {
        ...(opts.sessionQuota
          ? {
              accountQuota: async () => {
                borrowed.push(n)
                return quotaOf(opts.sessionQuota!(n))
              },
            }
          : {}),
        send: (text, turnId) => {
          const record = ctx.record()
          sends.push({ session: n, text, platform: record.platform?.groupId ?? null, model: record.model })
          void (opts.gate?.(n) ?? Promise.resolve()).then(() =>
            setTimeout(() => {
              if (opts.limited?.(n)) {
                if (opts.resetsAt)
                  ctx.reportQuota?.({
                    windows: [
                      {
                        id: 'five_hour',
                        durationMins: 300,
                        usedPercent: 100,
                        resetsAt: opts.resetsAt(),
                        rejected: true,
                      },
                    ],
                    observedAt: Date.now(),
                  })
                ctx.emit({
                  type: 'item_completed',
                  item: {
                    kind: 'notice',
                    id: `limit-${n}`,
                    level: 'error',
                    text: 'You have hit your usage limit',
                    error: { kind: 'balance', code: 'usageLimitExceeded' },
                  },
                })
                ctx.emit({ type: 'turn_completed', turnId, outcome: 'failed', error: 'You have hit your usage limit' })
              } else {
                ctx.emit({
                  type: 'item_completed',
                  item: { kind: 'assistant', id: `a-${n}-${turnId}`, text: 'ok' } as Item,
                })
                ctx.emit({ type: 'turn_completed', turnId, outcome: 'completed', error: null })
              }
            }, 5),
          )
        },
        interrupt: async () => {},
        answer: () => {},
        update: async () => {},
        close: async () => {},
      }
    },
  }
  const host = new EngineHost({
    dataDir: join(root, 'data'),
    adapters: { [engine]: adapter },
    emit: e => events.push(e),
    ...(opts.platformRoute ? { platformRoute: opts.platformRoute } : {}),
  })
  hosts.push(host)
  const accountsEvents = (): EngineAccounts[] => events.flatMap(e => (e.kind === 'engine_accounts' ? [e.accounts] : []))
  const addAccount = async (email: string): Promise<EngineAccounts> => {
    nextEmail = email
    const before = accountsEvents().length
    host.addAccount(engine)
    await vi.waitFor(() => expect(accountsEvents().length).toBeGreaterThan(before))
    return accountsEvents().at(-1)!
  }
  return {
    root,
    host,
    engine,
    events,
    emails,
    addAccount,
    loggedOut,
    forgotten,
    sends,
    borrowed,
    tempQuota: () => tempQuota,
    /** 下一次登录（添加 / 重新登录）登进去的邮箱 */
    loginAs: (email: string) => (nextEmail = email),
    sessions: () => sessions,
    accountsEvents,
  }
}

const quotaOf = (account: string): QuotaReading => ({
  kind: 'ok',
  plan: 'plus',
  account,
  windows: [{ id: 'five_hour', durationMins: 300, usedPercent: 20, resetsAt: null }],
  extras: {},
  blocked: null,
  observedAt: Date.now(),
})

/** 手动放行的闸门：open() 之后 wait() 才返回 */
function latch() {
  let open!: () => void
  const opened = new Promise<void>(r => (open = r))
  return { open, wait: () => opened }
}

describe('宿主的账号列表', () => {
  it('只有原来的登录时列一项；添加账号后原来的排第一，不换当前账号；同一邮箱不重复添加', async () => {
    const { host, addAccount, events, loggedOut, forgotten } = setup()
    expect((await host.accounts('codex')).accounts.map(a => a.email)).toEqual(['me@example.com'])
    const list = await addAccount('work@example.com')
    expect(list.accounts.map(a => a.email)).toEqual(['me@example.com', 'work@example.com'])
    expect(list.current).toBe('default')
    // 再登录一次同一个邮箱：报错，新目录里刚写的凭据删掉（不跑退出登录）
    host.addAccount('codex')
    await vi.waitFor(() => expect(events.some(e => e.kind === 'engine_login' && e.login.phase === 'failed')).toBe(true))
    const failed = events.findLast(e => e.kind === 'engine_login')
    expect(failed?.kind === 'engine_login' && failed.login.error).toMatch(/已经在列表里/)
    expect(loggedOut).toEqual([])
    expect(forgotten).toHaveLength(1)
    expect((await host.accounts('codex')).accounts).toHaveLength(2)
  })

  it('切换后下一条消息换进程；删除当前账号：先换到别的账号、不退出登录；删完只剩原来的就回到单账号', async () => {
    const env = setup()
    const { host, addAccount } = env
    const list = await addAccount('work@example.com')
    const work = list.accounts[1].id
    const project = host.addProject(env.root)
    const id = host.createSession({ projectId: project.id, engine: 'codex' }).id
    await host.send(id, '第一条')
    await vi.waitFor(() => expect(host.open(id).state).toBe('idle'))
    await host.switchAccount('codex', work)
    await host.send(id, '第二条')
    await vi.waitFor(() => expect(env.sends).toHaveLength(2))
    expect(env.sends.map(s => s.session)).toEqual([1, 2])
    const after = await host.removeAccount('codex', work)
    expect(after.accounts).toEqual([])
    expect(after.current).toBe('default')
    expect(env.loggedOut).toEqual([])
    expect(env.forgotten).toHaveLength(1)
    // 下一条消息用原来的账号，换进程接上
    await vi.waitFor(() => expect(host.open(id).state).toBe('idle'))
    await host.send(id, '第三条')
    await vi.waitFor(() => expect(env.sends).toHaveLength(3))
    expect(env.sends.map(s => s.session)).toEqual([1, 2, 3])
  })

  it('还有对话的进程在用（换账号之前开的）：照样能删，凭据文件等进程没了再删；从不退出登录', async () => {
    let busy = true
    const env = setup({ inUse: () => busy })
    const list = await env.addAccount('work@example.com')
    const work = list.accounts[1].id
    expect((await env.host.removeAccount('codex', work)).accounts).toEqual([])
    expect(env.forgotten).toEqual([])
    await env.host.accounts('codex')
    expect(env.forgotten).toEqual([])
    busy = false
    await env.host.accounts('codex')
    expect(env.forgotten).toHaveLength(1)
    await env.host.accounts('codex')
    expect(env.forgotten).toHaveLength(1)
    expect(env.loggedOut).toEqual([])
  })

  it('删除原来的账号只是隐藏：不退出登录、换到添加的账号、不再列出；「显示原来的账号」放回来；删完添加的账号原来的自动回来', async () => {
    const env = setup()
    const list = await env.addAccount('work@example.com')
    const work = list.accounts[1].id
    const hidden = await env.host.removeAccount('codex', 'default')
    expect(hidden.accounts.map(a => a.id)).toEqual([work])
    expect(hidden).toMatchObject({ current: work, defaultHidden: true })
    expect(env.loggedOut).toEqual([])
    expect(env.forgotten).toEqual([])
    // 重新检测、读额度都不会把它放回来
    expect((await env.host.accounts('codex')).accounts.map(a => a.id)).toEqual([work])
    expect((await env.host.accountsQuota('codex', true)).map(r => r.id)).toEqual([work])
    const shown = await env.host.showDefaultAccount('codex')
    expect(shown.accounts.map(a => a.id)).toEqual(['default', work])
    expect(shown.accounts[0]).toMatchObject({ email: 'me@example.com', status: 'ok' })
    expect(shown).toMatchObject({ current: work, defaultHidden: false })
    // 再隐藏，然后删掉唯一添加的账号：原来的回来，回到单账号
    await env.host.removeAccount('codex', 'default')
    const back = await env.host.removeAccount('codex', work)
    expect(back).toMatchObject({ current: 'default', accounts: [], defaultHidden: false })
    expect(env.loggedOut).toEqual([])
  })

  it('别的账号都失效了：原来的账号不能删（不然没有账号可用）', async () => {
    const env = setup()
    const list = await env.addAccount('work@example.com')
    expect(list.accounts).toHaveLength(2)
    // 添加的账号目录里的登录没了（登录失效）
    for (const [dir] of env.emails) if (dir) env.emails.delete(dir)
    await env.host.accountsQuota('codex', true)
    expect((await env.host.accounts('codex')).accounts[1].status).toBe('expired')
    await expect(env.host.removeAccount('codex', 'default')).rejects.toThrow(/没有别的可用账号/)
  })

  it('额度：每个账号读一次，60 秒内用缓存', async () => {
    const { host, addAccount } = setup()
    await addAccount('work@example.com')
    const rows = await host.accountsQuota('codex', true)
    expect(rows.map(r => r.windows[0]?.usedPercent)).toEqual([10, 10])
  })
})

describe('重新登录', () => {
  const finished = async (env: ReturnType<typeof setup>) => {
    await vi.waitFor(() =>
      expect(env.events.findLast(e => e.kind === 'engine_login')).toMatchObject({
        login: { phase: expect.stringMatching(/done|failed/) },
      }),
    )
    const last = env.events.findLast(e => e.kind === 'engine_login')
    return last?.kind === 'engine_login' ? last.login : null
  }

  it('授权时登成了别的账号：报错，原账号的目录和登录不动，新目录删掉本机凭据，列表里还是原来的邮箱', async () => {
    const env = setup()
    const list = await env.addAccount('work@example.com')
    const work = list.accounts[1]
    const workDir = [...env.emails].find(([, email]) => email === 'work@example.com')![0]
    env.loginAs('other@example.com')
    env.host.reloginAccount('codex', work.id)
    expect(await finished(env)).toMatchObject({ phase: 'failed', error: expect.stringMatching(/other@example.com/) })
    expect(env.emails.get(workDir)).toBe('work@example.com')
    // 不跑退出登录（只在像素星空里生效）：没用上的新目录删掉本机凭据，原账号的目录不碰
    expect(env.loggedOut).toEqual([])
    expect(env.forgotten).toHaveLength(1)
    expect(env.forgotten[0]).not.toBe(workDir)
    // 之后探测一遍：还是原来的账号，不会变成别人
    await env.host.accountsQuota('codex', true)
    const after = await env.host.accounts('codex')
    expect(after.accounts.map(a => [a.id, a.email])).toEqual([
      ['default', 'me@example.com'],
      [work.id, 'work@example.com'],
    ])
  })

  it('登回同一个账号：这一行改用新目录（当前账号跟着换 id），旧目录删掉本机凭据，邮箱不变', async () => {
    const env = setup()
    const list = await env.addAccount('work@example.com')
    const work = list.accounts[1]
    await env.host.switchAccount('codex', work.id)
    const workDir = [...env.emails].find(([, email]) => email === 'work@example.com')![0]
    env.loginAs('work@example.com')
    env.host.reloginAccount('codex', work.id)
    expect(await finished(env)).toMatchObject({ phase: 'done' })
    const after = await env.host.accounts('codex')
    expect(after.accounts).toHaveLength(2)
    const row = after.accounts[1]
    expect(row.email).toBe('work@example.com')
    expect(row.id).not.toBe(work.id)
    expect(after.current).toBe(row.id)
    expect(env.loggedOut).toEqual([])
    expect(env.forgotten).toEqual([workDir])
  })
})

describe('额度用完自动换账号', () => {
  async function send(env: ReturnType<typeof setup>) {
    const project = env.host.addProject(env.root)
    const record = env.host.createSession({ projectId: project.id, engine: env.engine })
    await env.host.send(record.id, '改一下按钮颜色')
    return record.id
  }

  it('默认关：额度用完不换账号，这条等额度恢复后自动继续（docs/ui/rate-limit-resume.md）', async () => {
    const env = setup({ limited: n => n === 1 })
    await env.addAccount('work@example.com')
    const id = await send(env)
    await vi.waitFor(() => expect(env.host.open(id).queue[0]?.limit).toMatchObject({ kind: 'quota', tries: [] }))
    expect(env.host.open(id).queue[0]).toMatchObject({ status: 'queued', reconnect: { limited: true } })
    expect((await env.host.accounts('codex')).current).toBe('default')
    expect(env.sessions()).toBe(1)
  })

  it('额度事件带恢复时间：等到那之后再继续，卡片写 5 小时窗口', async () => {
    const resetsAt = Date.now() + 3_600_000
    const env = setup({ limited: n => n === 1, resetsAt: () => resetsAt })
    const id = await send(env)
    await vi.waitFor(() => expect(env.host.open(id).queue[0]?.limit).toMatchObject({ window: 'five_hour', resetsAt }))
    expect(env.host.open(id).queue[0].reconnect?.at).toBe(resetsAt + 5_000)
    expect(env.sends).toHaveLength(1)
  })

  it('打开后：换到下一个账号、对话里提示一句，这条用新账号的进程重新派发', async () => {
    const env = setup({ limited: n => n === 1 })
    const list = await env.addAccount('work@example.com')
    env.host.setAccountAuto('codex', { enabled: true })
    const id = await send(env)
    await vi.waitFor(() => expect(env.sends).toHaveLength(2))
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    expect((await env.host.accounts('codex')).current).toBe(list.accounts[1].id)
    expect(env.sends.map(s => s.session)).toEqual([1, 2])
    const notice = env.host.open(id).items.find(i => i.kind === 'notice' && i.id.startsWith('account-switch-'))
    expect(notice && notice.kind === 'notice' && notice.text).toMatch(/work@example\.com/)
    // 提示条的字段：界面按它拼文字、给「换回去」「关闭自动切换」
    expect(notice && notice.kind === 'notice' && notice.account).toEqual({
      engine: 'codex',
      from: 'default',
      to: list.accounts[1].id,
      fromName: 'me@example.com',
      toName: 'work@example.com',
      window: null,
      resetsAt: null,
    })
    expect(env.host.open(id).queue).toEqual([])
  })

  it('Claude 会话也一样：额度事件里的恢复时间带进提示条；到了恢复时间、下一轮结束时换回原账号', async () => {
    let resetsAt = 0
    const env = setup({
      engine: 'claude',
      limited: n => n === 1,
      // 留够余量：机器忙时第一轮结束得晚，恢复时间太近会在断言前就换回原账号
      resetsAt: () => (resetsAt = Date.now() + 1500),
    })
    const list = await env.addAccount('work@example.com')
    env.host.setAccountAuto('claude', { enabled: true })
    const id = await send(env)
    await vi.waitFor(() => expect(env.sends).toHaveLength(2))
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    const notice = env.host.open(id).items.find(i => i.kind === 'notice' && i.id.startsWith('account-switch-'))
    expect(notice && notice.kind === 'notice' && notice.account).toMatchObject({
      engine: 'claude',
      to: list.accounts[1].id,
      window: 'five_hour',
      resetsAt,
    })
    // 换到的账号上再聊一轮：这时已过恢复时间，结束后去看原账号，恢复了就换回去
    await new Promise(r => setTimeout(r, Math.max(0, resetsAt - Date.now()) + 20))
    await env.host.send(id, '接着改')
    await vi.waitFor(async () => expect((await env.host.accounts('claude')).current).toBe('default'))
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    await vi.waitFor(() => expect(env.host.open(id).queue).toEqual([]))
  })

  it('重连次数设成 0（关闭）：换了账号的那条照样重新发送', async () => {
    const env = setup({ limited: n => n === 1 })
    await env.addAccount('work@example.com')
    env.host.setRetrySettings(0)
    env.host.setAccountAuto('codex', { enabled: true })
    const id = await send(env)
    await vi.waitFor(() => expect(env.sends).toHaveLength(2))
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    expect(env.host.open(id).queue).toEqual([])
  })

  it('所有账号都用完：只换一次，第二次没有账号可换，转成等额度恢复', async () => {
    const env = setup({ limited: () => true })
    await env.addAccount('work@example.com')
    env.host.setAccountAuto('codex', { enabled: true })
    const id = await send(env)
    await vi.waitFor(() => expect(env.host.open(id).queue[0]?.limit).toMatchObject({ kind: 'quota' }))
    expect(env.sends).toHaveLength(2)
  })

  it('原账号的失败晚到、期间手动换到了 B：算原账号用完，在 B 上重发，不把 B 记成用完、不跳到 C', async () => {
    const gate = latch()
    const env = setup({ limited: n => n === 1, gate: n => (n === 1 ? gate.wait() : Promise.resolve()) })
    await env.addAccount('work@example.com')
    const list = await env.addAccount('third@example.com')
    const [, b] = list.accounts
    env.host.setAccountAuto('codex', { enabled: true })
    const id = await send(env)
    await vi.waitFor(() => expect(env.sends).toHaveLength(1))
    await env.host.switchAccount('codex', b.id)
    gate.open()
    await vi.waitFor(() => expect(env.sends).toHaveLength(2))
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    expect((await env.host.accounts('codex')).current).toBe(b.id)
    const notice = env.host.open(id).items.find(i => i.kind === 'notice' && i.id.startsWith('account-switch-'))
    expect(notice && notice.kind === 'notice' && notice.account).toMatchObject({ from: 'default', to: b.id })
  })

  it('原账号的失败晚到、期间已删掉原账号（当前成了 B）：不把 B 记成用完，在 B 上重发，不跳到 C', async () => {
    const gate = latch()
    const env = setup({ limited: n => n === 1, gate: n => (n === 1 ? gate.wait() : Promise.resolve()) })
    await env.addAccount('work@example.com')
    const list = await env.addAccount('third@example.com')
    const [, b] = list.accounts
    env.host.setAccountAuto('codex', { enabled: true })
    const id = await send(env)
    await vi.waitFor(() => expect(env.sends).toHaveLength(1))
    expect((await env.host.removeAccount('codex', 'default')).current).toBe(b.id)
    gate.open()
    await vi.waitFor(() => expect(env.sends).toHaveLength(2))
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    expect((await env.host.accounts('codex')).current).toBe(b.id)
    const notice = env.host.open(id).items.find(i => i.kind === 'notice' && i.id.startsWith('account-switch-'))
    expect(notice && notice.kind === 'notice' && notice.account).toMatchObject({ to: b.id })
  })

  it('同一账号的两个会话一起用完：只换一次（到 B），第二个也在 B 上重发，不把 B 记成用完', async () => {
    const gate = latch()
    const env = setup({ limited: n => n <= 2, gate: n => (n <= 2 ? gate.wait() : Promise.resolve()) })
    await env.addAccount('work@example.com')
    const list = await env.addAccount('third@example.com')
    const [, b] = list.accounts
    env.host.setAccountAuto('codex', { enabled: true })
    const first = await send(env)
    const second = await send(env)
    await vi.waitFor(() => expect(env.sends).toHaveLength(2))
    gate.open()
    await vi.waitFor(() => expect(env.sends).toHaveLength(4))
    await vi.waitFor(() => expect([first, second].map(id => env.host.open(id).state)).toEqual(['idle', 'idle']))
    expect((await env.host.accounts('codex')).current).toBe(b.id)
    for (const id of [first, second])
      expect(
        env.host
          .open(id)
          .items.find(i => i.kind === 'notice' && i.id.startsWith('account-switch-') && i.account?.to === b.id),
      ).toBeTruthy()
  })
})

describe('订阅额度都用完时改用平台', () => {
  const ROUTE = { groupId: '7', group: '便宜线路', account: 'me@pixel.test', model: 'gpt-5.5' }
  async function send(env: ReturnType<typeof setup>, model: string | null = 'gpt-5.4') {
    const project = env.host.addProject(env.root)
    const record = env.host.createSession({ projectId: project.id, engine: env.engine })
    await env.host.update(record.id, { model })
    await env.host.send(record.id, '改一下按钮颜色')
    return record.id
  }
  const noticesOf = (env: ReturnType<typeof setup>, id: string) =>
    env.host.open(id).items.flatMap(i => (i.kind === 'notice' && i.fallback ? [i] : []))

  it('默认关：额度用完不问线路，转成等额度恢复', async () => {
    const route = vi.fn(async () => ROUTE)
    const env = setup({ limited: n => n === 1, platformRoute: route })
    const id = await send(env)
    await vi.waitFor(() => expect(env.host.open(id).queue[0]?.limit).toMatchObject({ kind: 'quota' }))
    expect(route).not.toHaveBeenCalled()
    expect(env.host.open(id).record.platform ?? null).toBeNull()
  })

  it('只有一个订阅账号：用完就改用挑到的线路和模型，这条用平台的进程重发；排在后面的消息一起改；提示条带字段', async () => {
    const gate = latch()
    const route = vi.fn(async () => {
      await gate.wait()
      return ROUTE
    })
    const env = setup({ limited: n => n === 1, platformRoute: route })
    env.host.setAccountAuto('codex', { platform: true })
    const id = await send(env)
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1))
    // 挑线路的时候又来一条：排在后面，等线路挑好一起改用平台
    await env.host.send(id, '再改一下字号')
    await new Promise(r => setTimeout(r, 30))
    // 挑好之前不会又用订阅发一次
    expect(env.sends).toHaveLength(1)
    gate.open()
    await vi.waitFor(() => expect(env.sends).toHaveLength(3))
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    expect(route).toHaveBeenCalledWith({ engine: 'codex', model: 'gpt-5.4' })
    expect(env.sends.map(s => [s.session, s.platform, s.model])).toEqual([
      [1, null, 'gpt-5.4'],
      [2, '7', 'gpt-5.5'],
      [2, '7', 'gpt-5.5'],
    ])
    const record = env.host.open(id).record
    expect(record.platform).toEqual({ groupId: '7', account: 'me@pixel.test' })
    expect(record.provider ?? null).toBeNull()
    expect(record.platformFallback).toEqual({ account: 'default', model: 'gpt-5.4', resetsAt: null })
    const [notice] = noticesOf(env, id)
    expect(notice.text).toMatch(/便宜线路 · gpt-5\.5/)
    expect(notice.fallback).toEqual({
      engine: 'codex',
      kind: 'platform',
      fromName: 'ChatGPT 账号',
      group: '便宜线路',
      model: 'gpt-5.5',
      selfModel: 'gpt-5.4',
      window: null,
      resetsAt: null,
    })
    expect(env.host.open(id).queue).toEqual([])
    // 新会话不受影响：默认值没有改成平台
    expect(
      env.host.createSession({ projectId: env.host.open(id).record.projectId, engine: 'codex' }).platform ?? null,
    ).toBeNull()
  })

  it('开着自动换账号：先换账号，账号都用完了才改用平台', async () => {
    const route = vi.fn(async () => ROUTE)
    const env = setup({ limited: n => n <= 2, platformRoute: route })
    const list = await env.addAccount('work@example.com')
    env.host.setAccountAuto('codex', { enabled: true, platform: true })
    const id = await send(env)
    await vi.waitFor(() => expect(env.sends).toHaveLength(3))
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    expect(env.sends.map(s => s.platform)).toEqual([null, null, '7'])
    expect(route).toHaveBeenCalledTimes(1)
    expect(env.host.open(id).items.some(i => i.kind === 'notice' && i.account?.to === list.accounts[1].id)).toBe(true)
    expect(noticesOf(env, id)[0].fallback).toMatchObject({ kind: 'platform', fromName: 'work@example.com' })
    expect(env.host.open(id).record.platformFallback?.account).toBe(list.accounts[1].id)
  })

  it('开着自动换账号、还有没用完的账号：不改用平台，照常换账号', async () => {
    const route = vi.fn(async () => ROUTE)
    const env = setup({ limited: n => n === 1, platformRoute: route })
    await env.addAccount('work@example.com')
    env.host.setAccountAuto('codex', { enabled: true, platform: true })
    const id = await send(env)
    await vi.waitFor(() => expect(env.sends).toHaveLength(2))
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    expect(route).not.toHaveBeenCalled()
    expect(env.sends.map(s => s.platform)).toEqual([null, null])
  })

  it('挑不到线路：这条照常失败，错误后面写明为什么没改用平台，会话来源不动', async () => {
    const env = setup({ limited: n => n === 1, platformRoute: async () => ({ error: '平台余额不足，请先充值' }) })
    env.host.setAccountAuto('codex', { platform: true })
    const id = await send(env)
    await vi.waitFor(() => expect(env.host.open(id).queue[0]?.status).toBe('failed'))
    const snap = env.host.open(id)
    expect(snap.queue[0].error).toBe('You have hit your usage limit\n没有改用平台：平台余额不足，请先充值')
    expect(snap.queuePaused).toBe(true)
    expect(snap.record.platform ?? null).toBeNull()
    expect(snap.record.platformFallback ?? null).toBeNull()
    expect(env.sends).toHaveLength(1)
    expect(noticesOf(env, id)).toEqual([])
  })

  it('挑线路的时候点了停止：什么都不改，这条算失败', async () => {
    const gate = latch()
    const env = setup({
      limited: n => n === 1,
      platformRoute: async () => {
        await gate.wait()
        return ROUTE
      },
    })
    env.host.setAccountAuto('codex', { platform: true })
    const id = await send(env)
    await vi.waitFor(() => expect(env.host.open(id).queue[0]?.reconnect?.account).toBe(true))
    await env.host.interrupt(id)
    gate.open()
    await vi.waitFor(() => expect(env.host.open(id).queue[0]?.status).toBe('failed'))
    await new Promise(r => setTimeout(r, 30))
    expect(env.host.open(id).record.platform ?? null).toBeNull()
    expect(env.sends).toHaveLength(1)
  })

  it('Claude 也一样：额度恢复后、下一轮结束时换回订阅和原来的模型，再提示一句；自己改过模型就不再换回', async () => {
    let resetsAt = 0
    const env = setup({
      engine: 'claude',
      limited: n => n === 1,
      // 留够余量：机器忙时第一轮结束得晚，恢复时间太近会在断言前就换回
      resetsAt: () => (resetsAt = Date.now() + 1500),
      platformRoute: async () => ({ ...ROUTE, model: 'claude-sonnet-4-6' }),
    })
    env.host.setAccountAuto('claude', { platform: true })
    const id = await send(env, 'claude-opus-4-7')
    await vi.waitFor(() => expect(env.sends).toHaveLength(2))
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    expect(env.host.open(id).record.platformFallback).toEqual({
      account: 'default',
      model: 'claude-opus-4-7',
      resetsAt,
    })
    expect(noticesOf(env, id)[0].fallback).toMatchObject({ engine: 'claude', window: 'five_hour', resetsAt })
    // 平台上再聊一轮：这时已过恢复时间，结束后读订阅额度，恢复了就换回去
    await new Promise(r => setTimeout(r, Math.max(0, resetsAt - Date.now()) + 20))
    await env.host.send(id, '接着改')
    await vi.waitFor(() => expect(env.host.open(id).record.platformFallback ?? null).toBeNull())
    const record = env.host.open(id).record
    expect(record.platform ?? null).toBeNull()
    expect(record.model).toBe('claude-opus-4-7')
    expect(noticesOf(env, id).map(n => n.fallback?.kind)).toEqual(['platform', 'back'])
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    // 下一条用订阅的新进程
    await env.host.send(id, '最后再改一下')
    await vi.waitFor(() => expect(env.sends).toHaveLength(4))
    expect(env.sends.map(s => [s.session, s.platform])).toEqual([
      [1, null],
      [2, '7'],
      [2, '7'],
      [3, null],
    ])
  })

  it('改用平台之后自己换了模型：不再自动换回', async () => {
    const env = setup({ limited: n => n === 1, platformRoute: async () => ROUTE })
    env.host.setAccountAuto('codex', { platform: true })
    const id = await send(env)
    await vi.waitFor(() => expect(env.sends).toHaveLength(2))
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    expect(env.host.open(id).record.platformFallback).toBeTruthy()
    await env.host.update(id, { model: 'gpt-5.4-mini' })
    expect(env.host.open(id).record.platformFallback ?? null).toBeNull()
  })

  it('设置文件里的开关：旧文件没有这一项当作关，打开后存下来', () => {
    expect(readAccountsFile({ codex: { accounts: [], auto: { enabled: true } } }).codex?.auto.platform).toBe(false)
    expect(readAccountsFile({ codex: { accounts: [], auto: { platform: true } } }).codex?.auto.platform).toBe(true)
  })
})

describe('换账号后的额度', () => {
  it('旧账号的会话进程还空闲着：读当前账号的额度不借它，改用临时进程；回到原账号又能借', async () => {
    const env = setup({ sessionQuota: () => 'me@example.com' })
    const list = await env.addAccount('work@example.com')
    const project = env.host.addProject(env.root)
    const id = env.host.createSession({ projectId: project.id, engine: 'codex' }).id
    await env.host.send(id, '第一条')
    await vi.waitFor(() => expect(env.host.open(id).state).toBe('idle'))
    await env.host.switchAccount('codex', list.accounts[1].id)
    // 换账号后宿主自己会清掉额度重读一次（docs/ui/claude-login-recovery.md §1 第 1 条），等它读完
    await vi.waitFor(() => expect(env.tempQuota()).toBeGreaterThanOrEqual(1))
    const q = await env.host.refreshAccountQuota('chatgpt', { force: true })
    expect(env.borrowed).toEqual([])
    expect(q.account).toBe('work@example.com')
    await env.host.switchAccount('codex', 'default')
    await env.host.refreshAccountQuota('chatgpt', { maxAgeMs: 0 })
    await vi.waitFor(() => expect(env.borrowed.length).toBeGreaterThanOrEqual(1))
    expect(new Set(env.borrowed)).toEqual(new Set([1]))
  })
})
