// 界面默认语言跟着系统走（D330），测试按中文断言：固定成中文，不随跑测试的机器（CI 是英文系统）变
Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
Object.defineProperty(globalThis.navigator, 'languages', { value: ['zh-CN'], configurable: true })
