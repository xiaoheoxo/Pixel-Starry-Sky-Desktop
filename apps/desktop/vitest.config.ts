import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 测试与构建用同一个 `@` 别名（electron.vite.config.ts 的 renderer.resolve.alias）
export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src/renderer/src') },
  },
  test: { setupFiles: [resolve(__dirname, 'vitest.setup.ts')] },
})
