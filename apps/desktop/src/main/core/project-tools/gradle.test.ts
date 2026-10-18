import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeConsoleText as decodeOutput } from '@pixelsky/engine'
import { checkBuildDir, gradleLaunch } from './gradle-run'
import {
  detectPlugins,
  inferTasks,
  mainPlugin,
  parseCustomTasks,
  parseGradleProperties,
  parseGradleTaskList,
  parseGradleVersion,
  parseJavaVersion,
  parseRuns,
  parseSettings,
} from './gradle'
import { readRunTasks } from './run-tasks'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gradle-tasks-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(rel: string, text: string) {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), text)
}
const names = (tasks: { name: string }[]) => tasks.map(t => t.name)
const plugins = (text: string) => detectPlugins(text).keys

describe('parseSettings', () => {
  it('reads groovy includes, multi-line lists and rootProject.name', () => {
    const s = parseSettings(`rootProject.name = 'ruby-mod'
// include ':ignored'
include ':fabric', ':libs:core',
        'forge'
include 'neoforge'
includeBuild 'build-logic'
`)
    expect(s.rootName).toBe('ruby-mod')
    expect(s.includes).toEqual([':fabric', ':libs:core', ':forge', ':neoforge'])
  })

  it('reads kotlin dsl includes and projectDir overrides', () => {
    const s = parseSettings(`rootProject.name = "demo"
include(":app", "lib")
include(
  ":a:b",
  ":c"
)
project(":lib").projectDir = file("modules/lib")
project(":c").projectDir = file("../outside")
`)
    expect(s.includes).toEqual([':app', ':lib', ':a:b', ':c'])
    expect(s.dirs).toEqual({ ':lib': 'modules/lib' })
  })
})

describe('plugins and inferred tasks', () => {
  it('detects java / application / spring boot', () => {
    expect(plugins(`plugins { id 'java'\n id 'application' }`)).toEqual(new Set(['java', 'application']))
    expect(plugins(`plugins { java; \`java-library\`\n id("org.springframework.boot") version "3.3.0" }`)).toEqual(
      new Set(['java', 'java-library', 'spring-boot']),
    )
    expect(plugins(`apply plugin: 'java'`)).toEqual(new Set(['java']))
    expect(plugins(`plugins { kotlin("jvm") version "2.0.0" }`)).toEqual(new Set(['kotlin-jvm']))
    const tasks = inferTasks(detectPlugins(`plugins { id 'org.springframework.boot' }`), false, [])
    expect(names(tasks)).toEqual(
      expect.arrayContaining(['build', 'jar', 'test', 'javadoc', 'bootRun', 'bootJar', 'dependencies']),
    )
    expect(names(tasks)).not.toContain('projects')
    expect(tasks.find(t => t.name === 'bootRun')?.category).toBe('application')
  })

  it('detects android through version catalog aliases', () => {
    const text = `plugins {\n  alias(libs.plugins.android.application)\n  alias(libs.plugins.kotlin.android)\n}`
    const found = detectPlugins(text)
    expect(found.keys).toEqual(new Set(['android-app', 'kotlin']))
    expect(mainPlugin(found.keys)).toBe('Android')
    const tasks = inferTasks(found, false, [])
    expect(names(tasks)).toEqual(expect.arrayContaining(['assembleDebug', 'installDebug', 'connectedAndroidTest']))
    expect(names(tasks)).not.toContain('jar')
    const lib = inferTasks(detectPlugins(`plugins { id("com.android.library") }`), false, [])
    expect(names(lib)).not.toContain('bundleRelease')
  })

  it('infers fabric loom tasks from runs, with kotlin dsl create()', () => {
    const text = `plugins { id 'fabric-loom' version '1.7-SNAPSHOT' }
loom {
    runs {
        client {
            client()
        }
        create("datagen") {
            inherit(runs["client"])
        }
        register("gametest") { }
    }
}
`
    const found = detectPlugins(text)
    expect(mainPlugin(found.keys)).toBe('Fabric Loom')
    const runs = parseRuns(text)
    expect(runs).toEqual([
      { name: 'client', line: 4 },
      { name: 'datagen', line: 7 },
      { name: 'gametest', line: 10 },
    ])
    const tasks = inferTasks(found, false, runs)
    const fabric = tasks.filter(t => t.category === 'fabric')
    expect(fabric.map(t => [t.name, t.line])).toEqual([
      ['runClient', 4],
      ['runDatagen', 7],
      ['runGametest', 10],
      ['genSources', null],
    ])
  })

  it('falls back to runClient / runServer for loom without runs', () => {
    const tasks = inferTasks(detectPlugins(`plugins { id("dev.architectury.loom") }`), true, [])
    expect(tasks.filter(t => t.category === 'fabric').map(t => t.name)).toEqual([
      'runClient',
      'runServer',
      'genSources',
    ])
    expect(mainPlugin(plugins(`plugins { id("dev.architectury.loom") }`))).toBe('Architectury Loom')
  })

  it('infers ModDevGradle and ForgeGradle runs', () => {
    const mdg = `plugins { id 'net.neoforged.moddev' version '2.0.1' }
neoForge {
    runs {
        client { client() }
        server { server() }
    }
}`
    const found = detectPlugins(mdg)
    expect(mainPlugin(found.keys)).toBe('ModDevGradle')
    const tasks = inferTasks(found, false, parseRuns(mdg))
    expect(tasks.filter(t => t.category === 'neoforge').map(t => t.name)).toEqual(['runClient', 'runServer'])

    const fg = `plugins { id 'net.minecraftforge.gradle' version '[6.0,6.2)' }
minecraft { runs { client { workingDirectory project.file('run') } } }`
    expect(mainPlugin(plugins(fg))).toBe('ForgeGradle')
    const forge = inferTasks(detectPlugins(fg), false, parseRuns(fg))
    expect(forge.filter(t => t.category === 'forgegradle runs').map(t => t.name)).toEqual([
      'runClient',
      'genIntellijRuns',
    ])
  })

  it('reads custom tasks with group, description and lines', () => {
    const text = `plugins { id 'java' }
// tasks.register('commented')
tasks.register('docs', Copy) {
    group = 'documentation'
    description = "Copies docs"
}
tasks.register<Zip>("pack") { group "dist" }
task hello {
    description 'say hi'
}
task old(type: Delete) { }
tasks.create('plain')
task('legacy')
val kts by tasks.registering { }
`
    const tasks = parseCustomTasks(text)
    expect(tasks.map(t => [t.name, t.category, t.detail, t.line])).toEqual([
      ['docs', 'documentation', 'Copies docs', 3],
      ['pack', 'dist', '', 7],
      ['hello', 'other', 'say hi', 8],
      ['old', 'other', '', 11],
      ['plain', 'other', '', 12],
      ['legacy', 'other', '', 13],
      ['kts', 'other', '', 14],
    ])
    expect(tasks.map(t => t.name)).not.toContain('commented')
  })
})

