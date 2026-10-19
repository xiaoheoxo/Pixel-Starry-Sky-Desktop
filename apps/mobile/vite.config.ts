// 手机端网页版（docs/mobile-remote.md §8）。线上放在云端服务的 /m/ 下，和中转同源；
// 本机开发时 /v1/bridge 由这里转给本机云端服务（MOBILE_CLOUD，默认 http://127.0.0.1:9080），手机连电脑的局域网地址打开。
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const cloud = process.env.MOBILE_CLOUD ?? 'http://127.0.0.1:9080'

/** 构建号：时间（UTC，到分）+ git 短哈希，例如 202610171530-ab12cd3。每次构建一个，编进页面，也写进 dist/version.json */
function makeBuildId(): string {
  const time = new Date().toISOString().replace(/\D/g, '').slice(0, 12)
  let hash = 'nogit'
  try {
    hash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // 不在 git 仓库里：只用时间
  }
  return `${time}-${hash}`
}
const buildId = makeBuildId()

/** dist/version.json：{"build": 构建号}。页面定时取它，和编进页面的构建号不一样就提示刷新（src/platform/version.ts）。上线时要和 index.html 一起换 */
function versionFile(): Plugin {
  return {
    name: 'pixelsky-version-file',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: buildId }) + '\n' })
    },
  }
}

// App（Capacitor）里页面从根路径加载：`vite build --mode app`
export default defineConfig(({ mode }) => ({
  base: mode === 'app' ? '/' : '/m/',
  plugins: [react(), tailwindcss(), versionFile()],
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  server: {
    port: 5173,
    // 不改 Host：中转按 Origin 和 Host 同源放行网页的 WebSocket
    proxy: { '/v1/bridge': { target: cloud, ws: true, changeOrigin: false } },
  },
  build: { outDir: 'dist', target: 'es2022' },
}))
