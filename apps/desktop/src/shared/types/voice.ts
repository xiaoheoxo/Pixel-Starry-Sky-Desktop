// 语音输入（docs/ui/voice-input.md §10）：识别用的地址和 Key 单独存，不跟模型通道的接口关联

/** file：OpenAI 的 /audio/transcriptions（上传文件）；chat：/chat/completions 里带 input_audio（小米 MiMo 等） */
export type VoiceMode = 'file' | 'chat'

/** 设置页看到的：Key 只有末 4 位 */
export interface VoiceConfigView {
  /** 空串：还没设置 */
  baseUrl: string
  mode: VoiceMode
  keyHint: string | null
  /** 系统加密不可用时只在这次运行里有效 */
  persistent: boolean
}

export interface VoiceConfigInput {
  /** 空串：清掉设置 */
  baseUrl: string
  mode: VoiceMode
  /** 不给或空串：沿用已保存的（换了站点就清掉，免得把 Key 发给别的站） */
  apiKey?: string
}

/** 一次转写：录音发到设置里的地址 */
export interface TranscribeInput {
  model: string
  /** 录音的类型，例如 audio/wav */
  mime: string
  audio: ArrayBuffer
  /** 两个字母的语言代码；不给让接口自己判断 */
  language?: string | null
}

export interface VoiceBridge {
  get(): Promise<VoiceConfigView>
  save(input: VoiceConfigInput): Promise<VoiceConfigView>
  transcribe(input: TranscribeInput): Promise<string>
}