describe('versions and properties', () => {
  it('reads the gradle version from the wrapper', () => {
    expect(
      parseGradleVersion('distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10-bin.zip\n'),
    ).toBe('8.10')
    expect(parseGradleVersion('distributionUrl=https\\://x/gradle-8.5-all.zip')).toBe('8.5')
    expect(parseGradleVersion(null)).toBeNull()
  })

  it('reads the java version from the usual spellings', () => {
    expect(parseJavaVersion('java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }')).toBe('21')
    expect(parseJavaVersion('kotlin { jvmToolchain(17) }')).toBe('17')
    expect(parseJavaVersion('sourceCompatibility = JavaVersion.VERSION_1_8')).toBe('8')
    expect(parseJavaVersion('java.sourceCompatibility = JavaVersion.VERSION_21')).toBe('21')
    expect(parseJavaVersion(`sourceCompatibility = '11'`)).toBe('11')
    expect(parseJavaVersion('it.options.release = 21')).toBe('21')
    expect(parseJavaVersion('options.release.set(17)')).toBe('17')
    expect(parseJavaVersion('// jvmToolchain(8)\nplugins {}')).toBeNull()
  })

  it('parses gradle.properties and masks secrets', () => {
    const props = parseGradleProperties(`# comment
! also comment

org.gradle.jvmargs=-Xmx2G
mod_id: ruby
version 1.2.3
signing.password=hunter2
apiToken = abc
`)
    expect(props).toEqual([
      { key: 'org.gradle.jvmargs', value: '-Xmx2G', line: 4, secret: false },
      { key: 'mod_id', value: 'ruby', line: 5, secret: false },
      { key: 'version', value: '1.2.3', line: 6, secret: false },
      { key: 'signing.password', value: '', line: 7, secret: true },
      { key: 'apiToken', value: '', line: 8, secret: true },
    ])
  })
})

