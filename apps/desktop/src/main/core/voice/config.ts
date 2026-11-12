// 语音输入识别用的地址和 Key（docs/ui/voice-input.md §10）：整份加密存在本机，Key 不出主进程
import type { VoiceConfigInput, VoiceConfigView, VoiceMode } from '../../../shared/types/voice'
import { normalizeBaseUrl } from '../providers/store'
import { SecureStore, type Cipher } from '../secure-store'

export interface VoiceEndpoint {
  baseUrl: string
  apiKey: string
  mode: VoiceMode
}

const ID = 'voice'

export class VoiceConfig {
  private readonly secrets: SecureStore

  constructor(file: string, cipher: Cipher) {
    this.secrets = new SecureStore(file, cipher)
  }

  endpoint(): VoiceEndpoint | null {
    const v = this.secrets.get(ID)
    if (!v?.baseUrl) return null
    return { baseUrl: v.baseUrl, apiKey: v.apiKey ?? '', mode: v.mode === 'chat' ? 'chat' : 'file' }
  }

  view(): VoiceConfigView {
    const e = this.endpoint()
    return {
      baseUrl: e?.baseUrl ?? '',
      mode: e?.mode ?? 'file',
      keyHint: e?.apiKey ? e.apiKey.slice(-4) : null,
      persistent: this.secrets.persistent,
    }
  }

  save(raw: VoiceConfigInput): VoiceConfigView {
    const input = (raw ?? {}) as Partial<VoiceConfigInput>
    if (typeof input.baseUrl !== 'string' || !input.baseUrl.trim()) {
      this.secrets.remove(ID)
      return this.view()
    }
    const baseUrl = normalizeBaseUrl(input.baseUrl, 'chat')
    const old = this.endpoint()
    const typed = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
    // eslint-disable-next-line no-control-regex
    if (typed.length > 500 || /[\u0000-\u001f\u007f]/.test(typed)) throw new Error('API Key 格式不对')
    const sameSite = !!old && new URL(old.baseUrl).origin === new URL(baseUrl).origin
    const apiKey = typed || (sameSite ? old.apiKey : '')
    this.secrets.set(ID, { baseUrl, apiKey, mode: input.mode === 'chat' ? 'chat' : 'file' })
    return this.view()
  }
}
