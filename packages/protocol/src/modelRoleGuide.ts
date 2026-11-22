import { modelVendorGuides } from './modelVendorGuide'
import { publicModelFamilies } from './publicModelFamilies'

type Copy = readonly [main: string, evaluator: string]
type Localized = { zh: Copy; en: Copy; vendorOnly?: true }

// Usage guidance, not model specs or routing policy. A recognized family does not make an ID eligible.
const exact: ReadonlyMap<string, Localized> = new Map([
  [
    'gpt-6.2-astra',
    {
      zh: ['旗舰：适合架构决策、大规模重构和需要端到端验证的复杂项目。', '适合复核误判代价高的复杂设计和迁移。'],
      en: [
        'Flagship for architecture decisions, large refactors, and complex end-to-end work.',
        'Recheck high-cost design and migration decisions.',
      ],
    },
  ],
  [
    'deepseek-v4.1-flash',
    {
      zh: ['快速：适合日常编码、摘要和批量整理。', '适合快速识别任务范围，区分小改动和常规开发。'],
      en: [
        'Fast for day-to-day coding, summaries, and batch work.',
        'Quickly identify scope and separate small edits from routine development.',
      ],
    },
  ],
  [
    'kimi-k3.1-pro',
    {
      zh: ['旗舰：适合长时间编码、多阶段交付和长材料分析。', '适合复核复杂长任务的前置依赖和验收条件。'],
      en: [
        'Flagship for long coding sessions, multi-stage work, and long documents.',
        'Recheck prerequisites and acceptance criteria in complex, long requests.',
      ],
    },
  ],
])

