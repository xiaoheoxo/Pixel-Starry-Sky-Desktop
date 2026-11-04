// 脚本扩展能用的全局对象 pixelsky（docs/extensions/authoring-spec.md §13）。
// 在 main.js 开头写 /// <reference path="../pixelsky.d.ts" /> 就有补全和类型检查；这个文件不进包。

declare namespace pixelsky {
  namespace commands {
    /** 登记清单 contributes.commands 里写的命令；脚本加载时同步调用。handler 结束（含 Promise）命令才算结束 */
    function register(id: string, handler: () => void | Promise<void>): void
  }

  interface EditorContext {
    /** 当前文件的路径；没保存过的文件是空字符串 */
    path: string
    /** 语言 id，如 json、python；认不出来是空字符串 */
    language: string
    /** 光标位置（从 0 数的字符偏移，UTF-16） */
    cursor: number
    /** 全文长度 */
    length: number
    readonly: boolean
    /** 主选区；没选中时 from === to、text 是空字符串。选中超过 1 MB 时 getContext 报错 */
    selection: { from: number; to: number; text: string }
  }

  /** 权限 editor.read、editor.write。没有打开的编辑器时都会报错，清单里写 requires 可以提前灰掉命令 */
  namespace editor {
    function getContext(): Promise<EditorContext>
    /** 全文；文件超过 1 MB 时报错 */
    function getText(): Promise<string>
    /** 替换 [from, to)，进撤销栈；一次最多 2 MB，一次命令合计最多 8 MB。运行期间文件被别处改过时报错 */
    function replaceRange(from: number, to: number, text: string): Promise<void>
  }

  /** 权限 ui.notify */
  namespace ui {
    /** 一条提示，最多 500 字；一次命令最多 3 条 */
    function showMessage(message: string): Promise<void>
    /** 让用户选一项，最多 200 项；取消时是 null。等用户回答的时间不算进 10 秒；pick、input 一次命令合计最多 20 次 */
    function pick(items: string[], options?: { title?: string }): Promise<string | null>
    /** 让用户输入一段文字；取消时是 null */
    function input(options?: { title?: string; value?: string }): Promise<string | null>
  }

  /** 权限 storage。每个扩展分开，合计 5 MB，一个值最多 1 MB；一次命令最多调用 100 次；卸载时清掉 */
  namespace storage {
    /** 没有这个键时是 null */
    function get(key: string): Promise<string | null>
    /** 值只能是字符串，结构化数据自己 JSON.stringify */
    function set(key: string, value: string): Promise<void>
    function delete_(key: string): Promise<void>
    export { delete_ as delete }
  }
}
