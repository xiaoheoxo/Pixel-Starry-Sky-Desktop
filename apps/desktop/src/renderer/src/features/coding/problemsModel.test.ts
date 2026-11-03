import { describe, expect, it } from 'vitest'
import type { RunTask } from '../../../../shared/types/project-tools'
import {
  groupByFile,
  isCheckTask,
  lastRun,
  parseProblems,
  problemLine,
  projectPath,
  stepProblem,
  summarize,
  type Problem,
} from './problemsModel'

const task = (name: string, detail = ''): RunTask => ({ name, detail, line: null })
const p = (path: string, line: number, column: number, severity: Problem['severity'] = 'error'): Problem => ({
  path,
  line,
  column,
  severity,
  message: `m${line}`,
  source: 'tsc',
  code: 'TS1',
})

describe('isCheckTask', () => {
  it('认 tsc / vue-tsc / eslint / typecheck / lint', () => {
    expect(isCheckTask(task('build', 'tsc -b'))).toBe(true)
    expect(isCheckTask(task('check', 'vue-tsc --noEmit'))).toBe(true)
    expect(isCheckTask(task('x', 'node_modules/.bin/tsc'))).toBe(true)
    expect(isCheckTask(task('x', 'eslint .'))).toBe(true)
    expect(isCheckTask(task('typecheck'))).toBe(true)
    expect(isCheckTask(task('lint:fix'))).toBe(true)
  })
  it('不认别的命令，也不把 tsconfig 当 tsc', () => {
    expect(isCheckTask(task('dev', 'vite'))).toBe(false)
    expect(isCheckTask(task('copy', 'cp tsconfig.json out'))).toBe(false)
  })
})

describe('projectPath', () => {
  it('相对路径按任务目录拼，.. 往上走', () => {
    expect(projectPath('src/a.ts', 'D:\\repo', 'apps/desktop')).toBe('apps/desktop/src/a.ts')
    expect(projectPath('../../packages/p/x.ts', 'D:\\repo', 'apps/desktop')).toBe('packages/p/x.ts')
    expect(projectPath('./src\\b.ts', '/repo', '')).toBe('src/b.ts')
  })
  it('绝对路径在项目里就去掉根（盘符大小写不同也算），在外面保留', () => {
    expect(projectPath('d:\\Repo\\src\\a.ts', 'D:\\repo', '')).toBe('src/a.ts')
    expect(projectPath('/repo/src/a.ts', '/repo/', 'x')).toBe('src/a.ts')
    expect(projectPath('/other/a.ts', '/repo', '')).toBe('/other/a.ts')
    expect(projectPath('/repository/a.ts', '/repo', '')).toBe('/repository/a.ts')
  })
})

describe('parseProblems', () => {
  it('tsc 的两种格式，去掉颜色', () => {
    const out = [
      "src/store.ts(13,28): error TS2552: Cannot find name 'fals'. Did you mean 'false'?",
      "\u001b[96msrc/api.ts\u001b[0m:\u001b[93m48\u001b[0m:\u001b[93m9\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType 'string' is not assignable to type 'number'.",
      '',
      '48   const n: number = s',
      '           ~',
      'Found 2 errors in 2 files.',
    ].join('\r\n')
    expect(parseProblems(out, '/repo', 'app')).toEqual([
      {
        path: 'app/src/store.ts',
        line: 13,
        column: 28,
        severity: 'error',
        message: "Cannot find name 'fals'. Did you mean 'false'?",
        source: 'tsc',
        code: 'TS2552',
      },
      {
        path: 'app/src/api.ts',
        line: 48,
        column: 9,
        severity: 'error',
        message: "Type 'string' is not assignable to type 'number'.",
        source: 'tsc',
        code: 'TS2322',
      },
    ])
  })
  it('eslint stylish：文件标题下面的行，解析错误没有规则', () => {
    const out = [
      '> eslint .',
      '',
      'D:\\repo\\src\\store.ts',
      "   3:10  warning  'Thread' is defined but never used  @typescript-eslint/no-unused-vars",
      '  12:1   error    Parsing error: Unexpected token',
      '',
      '/elsewhere/b.js',
      '  1:1  error  Unexpected var  no-var',
      '',
      '✖ 3 problems (2 errors, 1 warning)',
      '  1:1  error  not under a file  rule',
    ].join('\n')
    expect(
      parseProblems(out, 'D:\\repo', '').map(x => [x.path, x.line, x.column, x.severity, x.message, x.code]),
    ).toEqual([
      ['src/store.ts', 3, 10, 'warning', "'Thread' is defined but never used", '@typescript-eslint/no-unused-vars'],
      ['src/store.ts', 12, 1, 'error', 'Parsing error: Unexpected token', ''],
      ['/elsewhere/b.js', 1, 1, 'error', 'Unexpected var', 'no-var'],
    ])
  })
  it('pnpm -r 的「包目录 脚本: 」前缀和 TTY 下的「│ 」行：路径相对那个包', () => {
    const out = [
      'apps/desktop typecheck: src/a.ts(1,2): error TS2304: m',
      'packages/p lint: D:\\repo\\packages\\p\\x.ts',
      'packages/p lint:   3:4  error  bad  no-var',
      'packages/p lint:',
      'packages/q typecheck$ tsc --noEmit',
      '│ src/b.ts(5,6): error TS1: n',
      '└─ Failed in 1s',
      'error TS6053: File not found.',
    ].join('\n')
    expect(parseProblems(out, 'D:\\repo', '').map(x => [x.path, x.line, x.column])).toEqual([
      ['apps/desktop/src/a.ts', 1, 2],
      ['packages/p/x.ts', 3, 4],
      ['packages/q/src/b.ts', 5, 6],
    ])
  })
})

