// 新会话标题去掉 Markdown 记号（docs/ui/conversation-ux-2.md §2.2）
import { describe, expect, it } from 'vitest'
import { normalizeSessionTitle } from '@pixelsky/protocol'
import { EngineHost } from '../src'
import { NEW_TITLE, oldTitleMatches, titleFrom } from '../src/host/title'
import { makeTmp, removeTmp } from './helpers/tmp'

describe('新会话标题', () => {
  it('去掉行首记号、行内代码、加粗、链接和图片', () => {
    expect(titleFrom('帮我看看 `src/app.ts` 里登录逻辑有什么问题')).toBe('帮我看看 src/app.ts 里登录逻辑有什么问题')
    expect(titleFrom('## **修复** `login()` 的 [空用户名](src/app.ts) 问题')).toBe('修复 login() 的 空用户名 问题')
    expect(titleFrom('> [!WARNING]\n> 先别动线上配置')).toBe('先别动线上配置')
    expect(titleFrom('- [ ] 补测试')).toBe('补测试')
    expect(titleFrom('1. 读取配置\n2. 校验')).toBe('读取配置')
    expect(titleFrom('看这张图 ![截图](a.png)')).toBe('看这张图 截图')
    expect(titleFrom('__重要__：发布前检查')).toBe('重要：发布前检查')
  })

  it('第一行是代码块开头时取代码块里的第一行', () => {
    expect(titleFrom('```ts\nconst a = 1\n```\n为什么报错')).toBe('const a = 1')
  })

  it('从编辑器引用的代码（路径#L 行和后面的代码块）跳过，用后面的问题；只有引用时用路径', () => {
    expect(titleFrom('src/A.java#L12-18\n```java\nint a = 1;\n```\n为什么空指针')).toBe('为什么空指针')
    expect(titleFrom('src/A.java#L3\n````md\n```\nx\n```\n````\n看看这段\nb.ts#L1\n```ts\ny\n```')).toBe('看看这段')
    expect(titleFrom('src/A.java#L12\n```java\nint a = 1;\n```')).toBe('src/A.java#L12')
  })

  it('不是记号的星号、井号保留；截到 30 个字；空的用默认标题', () => {
    expect(titleFrom('算一下 2*3*4')).toBe('算一下 2*3*4')
    expect(titleFrom('#123 这个 issue 怎么修')).toBe('#123 这个 issue 怎么修')
    expect(titleFrom('/review')).toBe('/review')
    expect(titleFrom('一'.repeat(200))).toBe('一'.repeat(200))
    expect(titleFrom('😀'.repeat(201))).toBe('😀'.repeat(199) + '…')
    expect(() => normalizeSessionTitle(titleFrom('a\tb ' + '😀'.repeat(300)))).not.toThrow()
    expect(titleFrom('   ')).toBe(NEW_TITLE)
  })
})

describe('链接和本机路径写短（docs/ui/session-title.md §1）', () => {
  it.each([
    ['https://github.com/GaLicn/ExtendedAE_Plus/issues/214 先定位原因', 'ExtendedAE_Plus#214 先定位原因'],
    ['https://github.com/a/b/pull/198/files#diff-1，审查一下', 'b#198，审查一下'],
    ['看 https://github.com/a/b/issues/7#issuecomment-99。', '看 b#7。'],
    ['基于https://github.com/S/Neoecoae/tree/1.21.1移植', '基于Neoecoae@1.21.1移植'],
    ['https://github.com/a/b.git', 'b'],
    ['https://github.com/a/b/commit/0123456789abcdef 为什么', 'b@0123456 为什么'],
    ['https://github.com/a/b/releases/ 看看', 'b/releases 看看'],
    ['https://github.com/a', 'github.com/a'],
    ['（https://www.example.com/docs/）照着做', '（example.com/docs）照着做'],
    ['<http://localhost:3000/a?b=1> 打不开', 'localhost:3000/a?b=1 打不开'],
    ['参考 @C:\\Users\\me\\Desktop\\1.21\\crash.txt 修复', '参考 @crash.txt 修复'],
    ['看 @"C:\\my docs\\a b.txt" 这份', '看 @a b.txt 这份'],
    ['D:/PixelSky/docs/ 里整理一下', 'docs 里整理一下'],
    ['打开 /home/me/app/main.py 报错', '打开 main.py 报错'],
    ['@~/notes/todo.md 做完', '@todo.md 做完'],
  ])('%s', (text, title) => {
    expect(titleFrom(text)).toBe(title)
  })

  it.each(['/api/v1/users 返回 500', '/review', 'src/app/main.ts 有问题', '比例 C:D 怎么算', 'https:// 是什么'])(
    '不动：%s',
    text => {
      expect(titleFrom(text)).toBe(text)
    },
  )
})

describe('旧会话标题补全（§2）', () => {
  const old = (t: string): string => t.slice(0, 30) + '…'
  const text = 'https://github.com/GaLicn/ExtendedAE_Plus/issues/214 先定位原因'

  it('旧规则的两种写法都认', () => {
    expect(oldTitleMatches(text, old(text))).toBe(true)
    const md = '## **修复** 登录页面在窄屏下按钮被挤出去看不见的问题，顺便看看标题有没有换行'
    expect(oldTitleMatches(md, old(md))).toBe(true)
    expect(oldTitleMatches(md, old('修复 登录页面在窄屏下按钮被挤出去看不见的问题，顺便看看标题有没有换行'))).toBe(true)
    expect(oldTitleMatches('别的话', old(text))).toBe(false)
  })

  it('对得上才改；改过名的、对不上的、短标题不动；不改更新时间；带大图片的那行也认得', async () => {
    const root = makeTmp('fix-titles')
    let host: EngineHost | undefined
    try {
      host = new EngineHost({ dataDir: root, adapters: {}, emit: () => {} })
      const projectId = host.addProject(root).id
      const store = (host as unknown as { ctx: { store: { appendItem(id: string, item: object): void } } }).ctx.store
      const patch = (id: string, p: object): void =>
        void (host as unknown as { m: { events: { patchRecord(id: string, p: object): void } } }).m.events.patchRecord(
          id,
          p,
        )
      const make = (title: string, said: string, extra: object = {}, image = ''): string => {
        const { id } = host!.createSession({ projectId, engine: 'claude' })
        store.appendItem(id, {
          kind: 'user',
          id: 'u-' + id,
          text: said,
          attachments: image ? [{ name: 'a.png', data: image }] : [],
          createdAt: 1,
          mode: 'normal',
        })
        patch(id, { title, updatedAt: 1000, ...extra })
        return id
      }
      const good = make(old(text), text)
      const big = make(old(text), text, {}, 'A'.repeat(400_000))
      const named = make(old(text), text, { titleEdited: true })
      const other = make(old(text), '别的话')
      const short = make('短标题', text)
      expect(await host.fixTitles()).toBe(2)
      const title = (id: string): string => host!.record(id)!.title
      expect(title(good)).toBe('ExtendedAE_Plus#214 先定位原因')
      expect(title(big)).toBe('ExtendedAE_Plus#214 先定位原因')
      expect(host.record(good)!.updatedAt).toBe(1000)
      expect([title(named), title(other), title(short)]).toEqual([old(text), old(text), '短标题'])
      expect(await host.fixTitles()).toBe(0)
    } finally {
      await host?.shutdown()
      removeTmp(root)
    }
  })
})
