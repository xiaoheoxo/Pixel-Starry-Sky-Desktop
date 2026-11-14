// agy acp --login（终端粘贴授权码登录，docs/antigravity-engine.md §10）的输出识别：
//   Open this link in a browser to log in with Google:
//     https://accounts.google.com/o/oauth2/auth?...
//   Then paste the authorization code, or the full URL of the page you land on, and press Enter:
import { plainLine } from '../exec'

export function parseAgyLogin(raw: string): { url?: string; awaitingCode?: boolean } {
  const line = plainLine(raw)
  const out: { url?: string; awaitingCode?: boolean } = {}
  const url = /https:\/\/accounts\.google\.com\/\S+/.exec(line)?.[0]
  if (url) out.url = url
  if (/paste the authorization code/i.test(line)) out.awaitingCode = true
  return out
}
