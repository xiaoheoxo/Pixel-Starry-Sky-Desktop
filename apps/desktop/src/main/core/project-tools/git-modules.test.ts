// 按模块分组、加入 .gitignore 的纯函数（docs/ui/git-panel.md §10、§10.1）
import { describe, expect, it } from 'vitest'
import { ignoreEntries, ignorePattern, ignoreUpdate, moduleCandidates, moduleInfo } from './git-modules'

describe('模块', () => {
  it('每个文件夹一个，按清单优先级挑；跳过依赖、样例、构建输出里的；按路径排序', () => {
    const list = moduleCandidates([
      'package.json',
      'apps/app/pubspec.yaml',
      'apps/desktop/package.json',
      'apps/desktop/build.gradle',
      'packages/engine/test/fixtures/pkg/package.json',
      'web/node_modules/x/package.json',
      'android/build.gradle.kts',
      'android/settings.gradle.kts',
      'android/buildSrc/build.gradle.kts',
      'tool/README.md',
    ])
    expect(list).toEqual([
      { dir: '', manifest: 'package.json' },
      { dir: 'android', manifest: 'settings.gradle.kts' },
      { dir: 'apps/app', manifest: 'pubspec.yaml' },
      { dir: 'apps/desktop', manifest: 'package.json' },
    ])
  })

  it('名字取清单里的；读不出来用文件夹名，根用仓库文件夹名', () => {
    const info = (manifest: Parameters<typeof moduleInfo>[0]['manifest'], text: string | null, dir = 'a/b') =>
      moduleInfo({ dir, manifest }, text, 'Repo')
    expect(info('package.json', '{"name":"@x/desk"}')).toEqual({ dir: 'a/b', name: '@x/desk', kind: 'npm' })
    expect(info('package.json', 'not json')).toMatchObject({ name: 'b' })
    expect(info('package.json', null, '')).toMatchObject({ dir: '', name: 'Repo' })
    expect(info('pubspec.yaml', 'name: my_app # x\ndependencies:\n  flutter:\n    sdk: flutter\n')).toMatchObject({
      name: 'my_app',
      kind: 'Flutter',
    })
    expect(info('pubspec.yaml', 'name: tool\n')).toMatchObject({ name: 'tool', kind: 'Dart' })
    expect(info('Cargo.toml', '[workspace]\nmembers=[]\n\n[package]\nversion="1"\nname = "crate-a"\n')).toMatchObject({
      name: 'crate-a',
      kind: 'Cargo',
    })
    expect(info('Cargo.toml', '[workspace]\nname = "no"\n')).toMatchObject({ name: 'b' })
    expect(info('go.mod', 'module github.com/x/svc\n\ngo 1.22\n')).toMatchObject({ name: 'svc', kind: 'Go' })
    expect(
      info('pom.xml', '<project><parent><artifactId>root</artifactId></parent><artifactId>core</artifactId></project>'),
    ).toMatchObject({ name: 'core', kind: 'Maven' })
    expect(info('pyproject.toml', '[tool.poetry]\nname = "poet"\n')).toMatchObject({ name: 'poet', kind: 'Python' })
    expect(info('settings.gradle.kts', 'rootProject.name = "android-app"')).toMatchObject({
      name: 'android-app',
      kind: 'Gradle',
    })
    expect(info('build.gradle', 'plugins {}')).toMatchObject({ name: 'b', kind: 'Gradle' })
  })
})

describe('.gitignore', () => {
  it('路径检查：相对仓库根，不能有 .. / 绝对路径 / .git，最多 200 个', () => {
    expect(ignoreEntries({ entries: [{ path: 'apps\\app\\build\\', dir: true }] })).toEqual([
      { path: 'apps/app/build', dir: true },
    ])
    for (const path of ['', '/abs', 'C:/x', 'a/../b', 'a/./b', '.git/info', 'a//b', 'a\0b'])
      expect(() => ignoreEntries({ entries: [{ path, dir: false }] }), path).toThrow()
    expect(() => ignoreEntries({ entries: [] })).toThrow()
    expect(() => ignoreEntries({ entries: Array.from({ length: 201 }, () => ({ path: 'a' })) })).toThrow()
  })

  it('规则从仓库根锚定，文件夹以 / 结尾，通配符和结尾空格转义', () => {
    expect(ignorePattern({ path: 'apps/app/build', dir: true })).toBe('/apps/app/build/')
    expect(ignorePattern({ path: 'logs/a*b?[1].txt', dir: false })).toBe('/logs/a\\*b\\?\\[1\\].txt')
    expect(ignorePattern({ path: 'notes ', dir: false })).toBe('/notes\\ ')
  })

  it('追加：沿用原来的换行，原来末尾没换行先补，已有的和重复的不再加，都有了返回 null', () => {
    const build = { path: 'build', dir: true }
    expect(ignoreUpdate(null, [build])).toBe('/build/\n')
    expect(ignoreUpdate('node_modules\r\n/dist/', [build, build])).toBe('node_modules\r\n/dist/\r\n/build/\r\n')
    expect(ignoreUpdate('a\n', [{ path: 'x.log', dir: false }, build])).toBe('a\n/x.log\n/build/\n')
    expect(ignoreUpdate('/build/\n', [build])).toBeNull()
  })
})
