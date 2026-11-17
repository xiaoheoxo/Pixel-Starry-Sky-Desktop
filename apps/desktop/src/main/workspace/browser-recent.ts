// 内置浏览器的最近地址（docs/ui/browser-v2.md §3.1 地址栏下拉）：每个工作区记最近打开过的几个，新的在前

export const RECENT_MAX = 8

/** 把 url 放到最前面；去掉重复（不管结尾斜杠和 #后面）；只记 http / https / file */
export function pushRecent(list: readonly string[] | undefined, url: string, max = RECENT_MAX): string[] {
  const prior = list ?? []
  if (!/^(https?|file):/i.test(url)) return [...prior]
  const key = recentKey(url)
  return [url, ...prior.filter(u => recentKey(u) !== key)].slice(0, max)
}

const recentKey = (url: string): string => url.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase()