describe('readRunTasks with gradle', () => {
  const settings = `rootProject.name = 'ruby-mod'\ninclude ':fabric', ':common', ':empty'\n`
  const fabricBuild = `plugins { id 'fabric-loom' }\nloom { runs { client { client() } } }\n`

  async function multiProject() {
    await put('package.json', JSON.stringify({ name: 'x', scripts: { dev: 'vite' } }))
    await put('settings.gradle', settings)
    await put(
      'build.gradle',
      `plugins { id 'java' }\njava { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\n`,
    )
    await put('fabric/build.gradle', fabricBuild)
    await put('common/build.gradle.kts', `plugins { java }\ntasks.register("gen") { group = "codegen" }\n`)
    await put('gradle.properties', 'mod_id=ruby\nsecret_key=zzz\n')
    await put('gradle/wrapper/gradle-wrapper.properties', 'distributionUrl=https\\://x/gradle-8.10-bin.zip\n')
    await put('gradlew.bat', '@echo off\n')
  }

  it('reads a multi-project build: root first, subprojects by path, after npm', async () => {
    await multiProject()
    const state = await readRunTasks(root)
    expect(state.groups.map(g => [g.kind, g.file, g.dir, g.gradle?.project])).toEqual([
      ['npm', 'package.json', '', undefined],
      ['gradle', 'build.gradle', '', ':'],
      ['gradle', 'common/build.gradle.kts', 'common', ':common'],
      ['gradle', 'fabric/build.gradle', 'fabric', ':fabric'],
    ])
    const [, rootGroup, common, fabric] = state.groups
    expect(rootGroup.gradle).toMatchObject({
      buildDir: '',
      name: 'ruby-mod',
      wrapper: true,
      plugin: 'java',
      gradleVersion: '8.10',
      javaVersion: '21',
      properties: [
        { key: 'mod_id', value: 'ruby', line: 1, secret: false },
        { key: 'secret_key', value: '', line: 2, secret: true },
      ],
    })
    expect(rootGroup.gradle?.stamp).toMatch(/^[0-9a-f]{12}$/)
    expect(common.gradle).toMatchObject({ name: ':common', plugin: 'java', stamp: rootGroup.gradle?.stamp })
    expect(common.gradle?.javaVersion).toBeUndefined()
    expect(common.tasks.find(t => t.name === 'gen')).toEqual({ name: 'gen', detail: '', line: 2, category: 'codegen' })
    expect(fabric.gradle?.plugin).toBe('Fabric Loom')
    expect(fabric.tasks.find(t => t.name === 'runClient')).toMatchObject({ category: 'fabric', line: 2 })
    expect(rootGroup.tasks.map(t => t.name)).toContain('projects')
  })

  it('changes the stamp when any read file changes', async () => {
    await multiProject()
    const before = (await readRunTasks(root)).groups.find(g => g.kind === 'gradle')!.gradle!.stamp
    const same = (await readRunTasks(root)).groups.find(g => g.kind === 'gradle')!.gradle!.stamp
    expect(same).toBe(before)
    await put('fabric/build.gradle', fabricBuild + 'dependencies {}\n')
    const after = (await readRunTasks(root)).groups.find(g => g.kind === 'gradle')!.gradle!.stamp
    expect(after).not.toBe(before)
    await put('gradle.properties', 'mod_id=other\n')
    const props = (await readRunTasks(root)).groups.find(g => g.kind === 'gradle')!.gradle!.stamp
    expect(props).not.toBe(after)
  })

  it('honours projectDir overrides and skips subprojects without a build file', async () => {
    await put('settings.gradle.kts', `include(":lib", ":ghost")\nproject(":lib").projectDir = file("modules/lib")\n`)
    await put('modules/lib/build.gradle.kts', `plugins { java }\n`)
    const state = await readRunTasks(root)
    const lib = state.groups.find(g => g.gradle?.project === ':lib')
    expect(lib).toMatchObject({ file: 'modules/lib/build.gradle.kts', dir: 'modules/lib' })
    expect(state.groups.map(g => g.gradle?.project)).toEqual([':', ':lib'])
    // 根项目没有 build 文件时 file 是 settings 文件，名字是文件夹名
    expect(state.groups[0]).toMatchObject({ file: 'settings.gradle.kts', dir: '' })
    expect(state.groups[0].gradle?.name).toMatch(/gradle-tasks-/)
  })

  it('treats a nested build as its own build and ignores build files inside a build', async () => {
    await put('package.json', JSON.stringify({ scripts: { dev: 'vite' } }))
    await put('android/settings.gradle.kts', `rootProject.name = "app"\ninclude(":app")\n`)
    await put('android/build.gradle.kts', `plugins { id("com.android.application") apply false }\n`)
    await put('android/app/build.gradle.kts', `plugins { id("com.android.application") }\n`)
    await put('tools/build.gradle', `apply plugin: 'application'\n`)
    const state = await readRunTasks(root)
    expect(state.groups.map(g => [g.kind, g.file, g.gradle?.buildDir])).toEqual([
      ['npm', 'package.json', undefined],
      ['gradle', 'android/build.gradle.kts', 'android'],
      ['gradle', 'android/app/build.gradle.kts', 'android'],
      ['gradle', 'tools/build.gradle', 'tools'],
    ])
    expect(state.groups[2].gradle?.project).toBe(':app')
    expect(state.groups[2].tasks.map(t => t.name)).toContain('assembleDebug')
    expect(state.groups[1].gradle?.name).toBe('app')
    expect(state.groups[3].gradle?.name).toBe('tools')
  })

  it('counts each build as one file for the limit', async () => {
    await put('settings.gradle', `include ':a', ':b', ':c'\n`)
    for (const p of ['a', 'b', 'c']) await put(`${p}/build.gradle`, `plugins { id 'java' }\n`)
    for (let i = 0; i < 29; i++)
      await put(`pkg${String(i).padStart(2, '0')}/package.json`, JSON.stringify({ scripts: { x: 'y' } }))
    const state = await readRunTasks(root)
    // 30 个文件：1 个构建 + 29 个 package.json，不会因为构建里的 3 个 build 文件被截断
    expect(state.truncated).toBe(false)
    expect(state.groups.filter(g => g.kind === 'gradle')).toHaveLength(4)
  })
})

