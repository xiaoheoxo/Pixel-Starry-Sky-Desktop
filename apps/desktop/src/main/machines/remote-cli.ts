import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib'

// 把像素星空命令行（packages/cli 打出来的 pixel-cli 目录，纯 JS、不分架构）打成一个包传到远程机器（SSH / WSL），
// 远程不需要 tar。这个文件只用 node 内置模块，不碰 Electron（remote-entry 也会引用路径校验），Electron 相关的找文件在 remote-cli-source.ts。

export type RemoteArch = 'x64' | 'arm64'
export interface RemoteCliArchive {
  /** gzip 后的整个包，哈希就是对它算的 */
  data: Buffer
  hash: string
}
export interface RemoteCliEntry {
  path: string
  size: number
  mode: number
}

/** 像素星空命令行要求的 Node 版本（Pi 的要求）；helper 本身只要 22，所以只有够新才下发命令行 */
export const REMOTE_CLI_NODE_MIN = [22, 19] as const
/** 解压后总大小上限，防止恶意或损坏的包把远程磁盘撑爆 */
export const REMOTE_CLI_MAX_BYTES = 200 * 1024 * 1024
/** 上传 + 解压 + 落盘比 helper 慢得多，单独给长超时 */
export const REMOTE_CLI_INSTALL_TIMEOUT = 5 * 60_000

const gzip = promisify(gzipCb)
const gunzip = promisify(gunzipCb)
const HASH = /^[a-f0-9]{64}$/
const ROOT = '/.local/share/pixelsky/remote/cli-'

export function remoteCliSupported(version: string | null | undefined, arch: unknown): arch is RemoteArch {
  if (arch !== 'x64' && arch !== 'arm64') return false
  const [major = 0, minor = 0] = (version ?? '').split('.').map(n => Number.parseInt(n, 10) || 0)
  return major > REMOTE_CLI_NODE_MIN[0] || (major === REMOTE_CLI_NODE_MIN[0] && minor >= REMOTE_CLI_NODE_MIN[1])
}

/** 远程上命令行入口应有的路径：<home>/.local/share/pixelsky/remote/cli-<64 位哈希>/pixel.mjs；hash 不给就只要求是 64 位十六进制 */
export function isRemoteCliEntry(path: string, home: string, hash?: string): boolean {
  const prefix = home + ROOT
  if (!path.startsWith(prefix) || !path.endsWith('/pixel.mjs')) return false
  const mid = path.slice(prefix.length, -'/pixel.mjs'.length)
  return hash ? mid === hash : HASH.test(mid)
}

async function walk(dir: string, rel: string, skip: (rel: string) => boolean, out: RemoteCliEntry[], bodies: Buffer[]) {
  const names = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const item of names) {
    const path = rel ? rel + '/' + item.name : item.name
    if (skip(path)) continue
    // 符号链接和其他特殊文件不打包
    if (item.isDirectory()) await walk(join(dir, item.name), path, skip, out, bodies)
    else if (item.isFile()) {
      const body = await readFile(join(dir, item.name))
      out.push({ path, size: body.length, mode: 0o644 })
      bodies.push(body)
    }
  }
}

/**
 * 打包：gzip( 4 字节大端头长度 + JSON 头 {files:[{path,size,mode}]} + 所有文件内容依次拼接 )。
 * cliDir 里的 bin/ 是宿主平台的二进制，不要；toolsDir 是 Linux 版 rg / fd（可选），放到包里的 bin/。
 */
