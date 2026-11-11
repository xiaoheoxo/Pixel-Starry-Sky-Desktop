// 语音输入（docs/ui/voice-input.md）
export const voiceMessages = {
  'voice.start': { zh: '语音输入', en: 'Voice input' },
  'voice.stop': { zh: '结束录音并识别（Esc 取消）', en: 'Stop and transcribe (Esc to cancel)' },
  'voice.cancel': { zh: '正在识别，点击取消', en: 'Transcribing — click to cancel' },
  'voice.setup': {
    zh: '语音输入要用一个 OpenAI 兼容的自定义接口来识别，还没有设置',
    en: 'Voice input needs an OpenAI-compatible custom endpoint for transcription, and none is set up yet',
  },
  'voice.openSettings': { zh: '去设置', en: 'Open settings' },
  'voice.noMic': { zh: '没有找到麦克风', en: 'No microphone found' },
  'voice.denied': { zh: '用不了麦克风：{error}', en: 'Cannot use the microphone: {error}' },
  'voice.empty': { zh: '没有识别出文字', en: 'No speech was recognized' },
  'voice.failed': { zh: '语音识别失败：{error}', en: 'Transcription failed: {error}' },
  'voice.settings.title': { zh: '语音输入', en: 'Voice input' },
  'voice.settings.description': {
    zh: '点输入框的麦克风录音，录完发到下面选的接口识别成文字，放到光标处，不会自动发送。接口要支持 OpenAI 的语音转写（/audio/transcriptions），一次最多录 2 分钟。',
    en: 'Click the microphone in the composer to record. The recording is sent to the endpoint below, and the text is inserted at the cursor without sending. The endpoint must support OpenAI audio transcription (/audio/transcriptions); up to 2 minutes per recording.',
  },
  'voice.settings.endpoint': { zh: '识别用的接口', en: 'Transcription endpoint' },
  'voice.settings.model': { zh: '识别模型', en: 'Transcription model' },
  'voice.settings.language': { zh: '语言', en: 'Language' },
  'voice.settings.languageAuto': { zh: '自动判断', en: 'Auto-detect' },
  'voice.settings.languageZh': { zh: '中文', en: 'Chinese' },
  'voice.settings.languageEn': { zh: '英文', en: 'English' },
  'voice.settings.none': {
    zh: '还没有能用的接口：先在「模型通道 › 自定义 API」里添加一个 OpenAI 协议（Responses 或 Chat Completions）的接口。',
    en: 'No usable endpoint yet: add an OpenAI-protocol (Responses or Chat Completions) endpoint in Model channels › Custom API.',
  },
} as const
