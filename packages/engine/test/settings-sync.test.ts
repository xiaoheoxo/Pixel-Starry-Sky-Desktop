import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ENGINES, type EngineInfo } from '@pixelsky/protocol'
import { EngineHost, type EngineAdapter } from '../src'
import { makeTmp, removeTmp } from './helpers/tmp'

// 设置云同步里引擎的三个键（docs/ui/settings-sync.md §3）：白名单之外的出不去，云端的值走设置页同样的校验

const roots: string[] = []
const hosts: EngineHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(h => h.shutdown()))
  roots.splice(0).forEach(removeTmp)
})

const adapter = (id: 'claude' | 'codex'): EngineAdapter => ({
  info: async () => ({ ...ENGINES[id], status: 'ready', version: '1.0.0', path: id, message: null }) as EngineInfo,
  createSession: () => {
    throw new Error('not used')
  },
})

function setup() {
  const root = makeTmp('settings-sync')
  roots.push(root)
  const host = new EngineHost({
    dataDir: join(root, 'data'),
    adapters: { claude: adapter('claude'), codex: adapter('codex') },
    emit() {},
  })
  hosts.push(host)
  return host
}

describe('引擎设置的云同步', () => {
  it('只交出白名单里的字段：没有命令路径、追加参数、环境变量', async () => {
    const host = setup()
    await host.setEngineConfig('claude', {
      env: { HTTPS_PROXY: 'http://secret-proxy', MY_TOKEN: 'sk-should-not-leak' },
      outputStyle: 'Explanatory',
      compactModel: 'claude-haiku-4-5',
      defaults: { effort: 'max' },
    })
    const text = JSON.stringify(host.syncableSettings())
    for (const leak of ['secret-proxy', 'sk-should-not-leak', 'HTTPS_PROXY', '"env"', '"paths"', '"args"'])
      expect(text).not.toContain(leak)
    expect(host.syncableSettings()).toMatchObject({
      'desktop.engine.defaults': {
        engine: 'claude',
        engines: { claude: { defaults: { effort: 'max' }, compactModel: 'claude-haiku-4-5' } },
      },
      'desktop.engine.options': {
        engines: { claude: { outputStyle: 'Explanatory', askQuestions: true, hidden: false } },
      },
      'desktop.engine.retries': null,
    })
  })

  it('写回云端的值：合法的生效，不合法的跳过、保留本机的', async () => {
    const a = setup()
    await a.setEngineConfig('codex', { defaults: { effort: 'low' }, autoCompactPct: 80 })
    a.setRetrySettings(2)
    const b = setup()
    const synced = a.syncableSettings()
    for (const [key, value] of Object.entries(synced)) await b.applySyncableSetting(key, value)
    expect(b.syncableSettings()).toEqual(synced)

    // 不合法：未知强度、默认引擎不能隐藏、乱七八糟的重试次数
    await b.applySyncableSetting('desktop.engine.defaults', {
      engine: 'claude',
      engines: { claude: { defaults: { effort: 'turbo' } } },
    })
    await b.applySyncableSetting('desktop.engine.options', { engines: { claude: { hidden: true } } })
    await b.applySyncableSetting('desktop.engine.retries', 'lots')
    expect(b.syncableSettings()['desktop.engine.defaults'].engines.claude?.defaults.effort).toBe(
      synced['desktop.engine.defaults'].engines.claude?.defaults.effort,
    )
    expect(b.syncableSettings()['desktop.engine.options'].engines.claude?.hidden).toBe(false)
    expect(b.syncableSettings()['desktop.engine.retries']).toBe(2)
    // 云端删了默认值的键：回到默认
    await b.applySyncableSetting('desktop.engine.defaults', null)
    expect(b.syncableSettings()['desktop.engine.defaults'].engines.codex?.defaults.effort).toBe('high')
  })

  it('一个引擎的选项里有一项不合法：只跳过那一项，其他选项照样写回', async () => {
    const host = setup()
    // 本机默认引擎是 claude，云端要把它隐藏：hidden 跳过，输出风格和自动压缩照样生效
    await host.applySyncableSetting('desktop.engine.options', {
      engines: { claude: { hidden: true, outputStyle: 'Explanatory', autoCompactPct: 80, rememberChoices: true } },
    })
    expect(host.syncableSettings()['desktop.engine.options'].engines.claude).toMatchObject({
      hidden: false,
      outputStyle: 'Explanatory',
      autoCompactPct: 80,
      rememberChoices: true,
    })
  })
})
