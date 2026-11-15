// 查是哪些进程占着目录里的文件（只在 Windows 上）：用系统的 Restart Manager（rstrtmgr.dll），
// 资源管理器提示「文件被某某程序打开」用的也是它。它只认文件，进程的当前目录、目录句柄造成的占用查不出来。
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface DirHolder {
  pid: number
  name: string
}

/** 交给 Restart Manager 的文件数上限：5000 个冷启动时要 3～6 秒，按层级取 2000 个已经够覆盖浅层 */
const MAX_FILES = 2000
/** 列文件最多花的时间，和 PowerShell 的超时分开算 */
const LIST_MS = 2000
const TIMEOUT_MS = 8000

/**
 * 按目录层级从浅到深取文件，取够就停：开着的多半在浅层（build/libs 的 jar、run/logs 的日志、.gradle 的锁文件），
 * 按深度优先的遍历顺序取会先被 build/classes 里成千个 .class 占满。不跟随符号链接。
 */
export async function shallowFiles(dir: string, max = MAX_FILES, budgetMs = LIST_MS): Promise<string[]> {
  const end = Date.now() + budgetMs
  const files: string[] = []
  for (let level = [dir]; level.length && Date.now() < end; ) {
    const next: string[] = []
    for (const d of level) {
      const entries = await readdir(d, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (e.isDirectory()) next.push(join(d, e.name))
        else if (e.isFile() && files.push(join(d, e.name)) >= max) return files
      }
      if (Date.now() >= end) break
    }
    level = next
  }
  return files
}

// 文件列表从标准输入传进来（一行一个，UTF-8），不拼进脚本文本
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$files = @([Console]::In.ReadToEnd() -split '\\r?\\n' | Where-Object { $_ })
if ($files.Count -eq 0) { exit 0 }
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class PixelSkyRm {
  [StructLayout(LayoutKind.Sequential)] struct UP { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME t; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PI { public UP p;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string app;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string svc; public int type; public int status; public int sess; public bool restart; }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int f, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint n, string[] files, uint a, IntPtr b, uint c, string[] d);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint need, ref uint n, [In, Out] PI[] list, ref uint reasons);
  public static int[] Who(string[] files) {
    uint h; var r = new List<int>();
    if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return r.ToArray();
    try {
      if (RmRegisterResources(h, (uint)files.Length, files, 0, IntPtr.Zero, 0, null) != 0) return r.ToArray();
      uint need = 0, n = 0, reasons = 0; RmGetList(h, out need, ref n, null, ref reasons);
      if (need == 0) return r.ToArray();
      var list = new PI[need]; n = need;
      if (RmGetList(h, out need, ref n, list, ref reasons) == 0) for (int i = 0; i < n; i++) r.Add(list[i].p.pid);
    } finally { RmEndSession(h); }
    return r.ToArray();
  }
}
'@
foreach ($id in [PixelSkyRm]::Who($files)) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p) { "$id\`t$($p.ProcessName).exe" } else { "$id\`t?" }
}
`

/** 解析脚本输出：每行「PID<Tab>程序名」，同一个 PID 只留一次 */
export function parseHolders(out: string): DirHolder[] {
  const seen = new Map<number, DirHolder>()
  for (const line of out.split(/\r?\n/)) {
    const [pid, name] = line.trim().split('\t')
    const id = Number(pid)
    if (Number.isInteger(id) && id > 0 && name && !seen.has(id)) seen.set(id, { pid: id, name })
  }
  return [...seen.values()]
}

/** 查不出来（不是 Windows、目录里没有文件、超时、PowerShell 不可用）时返回空列表，调用方回到通用提示 */
export async function dirHolders(dir: string): Promise<DirHolder[]> {
  if (process.platform !== 'win32') return []
  const files = await shallowFiles(dir)
  if (!files.length) return []
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
  return new Promise(done => {
    const child = execFile(
      ps,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 },
      (error, stdout) => done(error ? [] : parseHolders(stdout)),
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(files.join('\n'))
  })
}
