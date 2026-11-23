// Generic public model families, not a snapshot of any user's providers or models.
// The first match wins, so specific variants precede their broader families.
export const publicModelFamilies = [
  [
    /^glm-(?:\d+(?:\.\d+)?-)?(?:flash|air)\b/,
    {
      zh: ['GLM 轻量系列：适合日常改动、中文摘要和信息整理。', '适合快速判断明确的中文需求和小范围修改。'],
      en: [
        'Lightweight GLM variants for routine edits, Chinese summaries, and extraction.',
        'Quickly assess clearly stated Chinese requests and scoped edits.',
      ],
    },
  ],
  [
    /^glm-(?:\d|z1\b)/,
    {
      vendorOnly: true,
      zh: ['GLM 通用系列：适合中文研发、代码分析和多步骤工具任务。', '适合复核多模块改动和中文需求中的隐含约束。'],
      en: [
        'General GLM family for Chinese-language development, code analysis, and multi-step tool workflows.',
        'Recheck cross-module work and implicit constraints in Chinese requests.',
      ],
    },
  ],
  [
    /^qwen[0-9.]*-coder\b/,
    {
      zh: ['Qwen Coder：面向代码生成、跨文件修改和工具协作。', '适合识别代码任务涉及的文件、验证步骤和改动边界。'],
      en: [
        'Coding-focused model for generation, cross-file edits, and tool workflows.',
        'Assess file scope, verification steps, and change boundaries.',
      ],
    },
  ],
  [
    /^qwen[0-9.]*-max\b/,
    {
      zh: ['Qwen Max：适合复杂推理、跨模块开发和多步骤交付。', '适合复核约束多、返工代价高的任务。'],
      en: [
        'Qwen Max for complex reasoning, cross-module development, and multi-step delivery.',
        'Recheck work with multiple constraints or high rework costs.',
      ],
    },
  ],
  [
    /^qwen[0-9.]*-(?:flash|turbo)\b/,
    {
      zh: ['Qwen 轻量系列：适合摘要、结构化提取和批量小任务。', '适合低延迟筛分简单任务和常规任务。'],
      en: [
        'Lightweight Qwen models for summaries, extraction, and small batch tasks.',
        'Use for low-latency triage of simple and routine requests.',
      ],
    },
  ],
  [
    /^qwen(?:[0-9.]+|-(?:plus|vl)\b)/,
    {
      vendorOnly: true,
      zh: ['Qwen 通用系列：适合多语言写作、常规开发和信息整理。', '适合按目标、步骤和验收条件判断任务范围。'],
      en: [
        'General Qwen family for multilingual writing, routine development, and information processing.',
        'Assess scope from goals, steps, and acceptance criteria.',
      ],
    },
  ],
  [
    /^mistral-large-(?:4(?:[.-]0)?|2610)(?:$|-[a-z])/,
    {
      zh: ['Mistral Large 4：适合复杂编码、长材料分析和多模态任务。', '适合复核多约束任务；Agnes 只评估文字。'],
      en: [
        'Mistral Large 4 for complex coding, long documents, and multimodal work.',
        'Recheck work with multiple constraints; Agnes assesses text only.',
      ],
    },
  ],
  [
    /^mistral-small-(?:4(?:[.-]0)?|2603)(?:$|-[a-z])/,
    {
      zh: ['Mistral Small 4：兼顾指令跟随、推理和编码，适合日常任务。', '适合对常规请求做快速分档。'],
      en: [
        'Mistral Small 4 combines instruction following, reasoning, and coding for everyday work.',
        'Quickly classify routine requests.',
      ],
    },
  ],
  [
    /^mistral-(?:large|small)\b/,
    {
      vendorOnly: true,
      zh: ['Mistral 通用系列：适合多语言写作、日常编码和材料整理。', '适合判断任务范围；具体能力按型号区分。'],
      en: [
        'General Mistral models for multilingual writing, coding, and document work.',
        'Assess scope; capabilities vary by model.',
      ],
    },
  ],
  [
    /^llama-4-(?:scout|maverick)\b/,
    {
      zh: ['Llama 4 系列：适合多语言长材料分析、图文理解和通用任务。', '适合结合文字描述判断材料规模和推理步骤。'],
      en: [
        'Llama 4 for multilingual document analysis, visual understanding, and general tasks.',
        'Assess the amount of material and reasoning from the task text.',
      ],
    },
  ],
  [
    /^llama-?[0-9]/,
    {
      vendorOnly: true,
      zh: [
        'Llama 通用系列：适合指令任务、摘要和内容整理，能力随型号变化。',
        '适合评估描述明确的常规任务，先按型号验证效果。',
      ],
      en: [
        'General Llama models for instruction tasks, summaries, and organization; capabilities vary by model.',
        'Assess well-scoped routine requests after validating the selected model.',
      ],
    },
  ],
  [
    /^minimax-m\d+(?:\.\d+)?-(?:flash|highspeed)\b/,
    {
      zh: ['MiniMax M 快速型号：适合日常编码和需要短等待的工具流程。', '适合快速区分小改动和常规任务。'],
      en: [
        'Fast MiniMax M variants for everyday coding and latency-sensitive tool workflows.',
        'Quickly separate small edits from routine work.',
      ],
    },
  ],
  [
    /^minimax-m\d+\b/,
    {
      zh: [
        'MiniMax M 系列：适合持续编码、多步骤工具调用和复杂任务。',
        '适合复核多阶段任务的依赖、执行范围和验证步骤。',
      ],
      en: [
        'MiniMax M family for sustained coding, multi-step tool use, and complex tasks.',
        'Recheck dependencies, scope, and validation steps in multi-stage work.',
      ],
    },
  ],
  [
    /^(?:nvidia-)?nemotron-3[.-]5-super-vl\b/,
    {
      zh: [
        'Nemotron 3.5 Super VL：面向文档、图表理解和带工具的多模态任务。',
        '适合根据文字判断文档或图表任务的依赖；不会读取附件。',
      ],
      en: [
        'Nemotron 3.5 Super VL for documents, charts, and multimodal tool workflows.',
        'Assess document or chart dependencies from text; attachments are not used.',
      ],
    },
  ],
  [
    /^(?:nvidia-)?nemotron-3[.-]5-lightning\b/,
    {
      zh: ['Nemotron 3.5 Lightning：面向低延迟的专项执行和多步骤工具工作。', '适合快速判断工具任务的步骤数和依赖。'],
      en: [
        'Nemotron 3.5 Lightning for low-latency specialized execution and multi-step tools.',
        'Quickly assess tool steps and dependencies.',
      ],
    },
  ],
  [
    /^(?:nvidia-)?nemotron-3-nano\b/,
    {
      zh: ['Nemotron 3 Nano：面向高效执行，适合边界明确的工具任务。', '适合快速评估流程清晰、范围明确的请求。'],
      en: [
        'Nemotron 3 Nano for efficient execution of scoped tool workflows.',
        'Quickly assess clear, bounded requests.',
      ],
    },
  ],
  [
    /^(?:nvidia-)?nemotron-3(?:[.-]5)?\b/,
    {
      vendorOnly: true,
      zh: ['Nemotron 系列：面向智能体推理、长流程和工具协作。', '适合复核长任务的步骤、依赖和检查点。'],
      en: [
        'Nemotron family for agentic reasoning and long tool workflows.',
        'Recheck steps, dependencies, and checkpoints in long requests.',
      ],
    },
  ],
  [
    /^command-a(?:\b|\+)/,
    {
      zh: [
        'Cohere Command A 系列：适合知识库问答、检索增强和多语言工具流程。',
        '适合判断任务是否需要检索证据、跨文档核对或工具。',
      ],
      en: [
        'Cohere Command A family for knowledge-base Q&A, retrieval, and multilingual tools.',
        'Assess whether a request needs retrieval, cross-document checks, or tool use.',
      ],
    },
  ],
  [
    /^jamba(?:\b|[0-9])/,
    {
      zh: ['AI21 Jamba：适合长文本、企业文档整理和多材料问答。', '适合按资料量、交叉核对和输出要求判断范围。'],
      en: [
        'AI21 Jamba for long documents, enterprise text, and multi-source Q&A.',
        'Assess the amount of material, cross-checking, and output requirements.',
      ],
    },
  ],
  [
    /^phi-?\d/,
    {
      zh: ['Microsoft Phi：紧凑模型，适合摘要、提取和范围明确的推理。', '适合做轻量文本初筛，复杂约束需复核。'],
      en: [
        'Compact Microsoft Phi models for summaries, extraction, and scoped reasoning.',
        'Use for light text triage; recheck complex constraints.',
      ],
    },
  ],
  [
    /^mai-\d/,
    {
      zh: ['Microsoft MAI 文本系列：适合通用问答、写作和信息整理。', '适合按照请求目标和步骤判断常规任务范围。'],
      en: [
        'Microsoft MAI text family for general Q&A, writing, and organization.',
        'Assess routine requests from their goals and steps.',
      ],
    },
  ],
  [
    /^nova-(?:2-)?(?:lite|micro)\b/,
    {
      zh: ['Amazon Nova 轻量型号：适合文档处理和明确的自动化任务。', '适合快速判断文档或自动化请求的复杂度。'],
      en: [
        'Lightweight Amazon Nova models for document processing and scoped automation.',
        'Quickly assess document or automation requests.',
      ],
    },
  ],
  [
    /^nova-(?:2-)?(?:pro|premier)\b/,
    {
      zh: ['Amazon Nova 高阶型号：适合多步骤工作、文档分析和工具协作。', '适合复核复杂流程的材料、依赖和检查点。'],
      en: [
        'Higher-tier Amazon Nova models for multi-step work, documents, and tools.',
        'Recheck evidence, dependencies, and checkpoints in complex workflows.',
      ],
    },
  ],
  [
    /^granite-.*\bcode\b/,
    {
      zh: ['IBM Granite Code：面向代码解释、生成和转换。', '适合判断代码变更范围和所需验证。'],
      en: [
        'IBM Granite Code for code explanation, generation, and conversion.',
        'Assess code scope and validation needs.',
      ],
    },
  ],
  [
    /^granite-[0-9]/,
    {
      zh: ['IBM Granite 通用系列：适合企业文本、指令任务和信息整理。', '适合评估文档处理及结构化输出的复杂度。'],
      en: [
        'IBM Granite for enterprise text, instruction following, and information processing.',
        'Assess document and structured-output complexity.',
      ],
    },
  ],
  [
    /^sonar\b/,
    {
      zh: [
        'Perplexity Sonar：面向搜索增强的研究、事实核对和带引用的回答。',
        '适合判断任务是否依赖最新资料和多来源证据。',
      ],
      en: [
        'Perplexity Sonar for search-grounded research, fact checks, and cited answers.',
        'Assess whether a task depends on current information and multiple sources.',
      ],
    },
  ],
  [
    /^ernie-(?:[0-9]|lite\b|speed\b|x1\b)/,
    {
      zh: ['百度文心 ERNIE：适合中文写作、材料梳理和多步骤问答。', '适合判断中文需求中的约束、资料量和推理步骤。'],
      en: [
        'Baidu ERNIE for Chinese writing, document work, and multi-step Q&A.',
        'Assess constraints, source material, and reasoning steps in Chinese requests.',
      ],
    },
  ],
  [
    /^(?:hunyuan-(?:[0-9]|standard\b|turbo\b|lite\b|t1\b|a13b\b)|hy3-preview\b)/,
    {
      zh: ['腾讯混元：适合中文业务任务、长材料分析和通用工具流程。', '适合按资料范围和步骤判断中文请求难度。'],
      en: [
        'Tencent Hunyuan for Chinese business tasks, long documents, and general tool workflows.',
        'Assess Chinese requests by document scope and required steps.',
      ],
    },
  ],
  [
    /^doubao-(?:seed-|pro-|lite-)?[0-9]/,
    {
      zh: ['豆包通用系列：适合中文对话、内容整理和多步骤工作。', '适合从文字目标、约束和工具依赖判断任务范围。'],
      en: [
        'Doubao general models for Chinese dialogue, content work, and multi-step requests.',
        'Assess scope from goals, constraints, and tool dependencies.',
      ],
    },
  ],
  [
    /^step-?[0-9]/,
    {
      zh: ['阶跃 Step 系列：适合编码、推理和多步骤任务，能力随型号变化。', '适合判断长请求的依赖、步骤和验收条件。'],
      en: [
        'StepFun Step models for coding, reasoning, and multi-step work; capabilities vary by variant.',
        'Assess dependencies, steps, and acceptance criteria in longer requests.',
      ],
    },
  ],
  [
    /^mimo-v[0-9]/,
    {
      zh: ['小米 MiMo：面向编程、推理和需要工具协作的任务。', '适合判断明确的代码任务及多步骤执行范围。'],
      en: [
        'Xiaomi MiMo for coding, reasoning, and tool workflows.',
        'Assess scoped coding work and multi-step execution.',
      ],
    },
  ],
] as const
