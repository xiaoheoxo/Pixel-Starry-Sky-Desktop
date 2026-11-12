// 语音输入（docs/ui/voice-input.md §10）：识别用的地址和 Key 的 IPC。Key 只在主进程里，设置页拿到的只有末 4 位
import { join } from 'node:path'
import { app } from 'electron'
import type { VoiceConfigInput } from '../../shared/types/voice'
import { systemCipher } from '../app/system-cipher'
import { VoiceConfig } from '../core/voice/config'
import { parseTranscribeRequest, transcribeAudio } from '../core/voice/transcribe'
import * as ipc from '../ipc/guard'

export function initVoice(): void {
  const config = new VoiceConfig(join(app.getPath('userData'), 'voice', 'voice.json'), systemCipher)
  ipc.handle('voice:get', () => config.view())
  ipc.handle('voice:save', (_e, input: unknown) => config.save(input as VoiceConfigInput))
  ipc.handle('voice:transcribe', (_e, input: unknown) => {
    const endpoint = config.endpoint()
    if (!endpoint) throw new Error('还没有设置语音识别的接口地址')
    return transcribeAudio(endpoint, parseTranscribeRequest(input), (url, init) => fetch(url, init))
  })
}
