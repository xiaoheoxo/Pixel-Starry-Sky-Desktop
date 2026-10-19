/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { allMessages } from '../../../shared/i18n/translate'
import { catalog } from '../../../shared/i18n/catalog'
import { systemMessages } from '../../../shared/i18n/systemMessages'
import { pluginMessages } from '../../../shared/i18n/pluginMessages'
import { sessionMessages } from '../../../shared/i18n/sessionMessages'
import { commandMessages } from '../../../shared/i18n/commandMessages'
import { codexMessages } from '../../../shared/i18n/codexMessages'
import { pixelMessages } from '../../../shared/i18n/pixelMessages'
import { projectToolsMessages } from '../../../shared/i18n/projectToolsMessages'
import { terminalMessages } from '../../../shared/i18n/terminalMessages'
import { sidebarMessages } from '../../../shared/i18n/sidebarMessages'
import { projectMessages } from '../../../shared/i18n/projectMessages'
import { workspaceMessages } from '../../../shared/i18n/workspaceMessages'
import { machineMessages, machineErrors } from '../../../shared/i18n/machineMessages'
import { wslMessages } from '../../../shared/i18n/wslMessages'
import { channelMessages } from '../../../shared/i18n/channelMessages'
import { teamMessages } from '../../../shared/i18n/teamMessages'
import { notificationMessages } from '../../../shared/i18n/notificationMessages'
import { gitMessages } from '../../../shared/i18n/gitMessages'
import { artifactMessages } from '../../../shared/i18n/artifactMessages'
import { errorMessages } from '../../../shared/i18n/errorMessages'
import { contentMessages } from '../../../shared/i18n/contentMessages'
import { branchMessages } from '../../../shared/i18n/branchMessages'
import { updateMessages } from '../../../shared/i18n/updateMessages'
import { customApiMessages } from '../../../shared/i18n/customApiMessages'
import { logMessages } from '../../../shared/i18n/logMessages'
import { feedbackMessages } from '../../../shared/i18n/feedbackMessages'
import { trayMessages } from '../../../shared/i18n/trayMessages'
import { mobileMessages } from '../../../shared/i18n/mobileMessages'
import { editorMessages } from '../../../shared/i18n/editorMessages'
import { codingDictionaries } from '../../../shared/i18n/codingMessages'
import { attachmentMessages } from '../../../shared/i18n/attachmentMessages'
import { boardMessages } from '../../../shared/i18n/boardMessages'
import { aiMessages } from '../../../shared/i18n/aiMessages'
import { contextMessages } from '../../../shared/i18n/contextMessages'
import { costMessages } from '../../../shared/i18n/costMessages'
import { longConversationMessages } from '../../../shared/i18n/longConversationMessages'
import { tabMenuMessages } from '../../../shared/i18n/tabMenuMessages'
import { minimalModeMessages } from '../../../shared/i18n/minimalModeMessages'
import { imageViewerMessages } from '../../../shared/i18n/imageViewerMessages'
import { modelChannelMessages } from '../../../shared/i18n/modelChannelMessages'
import { fullAccessMessages } from '../../../shared/i18n/fullAccessMessages'
import { htmlPreviewMessages } from '../../../shared/i18n/htmlPreviewMessages'
import { recoveryMessages } from '../../../shared/i18n/recoveryMessages'
import { pathClickMessages } from '../../../shared/i18n/pathClickMessages'
import { contextMenuMessages } from '../../../shared/i18n/contextMenuMessages'
import { subagentMessages } from '../../../shared/i18n/subagentMessages'
import { subagentStopMessages } from '../../../shared/i18n/subagentStopMessages'
import { subagentRouteMessages } from '../../../shared/i18n/subagentRouteMessages'
import { connectorsMessages } from '../../../shared/i18n/connectorsMessages'
import { progressLineMessages } from '../../../shared/i18n/progressLineMessages'
import { traceHistoryMessages } from '../../../shared/i18n/traceHistoryMessages'
import { extensionCenterMessages } from '../../../shared/i18n/extensionCenterMessages'
import { extstoreInstalledMessages } from '../../../shared/i18n/extstoreInstalledMessages'
import { extstorePublishMessages } from '../../../shared/i18n/extstorePublishMessages'
import { fileIconMessages } from '../../../shared/i18n/fileIconMessages'
import { extGrammarMessages } from '../../../shared/i18n/extGrammarMessages'
import { editorThemeMessages } from '../../../shared/i18n/editorThemeMessages'
import { extSnippetMessages } from '../../../shared/i18n/extSnippetMessages'
import { extTaskMessages } from '../../../shared/i18n/extTaskMessages'
import { promptMessages } from '../../../shared/i18n/promptMessages'
import { resumeMessages } from '../../../shared/i18n/resumeMessages'
import { onboardingMessages } from '../../../shared/i18n/onboardingMessages'
import { systemProxyMessages } from '../../../shared/i18n/systemProxyMessages'
import { approvalMessages } from '../../../shared/i18n/approvalMessages'
import { extstoreDetailMessages } from '../../../shared/i18n/extstoreDetailMessages'