const families: ReadonlyArray<readonly [RegExp, Localized]> = [
  [
    /^gpt-6(?:\.\d+)?-astra\b/,
    {
      zh: ['Astra 系列定位：架构决策、大规模重构和疑难排障。', '适合复核误判代价高的复杂任务，日常初筛不必用旗舰。'],
      en: [
        'Astra family: architecture decisions, large refactors, and hard debugging.',
        'Recheck complex, high-cost decisions; not needed for routine triage.',
      ],
    },
  ],
  [
    /^gpt-6(?:\.\d+)?-sol\b/,
    {
      zh: ['通用：写功能、修 Bug、审 PR、补测试。', '判断复杂度不明确、涉及多个模块或验收约束的任务。'],
      en: [
        'Everyday choice for features, fixes, PR reviews, and tests.',
        'Assess ambiguous work spanning modules or acceptance criteria.',
      ],
    },
  ],
  [
    /^gpt-6(?:\.\d+)?-terra\b/,
    {
      zh: ['快速执行：擅长界面理解、桌面操作和明确的修改。', '判断说明较长、有多个明确步骤的文本任务。'],
      en: [
        'Fast execution for interface understanding, computer use, and scoped edits.',
        'Assess longer text requests with several clear steps.',
      ],
    },
  ],
  [
    /^gpt-(?:6(?:\.\d+)?|5\.6)-luna\b/,
    {
      zh: ['轻量：适合摘要、分类、简短问答和文案微调。', '适合快速初筛任务难度。'],
      en: [
        'Lightweight model for summaries, classification, short answers, and small edits.',
        'Use for quick difficulty triage.',
      ],
    },
  ],
  [
    /^gpt-5\.5\b/,
    {
      zh: ['通用推理：适合编码、排错和多步骤工作。', '可复核约束不清或涉及多个步骤的任务。'],
      en: [
        'General reasoning for coding, debugging, and multi-step work.',
        'Recheck unclear constraints or multi-step requests.',
      ],
    },
  ],
  [
    /^deepseek-(?:v\d+(?:\.\d+)?-)?flash\b/,
    {
      zh: ['快速：适合日常编码、摘要和批量整理。', '适合初筛明确请求，区分小改动和常规任务。'],
      en: [
        'Fast for day-to-day coding, summaries, and batch work.',
        'Triage clearly stated requests and distinguish small edits from routine work.',
      ],
    },
  ],
  [
    /^deepseek-(?:v\d+(?:\.\d+)?-)?pro\b/,
    {
      zh: ['深度推理：适合复杂编码、多步骤调试和长上下文分析。', '适合复核复杂约束和跨模块影响。'],
      en: [
        'Deep reasoning for complex coding, multi-step debugging, and long-context analysis.',
        'Recheck complex constraints and cross-module impact.',
      ],
    },
  ],
  [
    /^deepseek(?:-v?\d+(?:\.\d+)?)?$/,
    {
      vendorOnly: true,
      zh: [
        'DeepSeek 系列：适合代码分析、文本处理和推理，具体用途随型号变化。',
        '适合按文本目标和约束评估任务；未识别具体档位。',
      ],
      en: [
        'DeepSeek family for code analysis, text work, and reasoning; capabilities vary by model.',
        'Assess the task from its text goals and constraints; the variant is unknown.',
      ],
    },
  ],
  [
    /^kimi-k(?:3(?:\.1)?|2\.[567])\b/,
    {
      zh: [
        '长任务：适合跨文件编码、长材料分析和多步骤工作。',
        '适合识别长任务中的依赖和验收条件，不必用它做简单分类。',
      ],
      en: [
        'For long-running coding, long documents, and multi-step work.',
        'Assess dependencies and acceptance criteria in long requests, rather than basic classification.',
      ],
    },
  ],
  [
    /^grok-4\.7\b/,
    {
      zh: ['深度推理：适合复杂代码分析和需要多步工具协作的任务。', '适合复核复杂度容易被低估的任务。'],
      en: [
        'Deep reasoning for complex code analysis and multi-step tool workflows.',
        'Recheck work whose complexity is easy to underestimate.',
      ],
    },
  ],
  [
    /^grok-4\.[36]\b/,
    {
      zh: ['通用推理：适合日常编码、分析和工具调用。', '适合判断常规代码修改或工具流程的复杂度。'],
      en: [
        'General reasoning for day-to-day coding, analysis, and tool use.',
        'Assess the difficulty of routine code changes or tool workflows.',
      ],
    },
  ],
  [
    /^claude-(?:fable|opus)\b/,
    {
      zh: ['高难度：适合长时间编码、大型重构和复杂推理。', '适合复核高返工成本的设计和迁移任务。'],
      en: [
        'For long-running coding, large refactors, and demanding reasoning.',
        'Recheck design and migration tasks with high rework costs.',
      ],
    },
  ],
  [
    /^claude-sonnet\b/,
    {
      zh: ['均衡：适合日常开发、代码审查和写作。', '适合判断多步骤工作和不明确的代码需求。'],
      en: [
        'Balanced choice for everyday development, code review, and writing.',
        'Assess multi-step work or ambiguous coding requirements.',
      ],
    },
  ],
  [
    /^claude-haiku\b/,
    {
      zh: ['轻量：适合分类、信息提取和简短修改。', '适合高频、低等待的任务难度初筛。'],
      en: [
        'Lightweight for classification, extraction, and short edits.',
        'Use for frequent, low-latency difficulty triage.',
      ],
    },
  ],
  [
    /^gemini-(?:4-carbon|\d+(?:\.\d+)?-pro)\b/,
    {
      zh: ['深度推理：适合复杂编码和多模态材料分析。', '适合复核多约束任务；Agnes 当前只评估文字。'],
      en: [
        'Deep reasoning for complex coding and multimodal analysis.',
        'Recheck tasks with many constraints; Agnes currently assesses text only.',
      ],
    },
  ],
  [
    /^gemini-4-(?:neon|argon)\b/,
    {
      zh: ['高效推理：适合多步骤开发和复杂知识工作。', '适合判断跨模块请求是否需要更强的推理。'],
      en: [
        'Efficient reasoning for multi-step development and complex knowledge work.',
        'Assess whether cross-module requests need deeper reasoning.',
      ],
    },
  ],
  [
    /^gemini-(?:4-hydrogen|\d+(?:\.\d+)?-flash(?:-lite)?)\b/,
    {
      zh: ['快速：适合日常编码、摘要和批量处理。', '适合快速判断任务范围和做简单分类。'],
      en: [
        'Fast option for everyday coding, summaries, and batch work.',
        'Quickly assess scope and handle basic classification.',
      ],
    },
  ],
]

