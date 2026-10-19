// 设置 › 子智能体（docs/ui/subagent-routing.md）：存在 <userData>/subagents.json，不含密钥。
// 读不出来、内容不对时回到默认（跟随主会话），不让应用起不来
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSubagentSettings, type SubagentSettings } from '../../shared/types/subagents'

const FILE = 'subagents.json'

export class SubagentSettingsStore {
  private settings: SubagentSettings
  constructor(private readonly dir: string) {
    let raw: unknown = null
    try {
      raw = JSON.parse(readFileSync(join(dir, FILE), 'utf8'))
    } catch {
      raw = null
    }
    this.settings = parseSubagentSettings(raw)
  }

  get(): SubagentSettings {
    return this.settings
  }

  /** 收到的设置先过一遍校验再存；返回存下的 */
  set(input: unknown): SubagentSettings {
    this.settings = parseSubagentSettings(input)
    const file = join(this.dir, FILE)
    writeFileSync(`${file}.tmp`, JSON.stringify(this.settings, null, 2))
    renameSync(`${file}.tmp`, file)
    return this.settings
  }
}