// 与 shared/i18n/translate.ts 的 allMessages 合并顺序一致
const dictionaries: Record<string, Record<string, unknown>> = {
  catalog,
  systemMessages,
  pluginMessages,
  sessionMessages,
  commandMessages,
  codexMessages,
  pixelMessages,
  projectToolsMessages,
  terminalMessages,
  sidebarMessages,
  projectMessages,
  workspaceMessages,
  machineMessages,
  machineErrors,
  wslMessages,
  channelMessages,
  teamMessages,
  notificationMessages,
  gitMessages,
  artifactMessages,
  errorMessages,
  contentMessages,
  branchMessages,
  updateMessages,
  customApiMessages,
  logMessages,
  feedbackMessages,
  trayMessages,
  mobileMessages,
  editorMessages,
  ...codingDictionaries,
  attachmentMessages,
  boardMessages,
  aiMessages,
  contextMessages,
  costMessages,
  longConversationMessages,
  tabMenuMessages,
  minimalModeMessages,
  imageViewerMessages,
  modelChannelMessages,
  fullAccessMessages,
  htmlPreviewMessages,
  recoveryMessages,
  pathClickMessages,
  contextMenuMessages,
  subagentMessages,
  subagentStopMessages,
  subagentRouteMessages,
  connectorsMessages,
  progressLineMessages,
  traceHistoryMessages,
  extensionCenterMessages,
  extstoreInstalledMessages,
  extstorePublishMessages,
  fileIconMessages,
  extGrammarMessages,
  editorThemeMessages,
  extSnippetMessages,
  extTaskMessages,
  promptMessages,
  resumeMessages,
  onboardingMessages,
  systemProxyMessages,
  approvalMessages,
  extstoreDetailMessages,
}

/** 中英文值不同、需要保持现状的重复 key（当前为空；新增重复必须先说明原因）。 */
const ALLOWED_DUPLICATES: string[] = []
/** renderer/src 下含 CJK 的字符串字面量个数基线；减少后请同步调低。 */
const HARDCODED_CJK_BASELINE = 352
/** text('中文') 反查词典调用个数基线；减少后请同步调低。 */
const TEXT_LOOKUP_BASELINE = 35

const srcRoot = join(__dirname, '..')
const mainRoot = join(__dirname, '..', '..', '..', 'main')
const sharedRoot = join(__dirname, '..', '..', '..', 'shared')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function sourceFiles(root: string): string[] {
  return walk(root).filter(file => {
    const rel = relative(root, file).split(sep).join('/')
    if (/\.test\.tsx?$/.test(rel) || /\.d\.ts$/.test(rel)) return false
    return !/(^|\/)(i18n|mock)\//.test(rel)
  })
}

const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/

/** 提取代码中的字符串字面量（跳过注释；模板字面量按整体计，嵌套表达式里的字符串另计）。 */
function extractStrings(code: string): Array<{ value: string; start: number }> {
  const result: Array<{ value: string; start: number }> = []
  const stack: Array<'tpl' | 'brace'> = []
  let i = 0
  const readTemplate = (): void => {
    // 从模板字面量内部开始读，遇到 ${ 压栈后返回
    let buf = ''
    const start = i
    while (i < code.length) {
      const c = code[i]
      if (c === '\\') {
        buf += code.slice(i, i + 2)
        i += 2
        continue
      }
      if (c === '`') {
        result.push({ value: buf, start })
        i++
        return
      }
      if (c === '$' && code[i + 1] === '{') {
        result.push({ value: buf, start })
        i += 2
        stack.push('tpl')
        return
      }
      buf += c
      i++
    }
  }
  while (i < code.length) {
    const c = code[i],
      next = code[i + 1]
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end < 0 ? code.length : end + 2
      continue
    }
    if (c === "'" || c === '"') {
      const start = i
      let buf = ''
      i++
      while (i < code.length && code[i] !== c && code[i] !== '\n') {
        if (code[i] === '\\') {
          buf += code.slice(i, i + 2)
          i += 2
        } else buf += code[i++]
      }
      i++
      result.push({ value: buf, start })
      continue
    }
    if (c === '`') {
      i++
      readTemplate()
      continue
    }
    if (c === '{') {
      stack.push('brace')
      i++
      continue
    }
    if (c === '}') {
      const top = stack.pop()
      i++
      if (top === 'tpl') readTemplate()
      continue
    }
    i++
  }
  return result
}