/** Expand bounded, recognizable shorthand for copy lookup only; never use it as a routed model ID. */
function expandModelShorthand(model: string): string {
  const deep = /^(?:deepseek|deep|ds)-?v?(\d+(?:\.\d+)?)(?:-?(flash|pro|f|p))?$/.exec(model)
  if (deep) {
    const variant = deep[2]
    return `deepseek-v${deep[1]}${variant ? (variant.startsWith('f') ? '-flash' : '-pro') : ''}`
  }
  const gpt = /^(?:gpt-?)?(\d+(?:\.\d+)?)-?(astra|as|sol|terra|luna)$/.exec(model)
  if (gpt) return `gpt-${gpt[1]}-${gpt[2] === 'as' ? 'astra' : gpt[2]}`

  const glm = /^glm-?(\d+(?:\.\d+)?)-?(flash|f|air)$/.exec(model)
  if (glm) return `glm-${glm[1]}-${glm[2] === 'f' ? 'flash' : glm[2]}`

  const qwen = /^qwen-?(\d+(?:\.\d+)?)-?(max|plus|flash|f)$/.exec(model)
  if (qwen) return `qwen${qwen[1]}-${qwen[2] === 'f' ? 'flash' : qwen[2]}`

  return model
    .replace(/^grok(?=\d)/, 'grok-')
    .replace(/^kimik(?=\d)/, 'kimi-k')
    .replace(/^nemotron(?=\d)/, 'nemotron-')
}

const vendorNamespacePrefix = /^(?:(?:us|eu|apac|global)\.)?(amazon|meta|mistral|ai21|cohere)\./

function normalizedModelLabel(id: string | null | undefined): string {
  return (
    id
      ?.toLowerCase()
      .split('/')
      .at(-1)
      ?.trim()
      .replace(vendorNamespacePrefix, '')
      .replace(/[\s_]+/g, '-') ?? ''
  )
}

export function getModelVendorGuide(id: string): { vendor: string; overview: string } | undefined {
  const normalized = id.toLowerCase().trim()
  const parts = normalized.split('/')
  const namespace = parts.length > 1 ? parts.at(-2) : vendorNamespacePrefix.exec(normalized)?.[1]
  const label = normalizedModelLabel(id)
  const model = expandModelShorthand(label)
  const matched =
    modelVendorGuides.find(([, family]) => family.test(model)) ??
    modelVendorGuides.find(([, , provider]) => namespace && provider.test(namespace))
  return matched ? { vendor: matched[0], overview: matched[3] } : undefined
}

export function getModelRoleGuide(
  id: string | null | undefined,
  language: 'zh' | 'en',
  includeVendorFallback = true,
): { main: string; evaluator: string } | undefined {
  const label = normalizedModelLabel(id)
  if (!label) return undefined
  const model = expandModelShorthand(label)
  const supplemental: Localized | undefined =
    /(?:^|-)(?:embed(?:ding)?|rerank(?:er)?|reward|tts|asr|guard|moderation)(?:-|$)/.test(model)
      ? undefined
      : publicModelFamilies.find(([pattern]) => pattern.test(model))?.[1]
  const entry = exact.get(model) ?? families.find(([pattern]) => pattern.test(model))?.[1] ?? supplemental
  if (!entry || (!includeVendorFallback && entry.vendorOnly)) return undefined
  const [main, evaluator] = entry[language]
  return { main, evaluator }
}
