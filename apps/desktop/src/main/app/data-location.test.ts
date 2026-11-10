import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MOVING_MARK,
  checkTarget,
  defaultDataRoot,
  hasDataAt,
  measure,
  moveData,
  readPointer,
  removeData,
  writePointer,
} from './data-location'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'data-location-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const write = (path: string, text = 'x'): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** 一份旧数据：两个会话（一个聊天、一个项目里的）、频道、设置（不该搬）、图标缓存（不该搬） */
function seed(from: string): void {
  const chat = join(from, 'engine', 'chats', 's1')
  write(join(from, 'engine', 'sessions', 's1', 'record.json'), JSON.stringify({ id: 's1', cwd: chat }))
  write(join(from, 'engine', 'sessions', 's1', 'checkpoints.json'), JSON.stringify({ version: 1, cwd: chat }))
  write(join(from, 'engine', 'sessions', 's1', 'items.jsonl'), '{"a":1}\n')
  write(join(from, 'engine', 'sessions', 's2', 'record.json'), JSON.stringify({ id: 's2', cwd: 'D:\\proj' }))
  write(join(chat, 'note.txt'), 'hello')
  write(join(from, 'engine', 'projects.json'), '{"projects":[]}')
  write(join(from, 'channels', 'c1', 'channel.json'), '{}')
  write(join(from, 'extension-packs', 'state.json'), '{}')
  write(join(from, 'extension-packs', 'cache', 'icons', 'a.png'), 'png')
  write(join(from, 'account.json'), 'secret')
}

describe('指针文件', () => {
  it('写了能读回；坏文件、相对路径当没有', async () => {
    const file = join(root, 'data-location.json')
    expect(readPointer(file)).toBeNull()
    await writePointer(file, { version: 1, path: join(root, 'd'), move: { to: join(root, 'e') } })
    expect(readPointer(file)).toEqual({ version: 1, path: join(root, 'd'), move: { to: join(root, 'e') } })
    writeFileSync(file, '{oops')
    expect(readPointer(file)).toBeNull()
    writeFileSync(file, JSON.stringify({ version: 1, path: 'relative' }))
    expect(readPointer(file)).toBeNull()
  })
})

describe('defaultDataRoot', () => {
  const base = { userData: 'C:\\Users\\a\\AppData\\Roaming\\x', packaged: true, hasData: false, systemDrive: 'C:' }
  it.runIf(process.platform === 'win32')(
    '新装在别的盘：安装目录旁边；系统盘、老用户、开发版：userData；便携版：exe 旁边',
    () => {
      expect(defaultDataRoot({ ...base, installDir: 'D:\\Apps\\像素星空' })).toBe('D:\\Apps\\像素星空-数据')
      expect(defaultDataRoot({ ...base, installDir: 'C:\\Users\\a\\AppData\\Local\\Programs\\像素星空' })).toBe(
        base.userData,
      )
      expect(defaultDataRoot({ ...base, installDir: 'D:\\Apps\\像素星空', hasData: true })).toBe(base.userData)
      expect(defaultDataRoot({ ...base, installDir: 'D:\\Apps\\像素星空', packaged: false })).toBe(base.userData)
      expect(defaultDataRoot({ ...base, installDir: 'D:\\tmp\\x', portableDir: 'E:\\Tools' })).toBe(
        'E:\\Tools\\像素星空-数据',
      )
    },
  )
})

describe('checkTarget', () => {
  it('同一个、在当前位置里、包含当前位置、在安装目录里、已有数据都拦下；空文件夹通过', async () => {
    const current = join(root, 'cur')
    const install = join(root, 'app')
    mkdirSync(current)
    const opts = { current, installDir: install, need: 0 }
    expect(await checkTarget('rel', opts)).toBe('notAbsolute')
    expect(await checkTarget(current, opts)).toBe('same')
    expect(await checkTarget(join(current, 'sub'), opts)).toBe('insideCurrent')
    expect(await checkTarget(root, opts)).toBe('containsCurrent')
    expect(await checkTarget(join(install, 'data'), opts)).toBe('insideInstall')
    write(join(root, 'used', 'channels', 'x.json'))
    expect(await checkTarget(join(root, 'used'), opts)).toBe('hasData')
    expect(await checkTarget(join(root, 'fresh'), opts)).toBeNull()
    expect(await checkTarget(join(root, 'fresh2'), { ...opts, need: Number.MAX_SAFE_INTEGER })).toBe('noSpace')
  })
})

