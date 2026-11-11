import type {
  ProviderInput,
  ProvidersState,
  ProviderTestResult,
  ProviderView,
  RelayBilling,
  TranscribeInput,
} from '../shared/types/providers'

/** 自定义 API（docs/ui/custom-api.md §4.4）：Key 只进不出，返回的都打了码 */
export interface ProvidersBridge {
  list(): Promise<ProvidersState>
  save(input: ProviderInput): Promise<ProviderView>
  remove(id: string): Promise<void>
  /** 对话框里的配置（可以还没保存；Key 留空沿用已保存的） */
  test(input: ProviderInput): Promise<ProviderTestResult>
  models(input: ProviderInput): Promise<string[]>
  /** 从中转站读取费用倍率（sub2api / new-api） */
  billing(input: ProviderInput): Promise<RelayBilling>
  /** 语音输入：把一段录音交给已保存的接口转写，返回文字（docs/ui/voice-input.md） */
  transcribe(input: TranscribeInput): Promise<string>
  onChange(callback: (state: ProvidersState) => void): () => void
}
