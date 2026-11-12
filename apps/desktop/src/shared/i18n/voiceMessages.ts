// 语音输入（docs/ui/voice-input.md）
export const voiceMessages = {
  'voice.start': { zh: '语音输入', en: 'Voice input' },
  'voice.stop': { zh: '结束录音并识别（Esc 取消）', en: 'Stop and transcribe (Esc to cancel)' },
  'voice.cancel': { zh: '正在识别，点击取消', en: 'Transcribing — click to cancel' },
  'voice.setup': {
    zh: '语音输入还没有填识别用的接口地址和 Key',
    en: 'Voice input has no transcription endpoint and key set up yet',
  },
  'voice.openSettings': { zh: '去设置', en: 'Open settings' },
  'voice.noMic': { zh: '没有找到麦克风', en: 'No microphone found' },
  'voice.denied': { zh: '用不了麦克风：{error}', en: 'Cannot use the microphone: {error}' },
  'voice.empty': { zh: '没有识别出文字', en: 'No speech was recognized' },
  'voice.failed': { zh: '语音识别失败：{error}', en: 'Transcription failed: {error}' },
  'voice.settings.title': { zh: '语音输入', en: 'Voice input' },
  'voice.settings.description': {
    zh: '点输入框的麦克风录音，录完发到下面填的地址识别成文字，放到光标处，不会自动发送。地址和 Key 单独填在这里，和模型通道无关；Key 加密存在本机。一次最多录 2 分钟。',
    en: 'Click the microphone in the composer to record. The recording is sent to the address below, and the text is inserted at the cursor without sending. The address and key are set here, separate from model channels; the key is stored encrypted on this computer. Up to 2 minutes per recording.',
  },
  'voice.settings.baseUrl': {
    zh: '接口地址，例如 https://api.xiaomimimo.com/v1',
    en: 'Endpoint, e.g. https://api.openai.com/v1',
  },
  'voice.settings.apiKey': { zh: 'API Key', en: 'API key' },
  'voice.settings.apiKeySaved': { zh: '已保存 ••••{hint}，留空不改', en: 'Saved ••••{hint}; leave empty to keep' },
  'voice.settings.mode': { zh: '调用方式', en: 'Call style' },
  'voice.settings.modeFile': { zh: '上传文件（OpenAI）', en: 'File upload (OpenAI)' },
  'voice.settings.modeChat': { zh: '对话接口（小米 MiMo）', en: 'Chat API (Xiaomi MiMo)' },
  'voice.settings.unsaved': {
    zh: '系统加密用不了，Key 只在这次运行里有效',
    en: 'System encryption is unavailable; the key only lasts for this run',
  },
  'voice.settings.model': { zh: '识别模型', en: 'Transcription model' },
  'voice.settings.language': { zh: '语言', en: 'Language' },
  'voice.settings.languageAuto': { zh: '自动判断', en: 'Auto-detect' },
  'voice.settings.languageZh': { zh: '中文', en: 'Chinese' },
  'voice.settings.languageEn': { zh: '英文', en: 'English' },
} as const