describe('moveData', () => {
  it('复制数据条目、跳过缓存和设置，核对一致；聊天的 cwd 改成新位置，项目会话不动；不删旧的', async () => {
    const from = join(root, 'from')
    const to = join(root, 'to')
    seed(from)
    const progress: number[] = []
    const result = await moveData(from, to, done => progress.push(done))
    expect(result).toEqual(await measure(from))
    expect(progress.at(-1)).toBe(result.bytes)

    expect(existsSync(join(to, 'engine', 'chats', 's1', 'note.txt'))).toBe(true)
    expect(existsSync(join(to, 'channels', 'c1', 'channel.json'))).toBe(true)
    expect(existsSync(join(to, 'extension-packs', 'state.json'))).toBe(true)
    expect(existsSync(join(to, 'extension-packs', 'cache'))).toBe(false)
    expect(existsSync(join(to, 'account.json'))).toBe(false)

    const newChat = join(to, 'engine', 'chats', 's1')
    const rec = (id: string, name = 'record.json'): { cwd: string } =>
      JSON.parse(readFileSync(join(to, 'engine', 'sessions', id, name), 'utf8'))
    expect(rec('s1').cwd).toBe(newChat)
    expect(rec('s1', 'checkpoints.json').cwd).toBe(newChat)
    expect(rec('s2').cwd).toBe('D:\\proj')
    // 旧位置原样
    expect(JSON.parse(readFileSync(join(from, 'engine', 'sessions', 's1', 'record.json'), 'utf8')).cwd).toBe(
      join(from, 'engine', 'chats', 's1'),
    )
  })

  it('目标里已经有同名条目：报错，不留下这次建的东西，原有的文件不动', async () => {
    const from = join(root, 'from')
    const to = join(root, 'to')
    seed(from)
    write(join(to, 'channels', 'old.json'), 'keep')
    await expect(moveData(from, to)).rejects.toThrow()
    expect(existsSync(join(to, 'engine'))).toBe(false)
    expect(readFileSync(join(to, 'channels', 'old.json'), 'utf8')).toBe('keep')
  })

  it('聊天换了工作目录：Claude 的记录文件夹复制到新名字下（默认目录和订阅账号目录），旧的不删', async () => {
    const from = join(root, 'from')
    const to = join(root, 'to')
    seed(from)
    const claude = join(root, 'claude-home')
    const enc = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-')
    const oldCwd = join(from, 'engine', 'chats', 's1')
    const newCwd = join(to, 'engine', 'chats', 's1')
    write(join(claude, 'projects', enc(oldCwd), 'abc.jsonl'), 'log')
    write(join(from, 'engine', 'accounts', 'claude', 'acc1', 'projects', enc(oldCwd), 'x.jsonl'), 'acc')
    await moveData(from, to, undefined, { CLAUDE_CONFIG_DIR: claude })
    expect(readFileSync(join(claude, 'projects', enc(newCwd), 'abc.jsonl'), 'utf8')).toBe('log')
    expect(existsSync(join(claude, 'projects', enc(oldCwd), 'abc.jsonl'))).toBe(true)
    expect(existsSync(join(to, 'engine', 'accounts', 'claude', 'acc1', 'projects', enc(newCwd), 'x.jsonl'))).toBe(true)
  })
})

describe('moveData：旧位置不在、上次没搬完', () => {
  it('原来的位置不在（盘没插）：报错，不会切到一份空数据', async () => {
    await expect(moveData(join(root, 'gone'), join(root, 'to'))).rejects.toThrow('找不到原来的数据位置')
    expect(existsSync(join(root, 'to', 'engine'))).toBe(false)
  })

  it('上次复制到一半被打断（标记还在）：清掉半份重来，能搬成；检查时不算已有数据', async () => {
    const from = join(root, 'from')
    const to = join(root, 'to')
    seed(from)
    write(join(to, 'engine', 'half.txt'), 'partial')
    write(join(to, MOVING_MARK), from)
    expect(hasDataAt(to)).toBe(false)
    expect(await checkTarget(to, { current: from, installDir: join(root, 'app'), need: 0 })).toBeNull()
    await moveData(from, to)
    expect(existsSync(join(to, 'engine', 'half.txt'))).toBe(false)
    expect(existsSync(join(to, 'engine', 'projects.json'))).toBe(true)
  })

  it('搬成之前标记一直在；失败时标记和这次建的条目一起清掉', async () => {
    const from = join(root, 'from')
    const to = join(root, 'to')
    seed(from)
    await moveData(from, to)
    expect(existsSync(join(to, MOVING_MARK))).toBe(true)
    const to2 = join(root, 'to2')
    write(join(to2, 'channels', 'old.json'), 'keep')
    await expect(moveData(from, to2)).rejects.toThrow()
    expect(existsSync(join(to2, MOVING_MARK))).toBe(false)
  })
})

describe('第二轮复审的修复', () => {
  it('hasDataAt 只认像素星空自己的文件：随便一个 engine 文件夹不算', () => {
    write(join(root, 'a', 'engine', 'random.txt'))
    expect(hasDataAt(join(root, 'a'))).toBe(false)
    write(join(root, 'b', 'engine', 'projects.json'), '{}')
    expect(hasDataAt(join(root, 'b'))).toBe(true)
  })

  it('搬回以前用过的位置：Claude 记录用这次的，上次的旧记录改名留着', async () => {
    const from = join(root, 'from')
    const to = join(root, 'to')
    seed(from)
    const claude = join(root, 'claude-home')
    const enc = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-')
    const newCwd = join(to, 'engine', 'chats', 's1')
    write(join(claude, 'projects', enc(join(from, 'engine', 'chats', 's1')), 'a.jsonl'), 'fresh')
    write(join(claude, 'projects', enc(newCwd), 'a.jsonl'), 'stale')
    await moveData(from, to, undefined, { CLAUDE_CONFIG_DIR: claude })
    expect(readFileSync(join(claude, 'projects', enc(newCwd), 'a.jsonl'), 'utf8')).toBe('fresh')
    const names = readdirSync(join(claude, 'projects'))
    expect(names.some(n => n.startsWith(enc(newCwd) + '.old-'))).toBe(true)
    expect(names.some(n => n.endsWith('.copying'))).toBe(false)
  })
})

describe('removeData', () => {
  it('只删数据条目，设置和凭证留着', async () => {
    seed(root)
    const trashed: string[] = []
    await removeData(root, async p => {
      trashed.push(p)
      rmSync(p, { recursive: true, force: true })
    })
    expect(trashed.length).toBe(3)
    expect(existsSync(join(root, 'engine'))).toBe(false)
    expect(existsSync(join(root, 'account.json'))).toBe(true)
  })
})
