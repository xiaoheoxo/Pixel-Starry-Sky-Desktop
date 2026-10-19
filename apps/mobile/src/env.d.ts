/// <reference types="vite/client" />

/** 构建号（vite.config.ts 的 define 编进页面）：时间 + git 短哈希；dist/version.json 里是同一个值 */
declare const __BUILD_ID__: string