describe('i18n 防回归', () => {
  it('各词典之间没有重复 key（白名单除外）', () => {
    const owners = new Map<string, string[]>()
    for (const [name, dict] of Object.entries(dictionaries)) {
      for (const key of Object.keys(dict)) owners.set(key, [...(owners.get(key) ?? []), name])
    }
    const duplicates = [...owners]
      .filter(([, names]) => names.length > 1)
      .map(([key]) => key)
      .sort()
    expect(duplicates).toEqual([...ALLOWED_DUPLICATES].sort())
    expect(Object.keys(allMessages).length).toBe(owners.size)
  })

  it('codedError 用到的错误代码都在词典里（errors.<code>）', () => {
    const engineRoot = join(__dirname, '..', '..', '..', '..', '..', '..', 'packages', 'engine', 'src')
    const missing: string[] = []
    for (const root of [mainRoot, sharedRoot, engineRoot])
      for (const file of sourceFiles(root))
        for (const match of readFileSync(file, 'utf8').matchAll(/codedError\(\s*'([\w.]+)'/g))
          if (!(`errors.${match[1]}` in allMessages)) missing.push(`${relative(root, file)}: ${match[1]}`)
    expect(missing).toEqual([])
  })

  it('词典 key 不用自动编号（前缀.messageN），按英文文案起名', () => {
    expect(Object.keys(allMessages).filter(key => /\.message\d+$/.test(key))).toEqual([])
  })

  it('源码中 tr / t 的字面量 key 都存在于词典', () => {
    const call = /(?<![\w$.])(?:tr|t)\(\s*(['"])([^'"\n]+)\1/g
    const missing: string[] = []
    for (const root of [srcRoot, mainRoot, sharedRoot]) {
      for (const file of sourceFiles(root)) {
        const code = readFileSync(file, 'utf8')
        for (const match of code.matchAll(call)) {
          // 只检查长得像词典 key 的字面量（含点号的标识符），其它 t(...) 是局部函数
          if (!/^[A-Za-z][\w-]*(\.[\w-]+)+$/.test(match[2])) continue
          if (!(match[2] in allMessages)) missing.push(`${relative(srcRoot, file)}: ${match[2]}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('写死的中文字面量不增加', () => {
    let literals = 0,
      lookups = 0
    // data/ 是界面数据（空界面、导航、表单模板），原来在 mock/ 里，同样不计
    for (const file of sourceFiles(srcRoot).filter(f => !relative(srcRoot, f).startsWith('data' + sep))) {
      const code = readFileSync(file, 'utf8')
      for (const { value, start } of extractStrings(code)) {
        if (!CJK.test(value)) continue
        if (/(?<![\w$.])text\(\s*$/.test(code.slice(Math.max(0, start - 12), start))) lookups++
        else literals++
      }
    }
    // 减少后请同步调低基线，避免回升
    expect(
      literals,
      `写死的中文字面量 ${literals} 个，超过基线 ${HARDCODED_CJK_BASELINE}；请改用 tr()`,
    ).toBeLessThanOrEqual(HARDCODED_CJK_BASELINE)
    expect(lookups, `text('中文') 调用 ${lookups} 个，超过基线 ${TEXT_LOOKUP_BASELINE}`).toBeLessThanOrEqual(
      TEXT_LOOKUP_BASELINE,
    )
  })
})

describe('machineErrors 覆盖 main/machines 抛出的纯代码', () => {
  it.each(['SSH_MACHINE_MISSING', 'SSH_CONNECTING', 'SSH_HELPER_PATH_INVALID', 'TUNNEL_CLOSED', 'WSL_HOME_EMPTY'])(
    '%s 有中英文案',
    code => {
      const entry = (machineErrors as Record<string, { zh: string; en: string }>)[code]
      expect(entry?.zh).toBeTruthy()
      expect(entry?.en).toBeTruthy()
    },
  )
})
