// 脚本调用的校验（docs/ui/extension-commands-plan.md §4）：端口来的都是不可信输入，方法名、参数、权限逐个核对
export const SCRIPT_LIMITS = {
  /** 一次命令最多调用多少次 */
  calls: 500,
  /** 其中存储调用的上限：每次都同步读写文件，占着主进程 */
  storageCalls: 100,
  /** ui.showMessage 一次命令最多几条（防刷屏） */
  messages: 3,
  /** ui.pick、ui.input 一次命令最多几次：对话框是模态的，循环弹就什么都做不了 */
  dialogs: 20,
  /** 一次命令最多写入多少字符：写爆文档会让界面进程崩溃，别的文件没保存的改动也跟着丢 */
  written: 8 * 1024 * 1024,
  /** replaceRange 的文字 */
  text: 2 * 1024 * 1024,
  /** 提示文字 */
  label: 500,
  pickItems: 200,
  storageKey: 200,
  /** 一个值最多多少字符 */
  storageValue: 1024 * 1024,
  /** 每个扩展的存储（序列化后的字符数） */
  storageChars: 5 * 1024 * 1024,
} as const

export type ScriptMethod =
  | 'editor.getContext'
  | 'editor.getText'
  | 'editor.replaceRange'
  | 'ui.showMessage'
  | 'ui.pick'
  | 'ui.input'
  | 'storage.get'
  | 'storage.set'
  | 'storage.delete'

const PERMISSION: Record<ScriptMethod, string> = {
  'editor.getContext': 'editor.read',
  'editor.getText': 'editor.read',
  'editor.replaceRange': 'editor.write',
  'ui.showMessage': 'ui.notify',
  'ui.pick': 'ui.notify',
  'ui.input': 'ui.notify',
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.delete': 'storage',
}

export class ScriptCallError extends Error {
  constructor(
    message: string,
    /** 明显不是正常调用：直接停掉扩展 */
    readonly fatal = false,
  ) {
    super(message)
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== 'string') throw new ScriptCallError(`${what} must be a string`)
  if (v.length > max) throw new ScriptCallError(`${what} is too long`, max >= SCRIPT_LIMITS.text)
  return v
}
const offset = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ScriptCallError(`${what} must be an offset`)
  return v
}

export interface CheckedCall {
  method: ScriptMethod
  permission: string
  args: unknown[]
  /** 要等用户回答：这段时间暂停单次超时 */
  waitsForUser: boolean
  /** 经界面完成（编辑器、对话框）；否则主进程自己处理（存储） */
  viaWindow: boolean
}

/** 校验一次调用；不合格抛 ScriptCallError。权限由调用方按 permission 查 */
export function checkCall(method: unknown, rawArgs: unknown): CheckedCall {
  if (typeof method !== 'string' || !Object.hasOwn(PERMISSION, method))
    throw new ScriptCallError('unknown method', true)
  const m = method as ScriptMethod
  if (!Array.isArray(rawArgs) || rawArgs.length > 3) throw new ScriptCallError('bad arguments', true)
  const a = rawArgs as unknown[]
  const done = (args: unknown[]): CheckedCall => ({
    method: m,
    permission: PERMISSION[m],
    args,
    waitsForUser: m === 'ui.pick' || m === 'ui.input',
    viaWindow: !m.startsWith('storage.'),
  })
  switch (m) {
    case 'editor.getContext':
    case 'editor.getText':
      return done([])
    case 'editor.replaceRange': {
      const from = offset(a[0], 'from'),
        to = offset(a[1], 'to')
      if (to < from) throw new ScriptCallError('to must not be before from')
      return done([from, to, str(a[2], SCRIPT_LIMITS.text, 'text')])
    }
    case 'ui.showMessage':
      return done([str(a[0], SCRIPT_LIMITS.label, 'message')])
    case 'ui.pick': {
      if (!Array.isArray(a[0]) || a[0].length === 0 || a[0].length > SCRIPT_LIMITS.pickItems)
        throw new ScriptCallError(`pick needs 1 to ${SCRIPT_LIMITS.pickItems} items`)
      const items = a[0].map(i => str(i, SCRIPT_LIMITS.label, 'item'))
      const options = isRec(a[1]) ? a[1] : {}
      return done([items, options.title === undefined ? '' : str(options.title, SCRIPT_LIMITS.label, 'title')])
    }
    case 'ui.input': {
      const options = isRec(a[0]) ? a[0] : {}
      return done([
        options.title === undefined ? '' : str(options.title, SCRIPT_LIMITS.label, 'title'),
        options.value === undefined ? '' : str(options.value, SCRIPT_LIMITS.label, 'value'),
      ])
    }
    case 'storage.get':
    case 'storage.delete':
      return done([str(a[0], SCRIPT_LIMITS.storageKey, 'key')])
    case 'storage.set':
      return done([str(a[0], SCRIPT_LIMITS.storageKey, 'key'), str(a[1], SCRIPT_LIMITS.storageValue, 'value')])
  }
}
