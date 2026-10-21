// 官网的纯函数（不碰页面）：安装包识别、大小、更新说明的 Markdown。
// 浏览器里由构建脚本和 i18n.js、site.js 拼成一个文件；测试在 node:vm 里加载，取 globalThis.PSLib。
;(root => {
  /** 各系统的安装包，按文件名认（electron-builder 的 artifactName，见 apps/desktop/electron-builder.yml） */
  const PLATFORMS = {
    win: { icon: 'win', zh: 'Windows', en: 'Windows', match: /setup\.exe$/ },
    'mac-arm': { icon: 'apple', zh: 'macOS · Apple 芯片', en: 'macOS · Apple silicon', match: /mac-arm64\.dmg$/ },
    'mac-x64': { icon: 'apple', zh: 'macOS · Intel', en: 'macOS · Intel', match: /mac-x64\.dmg$/ },
    appimage: { icon: 'linux', zh: 'Linux · AppImage', en: 'Linux · AppImage', match: /\.AppImage$/ },
    deb: { icon: 'linux', zh: 'Linux · deb（Ubuntu / Debian）', en: 'Linux · deb (Ubuntu / Debian)', match: /\.deb$/ },
  }

  /**
   * 访问者的系统。浏览器不直接告诉 Mac 的芯片：看显卡名字，Intel / AMD 的是 Intel Mac，其余（Apple、看不出来）按 Apple 芯片。
   * @param {{ platform?: string, userAgent?: string, renderer?: string }} env
   */
  function detect(env) {
    const ua = env.userAgent || '',
      p = env.platform || ''
    if (/Win/i.test(p) || /Windows/i.test(ua)) return 'win'
    if (/Android|iPhone|iPad/i.test(ua)) return 'win'
    if (/Mac/i.test(p) || /Mac OS X/.test(ua))
      return env.renderer && /Intel|AMD|Radeon/i.test(env.renderer) ? 'mac-x64' : 'mac-arm'
    if (/Linux|X11/i.test(p + ua)) return 'appimage'
    return 'win'
  }

  /** 某一版里某个系统的安装包：[文件名, 字节数]，没有时 undefined */
  const fileOf = (rel, key) => rel.assets.find(([n]) => PLATFORMS[key].match.test(n))

  const mb = n => `${Math.round(n / 1048576)} MB`

  /** GitHub API 的 releases 列表 → 页面用的精简结构（去掉草稿、预发布、blockmap / 更新清单） */
  const fromGitHub = list =>
    list
      .filter(r => !r.draft && !r.prerelease)
      .map(r => ({
        tag: r.tag_name,
        date: (r.published_at || '').slice(0, 10),
        body: r.body || '',
        assets: (r.assets || []).filter(a => !/\.(blockmap|yml)$/.test(a.name)).map(a => [a.name, a.size]),
      }))

  /** 首页顶部小标签：更新说明里第一条加粗的要点（「新功能」下的第一条），去掉末尾标点；没有时 null */
  function headline(body) {
    const m = /^\s*[-*]\s+\*\*(.+?)\*\*/m.exec(body || '')
    return m ? m[1].replace(/[：:，,。.]+$/, '') : null
  }

  /** 更新说明的 Markdown：只认这几种（## 标题、- 列表含两级、**粗体**、`代码`），其余按段落，全部先转义 */
  function md(src) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const inline = s =>
      esc(s)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
    let html = '',
      depth = 0
    for (const line of (src || '').split(/\r?\n/)) {
      const h = /^#{1,4}\s+(.*)/.exec(line)
      const li = /^(\s*)[-*]\s+(.*)/.exec(line)
      if (h || (!li && line.trim())) {
        html += '</ul>'.repeat(depth)
        depth = 0
        html += h ? `<h2>${inline(h[1])}</h2>` : `<p>${inline(line)}</p>`
      } else if (li) {
        const d = li[1].length >= 2 ? 2 : 1
        if (depth < d) html += '<ul>'.repeat(d - depth)
        if (depth > d) html += '</ul>'.repeat(depth - d)
        depth = d
        html += `<li>${inline(li[2])}</li>`
      }
    }
    html += '</ul>'.repeat(depth)
    return html
  }

  root.PSLib = { PLATFORMS, detect, fileOf, mb, fromGitHub, headline, md }
})(globalThis)
