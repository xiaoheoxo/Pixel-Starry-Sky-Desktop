// app-fixtures.test.ts 用到的几个 Node 接口。包本身不带 Node 类型（src/globals.d.ts），这里只声明用到的部分
declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options: { recursive: true }): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function writeFileSync(path: string, data: string): void
}
declare module 'node:path' {
  export function dirname(path: string): string
  export function join(...parts: string[]): string
}
declare module 'node:url' {
  export function fileURLToPath(url: string): string
}
declare module 'node:zlib' {
  export function deflateRawSync(data: Uint8Array): Uint8Array
  export function inflateRawSync(data: Uint8Array, options?: { maxOutputLength?: number }): Uint8Array
}
interface ImportMeta {
  readonly url: string
}
declare const process: { readonly env: Record<string, string | undefined> }