describe('parseGradleTaskList', () => {
  const output = `> Task :tasks

------------------------------------------------------------
Tasks runnable from root project 'ruby-mod'
------------------------------------------------------------

Build tasks
-----------
assemble - Assembles the outputs of this project.
build - Assembles and tests this project.
fabric:build - Assembles and tests this project.

Build Setup tasks
-----------------
init - Initializes a new Gradle build.

Fabric tasks
------------
fabric:runClient - Starts a development version of the Minecraft client.
libs:core:build - Assembles and tests this project.

Other tasks
-----------
components - Displays the components produced by root project 'ruby-mod'. [deprecated]
prepareKotlinBuildScriptModel

Rules
-----
Pattern: clean<TaskName>: Cleans the output files of a task.

BUILD SUCCESSFUL in 3s
`

  it('reads groups, projects, descriptions and bare names', () => {
    const tasks = parseGradleTaskList(output)
    expect(tasks.map(t => [t.project, t.name, t.category])).toEqual([
      [':', 'assemble', 'build'],
      [':', 'build', 'build'],
      [':fabric', 'build', 'build'],
      [':', 'init', 'build setup'],
      [':fabric', 'runClient', 'fabric'],
      [':libs:core', 'build', 'fabric'],
      [':', 'components', 'other'],
      [':', 'prepareKotlinBuildScriptModel', 'other'],
    ])
    expect(tasks[0].description).toBe('Assembles the outputs of this project.')
    expect(tasks[6].description).toContain('[deprecated]')
    expect(tasks[7].description).toBe('')
  })

  it('handles CRLF and empty output', () => {
    expect(parseGradleTaskList(output.replace(/\n/g, '\r\n'))).toHaveLength(8)
    expect(parseGradleTaskList('')).toEqual([])
  })
})

describe('gradle run helpers', () => {
  it('builds the launch command per platform', () => {
    expect(gradleLaunch('win32', 'exec')).toEqual({
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', '".\\gradlew.bat tasks --all --console=plain"'],
      windowsVerbatimArguments: true,
    })
    expect(gradleLaunch('win32', 'none').args[3]).toBe('"gradle tasks --all --console=plain"')
    expect(gradleLaunch('linux', 'exec')).toEqual({ command: './gradlew', args: ['tasks', '--all', '--console=plain'] })
    expect(gradleLaunch('linux', 'script').command).toBe('sh')
    expect(gradleLaunch('darwin', 'none').command).toBe('gradle')
  })

  it('decodes UTF-8 output, falling back to GB18030 (Chinese Windows code page)', () => {
    expect(decodeOutput(Buffer.from('打包资源包 - ok', 'utf8'))).toBe('打包资源包 - ok')
    // 「打包」的 GBK 编码；固定代码页，不依赖本机
    expect(decodeOutput(Uint8Array.from([0xb4, 0xf2, 0xb0, 0xfc]), { windows: true, codePage: 936 })).toBe('打包')
  })

  it('accepts only relative posix build dirs', () => {
    expect(checkBuildDir('')).toEqual([])
    expect(checkBuildDir('android/app')).toEqual(['android', 'app'])
    for (const bad of ['..', 'a/../b', '/abs', 'C:/x', 'a\\b', '../x'])
      expect(() => checkBuildDir(bad)).toThrow('构建目录不正确')
  })
})
