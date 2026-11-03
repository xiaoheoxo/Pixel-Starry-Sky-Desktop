import { describe, expect, it } from 'vitest'
import { declarations, enclosingSymbol, maskSource, nestDepths, symbolsSupported } from './symbolsModel'

const lineOf = (text: string, needle: string): number => text.slice(0, text.indexOf(needle)).split('\n').length

describe('maskSource', () => {
  it('把字符串、注释里的内容抹掉，长度不变', () => {
    const src = `const a = "{ ( ["; // }\n/* { */ const b = 'x'`
    const masked = maskSource(src, 'js')
    expect(masked).toHaveLength(src.length)
    expect(masked).not.toContain('{')
    expect(masked).toContain('const b')
  })
})

describe('declarations / enclosingSymbol (ts)', () => {
  const src = [
    "import x from 'y'", // 1
    '', // 2
    'export function SessionHeader(props: Props) {', // 3
    '  const label = "}"', // 4
    '  if (props.a) {', // 5
    '    return 1', // 6
    '  }', // 7
    '  return label', // 8
    '}', // 9
    '', // 10
    'const double = (n: number) => n * 2', // 11
    '', // 12
    'export const Panel = async ({ a }: P): Promise<void> => {', // 13
    '  await a', // 14
    '}', // 15
    '', // 16
    'export default class Store extends Base {', // 17
    '  private count = 0', // 18
    '  static async load(id: string): Promise<Store> {', // 19
    '    const inner = () => {', // 20
    '      return id', // 21
    '    }', // 22
    '    foo(inner)', // 23
    '    return new Store()', // 24
    '  }', // 25
    '  get size() {', // 26
    '    return this.count', // 27
    '  }', // 28
    '}', // 29
    'const data = { a: 1 }', // 30
  ].join('\n')

  it('找到 function、箭头函数、class 和方法', () => {
    const list = declarations(src, 'a.tsx').map(d => [d.name, d.kind, d.line])
    expect(list).toEqual([
      ['SessionHeader', 'function', 3],
      ['double', 'function', 11],
      ['Panel', 'function', 13],
      ['Store', 'class', 17],
      ['load', 'method', 19],
      ['inner', 'function', 20],
      ['size', 'method', 26],
    ])
  })
  it('函数体里的行归属这个函数，字符串里的括号不影响', () => {
    expect(enclosingSymbol(src, 6, 'a.ts')?.name).toBe('SessionHeader')
    expect(enclosingSymbol(src, 8, 'a.ts')?.name).toBe('SessionHeader')
  })
  it('表达式体箭头函数只覆盖自己那一行', () => {
    expect(enclosingSymbol(src, 11, 'a.ts')?.name).toBe('double')
    expect(enclosingSymbol(src, 12, 'a.ts')).toBeNull()
  })
  it('嵌套时取最里面的', () => {
    expect(enclosingSymbol(src, 21, 'a.ts')).toMatchObject({ name: 'inner', kind: 'function' })
    expect(enclosingSymbol(src, 24, 'a.ts')).toMatchObject({ name: 'load', kind: 'method' })
    expect(enclosingSymbol(src, 18, 'a.ts')).toMatchObject({ name: 'Store', kind: 'class' })
    expect(enclosingSymbol(src, lineOf(src, 'return this.count'), 'a.ts')?.name).toBe('size')
  })
  it('声明之外返回 null', () => {
    expect(enclosingSymbol(src, 1, 'a.ts')).toBeNull()
    expect(enclosingSymbol(src, 30, 'a.ts')).toBeNull()
  })
  it('范围从声明行行首到块末尾', () => {
    const d = declarations(src, 'a.ts')[0]
    expect(src.slice(d.from, d.to).startsWith('export function SessionHeader')).toBe(true)
    expect(src.slice(d.from, d.to).endsWith('}')).toBe(true)
    expect(src.slice(d.to, d.to + 2)).toBe('\n\n')
  })
  it('调用语句和 if 不算声明', () => {
    const text = ['class A {', '  run() {', '    foo(1)', '    if (x) {', '    }', '  }', '}'].join('\n')
    expect(declarations(text, 'a.ts').map(d => d.name)).toEqual(['A', 'run'])
  })
  it('嵌套层数按范围算', () => {
    expect(nestDepths(declarations(src, 'a.tsx'))).toEqual([0, 0, 0, 0, 1, 2, 1])
  })
  it('没分号的括号表达式变量不算函数，也不吞后面的声明', () => {
    const text = ['const total = (a + b) * 2', 'function foo() {}', 'const bar = () => 2'].join('\n')
    const list = declarations(text, 'a.ts')
    expect(list.map(d => d.name)).toEqual(['foo', 'bar'])
    expect(nestDepths(list)).toEqual([0, 0])
  })
  it('交叠范围里已结束的父级不算层数', () => {
    const d = (from: number, to: number) => ({ name: 'x', kind: 'function' as const, line: 1, from, to })
    expect(nestDepths([d(0, 10), d(2, 50), d(20, 30)])).toEqual([0, 1, 1])
  })
  it('不认识的语言返回空', () => {
    expect(symbolsSupported('a.go')).toBe(false)
    expect(symbolsSupported('a.mts')).toBe(true)
    expect(declarations('func main() {}', 'a.go')).toEqual([])
    expect(enclosingSymbol('func main() {}', 1, 'a.go')).toBeNull()
  })
})

describe('python', () => {
  const src = [
    'import os', // 1
    '', // 2
    'class Repo:', // 3
    '    """doc with def fake():"""', // 4
    '    def get(self, key,', // 5
    '            default=None',
    '    ):', // 7
    '        # def nope():',
    '        return key', // 9
    '', // 10
    '    async def put(self):', // 11
    '        def helper():', // 12
    '            pass', // 13
    '        return helper', // 14
    '', // 15
    'def main():', // 16
    '    print("def x(")', // 17
  ].join('\n')
  it('识别 class、方法、函数，跳过字符串和注释', () => {
    expect(declarations(src, 'a.py').map(d => [d.name, d.kind, d.line])).toEqual([
      ['Repo', 'class', 3],
      ['get', 'method', 5],
      ['put', 'method', 11],
      ['helper', 'method', 12],
      ['main', 'function', 16],
    ])
  })
  it('多行签名和嵌套', () => {
    expect(enclosingSymbol(src, 9, 'a.py')?.name).toBe('get')
    expect(enclosingSymbol(src, 13, 'a.py')?.name).toBe('helper')
    expect(enclosingSymbol(src, 14, 'a.py')?.name).toBe('put')
    expect(enclosingSymbol(src, 17, 'a.py')?.name).toBe('main')
    expect(enclosingSymbol(src, 1, 'a.py')).toBeNull()
  })
  it('嵌套层数', () => {
    expect(nestDepths(declarations(src, 'a.py'))).toEqual([0, 1, 1, 2, 0])
  })
})