describe('lastRun', () => {
  it('从最后一次回显的命令或「> 脚本」之后开始', () => {
    const text = ['$ pnpm run lint', 'old', '$ pnpm run lint', 'new'].join('\n')
    expect(lastRun(text, 'pnpm run lint', '')).toBe('new')
    expect(lastRun(['> tsc', 'a', '> tsc', 'b'].join('\n'), '', 'tsc')).toBe('b')
  })
  it('找不到起点就用整段；报错里提到脚本名不算起点', () => {
    expect(lastRun('a\nb', 'pnpm run x', 'tsc')).toBe('a\nb')
    expect(lastRun('> tsc\ntsconfig.json(1,1): error TS1: tsc', '', 'tsc')).toBe('tsconfig.json(1,1): error TS1: tsc')
  })
  it('tsc 监视模式：从最后一次「开始（增量）编译」之后开始', () => {
    const text = [
      '[10:00:00] Starting compilation in watch mode...',
      'a.ts(1,1): error TS1: old',
      '[10:00:05] File change detected. Starting incremental compilation...',
      '[10:00:06] Found 0 errors. Watching for file changes.',
    ].join('\n')
    expect(lastRun(text, 'pnpm run watch', 'tsc -w')).toBe('[10:00:06] Found 0 errors. Watching for file changes.')
  })
})

describe('summarize / groupByFile', () => {
  it('去重、排序、计数', () => {
    const s = summarize(
      [
        [p('b.ts', 2, 1), p('a.ts', 5, 1, 'warning')],
        [p('b.ts', 2, 1), p('a.ts', 1, 3)],
      ],
      true,
    )
    expect(s.items.map(x => `${x.path}:${x.line}`)).toEqual(['a.ts:1', 'a.ts:5', 'b.ts:2'])
    expect([s.errors, s.warnings, s.ran]).toEqual([2, 1, true])
    expect(groupByFile(s.items).map(g => [g.path, g.items.length])).toEqual([
      ['a.ts', 2],
      ['b.ts', 1],
    ])
  })
})

describe('stepProblem', () => {
  const list = [p('a.ts', 3, 1), p('a.ts', 3, 9), p('a.ts', 10, 2)]
  it('往后找，到头绕回第一个', () => {
    expect(stepProblem(list, 3, 1, 1)).toBe(list[1])
    expect(stepProblem(list, 20, 1, 1)).toBe(list[0])
  })
  it('往前找，到头绕回最后一个', () => {
    expect(stepProblem(list, 10, 1, -1)).toBe(list[1])
    expect(stepProblem(list, 1, 1, -1)).toBe(list[2])
    expect(stepProblem([], 1, 1, 1)).toBeNull()
  })
})

describe('problemLine', () => {
  it('路径:行:列 消息 (来源 规则)', () => {
    expect(problemLine(p('a.ts', 3, 4), 'src/a.ts')).toBe('src/a.ts:3:4 m3 (tsc TS1)')
    expect(problemLine({ ...p('a.ts', 1, 1), code: '' }, 'a.ts')).toBe('a.ts:1:1 m1 (tsc)')
  })
})