export async function packRemoteCli(cliDir: string, toolsDir: string | null): Promise<RemoteCliArchive> {
  const files: RemoteCliEntry[] = []
  const bodies: Buffer[] = []
  await walk(cliDir, '', rel => rel === 'bin', files, bodies)
  if (!files.some(f => f.path === 'pixel.mjs')) throw new Error('REMOTE_CLI_MISSING')
  if (toolsDir) {
    const tools: RemoteCliEntry[] = []
    const toolBodies: Buffer[] = []
    await walk(toolsDir, 'bin', () => false, tools, toolBodies)
    tools.forEach((entry, i) => {
      // 只有顶层的 rg / fd 要可执行；licenses/ 下的是文本
      if (entry.path === 'bin/rg' || entry.path === 'bin/fd') entry.mode = 0o755
      files.push(entry)
      bodies.push(toolBodies[i])
    })
  }
  const head = Buffer.from(JSON.stringify({ files }), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(head.length)
  const data = await gzip(Buffer.concat([length, head, ...bodies]))
  return { data, hash: createHash('sha256').update(data).digest('hex') }
}

/** 和远程安装脚本对应的解包（给测试和排查用；远程跑的是下面的脚本，不是这个函数） */
export async function unpackRemoteCli(data: Buffer): Promise<Array<RemoteCliEntry & { body: Buffer }>> {
  const raw = await gunzip(data, { maxOutputLength: REMOTE_CLI_MAX_BYTES })
  const length = raw.readUInt32BE(0)
  const head = JSON.parse(raw.subarray(4, 4 + length).toString('utf8')) as { files: RemoteCliEntry[] }
  let offset = 4 + length
  return head.files.map(entry => {
    const body = raw.subarray(offset, offset + entry.size)
    offset += entry.size
    return { ...entry, body }
  })
}

/** 别的版本的命令行目录多久没用过才删 */
export const REMOTE_CLI_KEEP_MS = 7 * 24 * 3600 * 1000

function assertHash(hash: string): void {
  if (!HASH.test(hash)) throw new Error('REMOTE_CLI_INVALID_HASH')
}

// 下面两个 node -e 脚本要能经 wsl.exe 的命令行转义：只用单引号，不用模板字符串，不含双引号、$、反引号、百分号、反斜杠、换行
// （反斜杠用 String.fromCharCode(92) 代替）。SSH 那边整个脚本再用 quoteSh 包一层。哈希是十六进制，嵌入单引号里安全。

/**
 * 已装好（.complete 和 pixel.mjs 都在）就输出 pixel.mjs 的路径，否则什么都不输出。
 * 用到时顺手更新 .complete 的修改时间：别的桌面版本安装时据此判断这个目录还有没有人用
 */
export function remoteCliCheckScript(hash: string): string {
  assertHash(hash)
  return (
    "const fs=require('node:fs'),p=require('node:path');" +
    "const d=p.join(require('node:os').homedir(),'.local','share','pixelsky','remote','cli-" +
    hash +
    "');const m=p.join(d,'pixel.mjs');" +
    "const k=p.join(d,'.complete');" +
    'if(fs.existsSync(k)&&fs.existsSync(m)){try{const t=new Date();fs.utimesSync(k,t,t)}catch(e){}process.stdout.write(m)}'
  )
}

/** 从 stdin 读包：校验哈希（不符退出码 2）、限制解压大小、拒绝危险路径（退出码 3）、写临时目录再改名，最后输出 pixel.mjs 路径 */
export function remoteCliInstallScript(hash: string): string {
  assertHash(hash)
  return (
    "const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'),z=require('node:zlib'),os=require('node:os');" +
    "const b=[];process.stdin.on('data',x=>b.push(x));" +
    "process.stdin.on('end',()=>{const data=Buffer.concat(b);" +
    "if(c.createHash('sha256').update(data).digest('hex')!=='" +
    hash +
    "')process.exit(2);" +
    "const root=p.join(os.homedir(),'.local','share','pixelsky','remote');" +
    "const fin=p.join(root,'cli-" +
    hash +
    "');const main=p.join(fin,'pixel.mjs');" +
    "const done=()=>fs.existsSync(p.join(fin,'.complete'))&&fs.existsSync(main);" +
    'if(done()){process.stdout.write(main);return}' +
    "const tmp=fin+'.tmp-'+process.pid;" +
    'try{' +
    'const raw=z.gunzipSync(data,{maxOutputLength:' +
    REMOTE_CLI_MAX_BYTES +
    '});' +
    "const n=raw.readUInt32BE(0);const head=JSON.parse(raw.subarray(4,4+n).toString('utf8'));" +
    'let off=4+n;const bs=String.fromCharCode(92);' +
    'fs.rmSync(tmp,{recursive:true,force:true});fs.mkdirSync(tmp,{recursive:true,mode:448});' +
    'for(const f of head.files){' +
    "if(typeof f.path!=='string'||!f.path||f.path.startsWith('/')||f.path.includes(bs)||f.path.split('/').some(s=>!s||s==='.'||s==='..'))" +
    "throw new Error('bad path');" +
    "if(!Number.isInteger(f.size)||f.size<0||off+f.size>raw.length)throw new Error('bad size');" +
    "const file=p.join(tmp,...f.path.split('/'));fs.mkdirSync(p.dirname(file),{recursive:true,mode:448});" +
    'fs.writeFileSync(file,raw.subarray(off,off+f.size),{mode:f.mode&511});fs.chmodSync(file,f.mode&511);off+=f.size}' +
    "fs.writeFileSync(p.join(tmp,'.complete'),'');" +
    'try{fs.renameSync(tmp,fin)}catch(e){' +
    // 并发的另一个安装先到了就直接用；留下的是没装完的残骸就清掉重来一次
    'if(!done()){fs.rmSync(fin,{recursive:true,force:true});fs.renameSync(tmp,fin)}}' +
    '}catch(e){fs.rmSync(tmp,{recursive:true,force:true});' +
    "process.stderr.write(String(e&&e.message));process.exit(String(e&&e.message)==='bad path'?3:1)}" +
    'fs.rmSync(tmp,{recursive:true,force:true});' +
    // 旧版本目录尽力删，但只删 7 天没用过的（.complete 的修改时间，检查时会更新）：同一台机器上可能有别的桌面版本在用；
    // 别人还在装的临时目录（十分钟内改过）不动
    'try{for(const e of fs.readdirSync(root)){' +
    "if(!e.startsWith('cli-')||e==='cli-" +
    hash +
    "')continue;const q=p.join(root,e);" +
    "if(e.includes('.tmp-')){if(Date.now()-fs.statSync(q).mtimeMs<600000)continue}" +
    "else{let used=fs.statSync(q).mtimeMs;try{used=fs.statSync(p.join(q,'.complete')).mtimeMs}catch(e4){}" +
    'if(Date.now()-used<' +
    REMOTE_CLI_KEEP_MS +
    ')continue}' +
    'try{fs.rmSync(q,{recursive:true,force:true})}catch(e2){}}}catch(e3){}' +
    'process.stdout.write(main)})'
  )
}
