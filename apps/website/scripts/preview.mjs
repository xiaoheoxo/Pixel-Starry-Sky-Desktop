// 本机预览构建结果：按线上的地址前缀出文件（/download/ → dist/），只监听 127.0.0.1。
// 用法：node apps/website/scripts/preview.mjs [--port 8765] [--base /download/]
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const args = process.argv.slice(2)
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt)
const port = Number(opt('--port', 8765))
const base = opt('--base', '/download/')
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

if (!existsSync(dist)) throw new Error('还没构建：先运行 node apps/website/scripts/build.mjs')

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (path === '/' || path === base.slice(0, -1)) return res.writeHead(308, { Location: base }).end()
  if (!path.startsWith(base)) return res.writeHead(404).end('not found')
  let file = normalize(join(dist, path.slice(base.length)))
  if (file !== dist && !file.startsWith(dist + sep)) return res.writeHead(403).end()
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!path.endsWith('/')) return res.writeHead(308, { Location: path + '/' }).end()
    file = join(file, 'index.html')
  }
  if (!existsSync(file)) return res.writeHead(404).end('not found')
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  })
  createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => console.log(`[website] http://127.0.0.1:${port}${base}`))
