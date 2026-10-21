// 官网的页面脚本（四个页面共用）：中英切换、深浅色、下载按钮、版本列表、动效。
// 构建时和 lib.js、i18n.js 拼在一起；顶栏、页脚、图标、兜底版本数据由构建写进 HTML（scripts/build.mjs）。
;(() => {
  const { PLATFORMS, detect, fileOf, mb, fromGitHub, headline, md } = globalThis.PSLib
  const { EN, FAQ } = globalThis.PSText
  const REPO = 'xiaoheoxo/Pixel-Starry-Sky-Desktop'
  const GH = `https://github.com/${REPO}`
  const $ = s => document.querySelector(s)
  const $$ = s => [...document.querySelectorAll(s)]
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
  const PAGE = document.body.dataset.page
  const BASE = document.documentElement.dataset.base || '/'

  // ---------- 文案 ----------
  const ZH = {}
  $$('[data-i]').forEach(e => (ZH[e.dataset.i] = e.textContent))
  $$('[data-i-html]').forEach(e => (ZH[e.dataset.iHtml] = e.innerHTML))
  let lang = localStorage.getItem('ps-lang') || (/^zh/i.test(navigator.language) ? 'zh' : 'en')
  const t = k => (lang === 'en' ? (EN[k] ?? ZH[k]) : ZH[k])

  // ---------- 系统 ----------
  function renderer() {
    try {
      const gl = document.createElement('canvas').getContext('webgl')
      return gl && gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)
    } catch {
      return ''
    }
  }
  const ua = navigator.userAgent
  const platform = navigator.userAgentData?.platform || navigator.platform || ''
  const mine = detect({ userAgent: ua, platform, renderer: /Mac/i.test(platform + ua) ? renderer() : '' })

  // ---------- 版本：先用构建时写进页面的，再读 GitHub ----------
  let releases = []
  try {
    releases = JSON.parse($('#ps-releases')?.textContent || '[]')
  } catch {}
  let allVers = false
  const SHOW_VERS = 5
  const url = (tag, name) => `${GH}/releases/download/${tag}/${name}`
  const filesHtml = r =>
    Object.entries(PLATFORMS)
      .map(([k, p]) => {
        const x = fileOf(r, k)
        return x
          ? `<a href="${url(r.tag, x[0])}"><svg class="ico"><use href="#${p.icon}"/></svg>${p[lang]}<small>${mb(x[1])}</small></a>`
          : ''
      })
      .join('')

  function render() {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
    $$('[data-i]').forEach(e => (e.textContent = t(e.dataset.i)))
    $$('[data-i-html]').forEach(e => (e.innerHTML = t(e.dataset.iHtml)))
    $('#lang span').textContent = lang === 'en' ? '中文' : 'English'
    const rel = releases[0]
    const f = rel && fileOf(rel, mine)
    if (rel) $$('[data-ver]').forEach(e => (e.textContent = rel.tag))
    // 首页小标签：中文取更新说明第一条要点（说明只有中文），英文写「vX 更新了什么」
    if ($('#badge-text') && rel)
      $('#badge-text').textContent =
        lang === 'en' ? `What's new in ${rel.tag}` : headline(rel.body) || `${rel.tag} 更新了什么`
    // 下载按钮（顶栏的只写「下载」）
    for (const a of $$('.dl-btn')) {
      a.href = f ? url(rel.tag, f[0]) : `${GH}/releases/latest`
      a.querySelector('use').setAttribute('href', '#' + PLATFORMS[mine].icon)
      a.querySelector('.lbl').textContent =
        'short' in a.dataset
          ? lang === 'en'
            ? 'Download'
            : '下载'
          : (lang === 'en' ? 'Download for ' : '下载 ') + PLATFORMS[mine][lang] + (lang === 'en' ? '' : ' 版')
    }
    const other = lang === 'en' ? 'Other platforms' : '其他系统'
    const meta = rel ? `${rel.tag} · ${f ? mb(f[1]) + ' · ' : ''}${rel.date}` : ''
    if ($('#dl-meta')) {
      $('#dl-meta').innerHTML = `${meta}${meta ? ' · ' : ''}<a href="#" id="dl-other">${other}</a>`
      $('#dl-other').onclick = e => (e.preventDefault(), e.stopPropagation(), toggleMenu())
    }
    $$('.dl-meta-link').forEach(
      e => (e.innerHTML = `${meta}${meta ? ' · ' : ''}<a href="${BASE}changelog/">${other}</a>`),
    )
    if ($('#dl-menu') && rel)
      $('#dl-menu').innerHTML =
        `<div class="h">${rel.tag}</div>` +
        Object.entries(PLATFORMS)
          .map(([k, p], i) => {
            const x = fileOf(rel, k)
            const tag = k === mine ? `<em>${lang === 'en' ? 'Your system' : '你的系统'}</em>` : ''
            return x
              ? `<a role="menuitem" style="--i:${i}" href="${url(rel.tag, x[0])}"><svg class="ico"><use href="#${p.icon}"/></svg><span>${p[lang]}</span>${tag}<small>${mb(x[1])}</small></a>`
              : ''
          })
          .join('')
    // 更新说明页：最新一版完整显示，其余在下面的列表里
    if ($('#notes-body') && rel) {
      $('#notes-date').textContent = rel.date
      $('#notes-files').innerHTML = filesHtml(rel)
      $('#notes-body').innerHTML = md(rel.body)
    }
    if ($('#ver-list')) {
      const old = releases.slice(1)
      $('#ver-list').innerHTML = old
        .map(
          (r, i) =>
            `<details class="ver" style="--i:${Math.min(i, 6)}"${!allVers && i >= SHOW_VERS ? ' hidden' : ''}><summary><b>${r.tag}</b><span>${r.date}</span><svg class="ico"><use href="#down"/></svg></summary>` +
            `<div class="in"><div class="inner"><div class="files">${filesHtml(r)}</div><div class="md">${md(r.body)}</div></div></div></details>`,
        )
        .join('')
      $('#old-wrap').hidden = !old.length
      const hiddenN = allVers ? 0 : Math.max(0, old.length - SHOW_VERS)
      $('#ver-more').hidden = !hiddenN
      $('#ver-more span').textContent =
        lang === 'en' ? `Show ${hiddenN} older versions` : `显示更早的 ${hiddenN} 个版本`
    }
    if ($('#faq-list'))
      $('#faq-list').innerHTML = FAQ[lang]
        .map(
          ([q, a], i) =>
            `<details style="--i:${i}"><summary>${q}<svg class="ico"><use href="#plus"/></svg></summary><div class="a"><div>${a}</div></div></details>`,
        )
        .join('')
    requestAnimationFrame(() => moveInd(current))
  }

  // ---------- 其他系统菜单（首页） ----------
  function toggleMenu(force) {
    const m = $('#dl-menu')
    if (!m) return
    const open = force === undefined ? !m.classList.contains('open') : force
    m.classList.toggle('open', open)
    $('#dl-more').setAttribute('aria-expanded', String(open))
  }
  if ($('#dl-more')) $('#dl-more').onclick = e => (e.stopPropagation(), toggleMenu())
  document.addEventListener('click', e => !e.target.closest('#dl-menu') && toggleMenu(false))
  document.addEventListener(
    'keydown',
    e => e.key === 'Escape' && (toggleMenu(false), $('#nav').classList.remove('open')),
  )

  // ---------- 手机上的导航 ----------
  $('#burger').onclick = e => (e.stopPropagation(), $('#nav').classList.toggle('open'))
  document.addEventListener('click', e => !e.target.closest('#nav') && $('#nav').classList.remove('open'))

  // ---------- 展开收起：高度动画 ----------
  document.addEventListener('click', e => {
    const s = e.target.closest('details > summary')
    if (!s || reduce) return
    const d = s.parentElement,
      body = s.nextElementSibling
    if (!body) return
    e.preventDefault()
    if (d.dataset.anim) return
    d.dataset.anim = '1'
    const done = () => delete d.dataset.anim
    if (!d.open) {
      d.open = true
      const h = body.scrollHeight
      body.animate(
        [
          { height: '0px', opacity: 0 },
          { height: h + 'px', opacity: 1 },
        ],
        {
          duration: 420,
          easing: EASE,
        },
      ).onfinish = done
    } else {
      d.classList.add('closing')
      const a = body.animate(
        [
          { height: body.offsetHeight + 'px', opacity: 1 },
          { height: '0px', opacity: 0 },
        ],
        {
          duration: 300,
          easing: EASE,
        },
      )
      a.onfinish = () => ((d.open = false), d.classList.remove('closing'), done())
    }
  })
  if ($('#ver-more'))
    $('#ver-more').onclick = () => {
      allVers = true
      $('#ver-more').hidden = true
      $$('#ver-list > .ver[hidden]').forEach((el, i) => {
        el.hidden = false
        if (!reduce)
          el.animate(
            [
              { opacity: 0, transform: 'translateY(14px)' },
              { opacity: 1, transform: 'none' },
            ],
            {
              duration: 500,
              delay: i * 50,
              easing: EASE,
              fill: 'backwards',
            },
          )
      })
    }

  // ---------- 语言 ----------
  $('#lang').onclick = () => {
    lang = lang === 'en' ? 'zh' : 'en'
    localStorage.setItem('ps-lang', lang)
    if (document.startViewTransition && !reduce) document.startViewTransition(render)
    else render()
  }

  // ---------- 深浅色 ----------
  const dark = matchMedia('(prefers-color-scheme: dark)')
  function applyTheme() {
    const pick = localStorage.getItem('ps-theme') || (dark.matches ? 'dark' : 'light')
    document.documentElement.dataset.theme = pick
    $('#theme use').setAttribute('href', pick === 'dark' ? '#sun' : '#moon')
    $$('img[data-light]').forEach(img => (img.src = pick === 'dark' ? img.dataset.dark : img.dataset.light))
    skies.forEach(s => s.recolor())
  }
  $('#theme').onclick = e => {
    const flip = () => {
      localStorage.setItem('ps-theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
      applyTheme()
    }
    if (!document.startViewTransition || reduce) return flip()
    // 新画面从按钮处圆形展开
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX || r.left + r.width / 2,
      y = e.clientY || r.top + r.height / 2
    const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
    const root = document.documentElement
    root.classList.add('vt-theme')
    const vt = document.startViewTransition(flip)
    vt.ready.then(() =>
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
        { duration: 650, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
      ),
    )
    vt.finished.finally(() => root.classList.remove('vt-theme'))
  }
  dark.addEventListener('change', applyTheme)

  // ---------- 像素星空 ----------
  function starfield(cv) {
    const ctx = cv.getContext('2d'),
      dpr = Math.min(devicePixelRatio || 1, 2),
      density = +cv.dataset.density || 6000
    let w = 0,
      h = 0,
      stars = [],
      meteor = null,
      wait = 2500,
      on = false,
      raf = 0,
      last = 0,
      fg = '#fff',
      star = '#f0a764'
    const m = { x: 0, y: 0, tx: 0, ty: 0 }
    function resize() {
      const r = cv.getBoundingClientRect()
      w = r.width
      h = r.height
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      stars = Array.from({ length: Math.round((w * h) / density) }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        z: Math.random(),
        ph: Math.random() * 6.28,
        sp: 0.4 + Math.random() * 1.4,
        big: Math.random() < 0.045,
      }))
      draw(performance.now())
    }
    function recolor() {
      const cs = getComputedStyle(document.documentElement)
      fg = cs.getPropertyValue('--fg').trim()
      star = cs.getPropertyValue('--star').trim()
      draw(performance.now())
    }
    // 和 Logo 里那颗一样的四角星
    function sparkle(x, y, r) {
      ctx.beginPath()
      ctx.moveTo(x, y - r)
      ctx.quadraticCurveTo(x, y, x + r, y)
      ctx.quadraticCurveTo(x, y, x, y + r)
      ctx.quadraticCurveTo(x, y, x - r, y)
      ctx.quadraticCurveTo(x, y, x, y - r)
      ctx.fill()
    }
    function draw(now) {
      ctx.clearRect(0, 0, w, h)
      m.x += (m.tx - m.x) * 0.08
      m.y += (m.ty - m.y) * 0.08
      for (const s of stars) {
        const tw = reduce ? 0.7 : 0.5 + 0.5 * Math.sin(s.ph + (now / 1000) * s.sp)
        const x = s.x + m.x * s.z * 18,
          y = s.y + m.y * s.z * 18
        ctx.globalAlpha = s.big ? 0.45 + 0.55 * tw : (0.12 + 0.55 * tw) * (0.45 + s.z * 0.55)
        ctx.fillStyle = s.big ? star : fg
        if (s.big) sparkle(x, y, 2.5 + tw * 3)
        else {
          const n = s.z > 0.75 ? 2 : 1.5
          ctx.fillRect(Math.round(x), Math.round(y), n, n)
        }
      }
      if (meteor) {
        const d = meteor.life * 320,
          hx = meteor.x - d * 0.86,
          hy = meteor.y + d * 0.5
        const g = ctx.createLinearGradient(hx, hy, hx + 90 * 0.86, hy - 90 * 0.5)
        g.addColorStop(0, star)
        g.addColorStop(1, 'transparent')
        ctx.globalAlpha = Math.sin(meteor.life * Math.PI)
        ctx.strokeStyle = g
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(hx, hy)
        ctx.lineTo(hx + 90 * 0.86, hy - 90 * 0.5)
        ctx.stroke()
        ctx.fillStyle = star
        ctx.fillRect(Math.round(hx) - 1, Math.round(hy) - 1, 2.5, 2.5)
      }
      ctx.globalAlpha = 1
    }
    function frame(now) {
      raf = requestAnimationFrame(frame)
      const dt = now - last
      if (dt < 33) return // 30 帧够了
      last = now
      if (!meteor && (wait -= dt) < 0) {
        meteor = { x: w * (0.35 + Math.random() * 0.65), y: Math.random() * h * 0.35, life: 0 }
        wait = 4500 + Math.random() * 7000
      }
      if (meteor && (meteor.life += dt / 1000) >= 1) meteor = null
      draw(now)
    }
    // 离开视口、切到后台就停
    const start = () =>
      !on && !reduce && ((on = true), (last = performance.now()), (raf = requestAnimationFrame(frame)))
    const stop = () => on && ((on = false), cancelAnimationFrame(raf))
    new ResizeObserver(resize).observe(cv)
    new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? start() : stop())).observe(cv)
    document.addEventListener('visibilitychange', () =>
      document.hidden ? stop() : cv.getBoundingClientRect().bottom > 0 && start(),
    )
    addEventListener(
      'pointermove',
      e => ((m.tx = e.clientX / innerWidth - 0.5), (m.ty = e.clientY / innerHeight - 0.5)),
      {
        passive: true,
      },
    )
    return { recolor }
  }
  const skies = $$('canvas.stars').map(starfield)

  // ---------- 滚动：进度条、顶栏、大图放平、顶栏下载按钮、回到顶部 ----------
  let ticking = false
  const heroDl = $('#dl-main')
  function onScroll() {
    ticking = false
    const y = scrollY,
      max = document.documentElement.scrollHeight - innerHeight
    $('#progress').style.setProperty('--p', max > 0 ? (y / max).toFixed(4) : 0)
    $('#nav').classList.toggle('scrolled', y > 8)
    $('#totop').classList.toggle('show', y > innerHeight * 1.2)
    if (heroDl) $('.nav-dl').classList.toggle('show', heroDl.getBoundingClientRect().bottom < 64)
    if ($('#shot') && !reduce)
      $('#shot').style.setProperty('--tilt', (14 * (1 - Math.min(1, y / (innerHeight * 0.55)))).toFixed(2))
  }
  addEventListener('scroll', () => !ticking && ((ticking = true), requestAnimationFrame(onScroll)), { passive: true })
  addEventListener('resize', onScroll)
  $('#totop').onclick = () => scrollTo({ top: 0 })

  // ---------- 顶栏：当前页高亮，悬停时滑过去 ----------
  const links = $$('#links a'),
    ind = $('#links .ind')
  const current = links.find(a => a.dataset.to === PAGE) || null
  current?.classList.add('on')
  current?.setAttribute('aria-current', 'page')
  function moveInd(a) {
    if (!a) return (ind.style.opacity = 0)
    ind.style.opacity = 1
    ind.style.left = a.offsetLeft + 'px'
    ind.style.width = a.offsetWidth + 'px'
  }
  links.forEach(a => a.addEventListener('mouseenter', () => moveInd(a)))
  $('#links').addEventListener('mouseleave', () => moveInd(current))

  // ---------- 滚动到时淡入 ----------
  const seen = new IntersectionObserver(
    es =>
      es.forEach(e => {
        if (!e.isIntersecting) return
        e.target.classList.add('in')
        seen.unobserve(e.target)
        // 依次出现完了，悬停效果不再带延迟
        if (e.target.classList.contains('stagger')) setTimeout(() => e.target.classList.add('done'), 1400)
      }),
    { rootMargin: '0px 0px -12% 0px' },
  )
  $$('.rv, .stagger').forEach(el => seen.observe(el))

  // ---------- 鼠标：光斑、截图倾斜 ----------
  document.addEventListener(
    'pointermove',
    e => {
      const g = e.target.closest?.('.glow, .pic')
      if (!g) return
      const r = g.getBoundingClientRect()
      g.style.setProperty('--mx', e.clientX - r.left + 'px')
      g.style.setProperty('--my', e.clientY - r.top + 'px')
    },
    { passive: true },
  )
  if (!reduce && matchMedia('(hover: hover)').matches)
    $$('.tilt').forEach(el => {
      el.addEventListener('pointermove', e => {
        const r = el.getBoundingClientRect(),
          x = (e.clientX - r.left) / r.width - 0.5,
          y = (e.clientY - r.top) / r.height - 0.5
        el.style.transform = `perspective(1400px) rotateY(${(x * 6).toFixed(2)}deg) rotateX(${(-y * 6).toFixed(2)}deg) translateY(-6px)`
      })
      el.addEventListener('pointerleave', () => (el.style.transform = ''))
    })

  applyTheme()
  render()
  onScroll()

  // ---------- 读 GitHub（同一会话里缓存 10 分钟，翻页不重复请求） ----------
  const CACHE = 'ps-releases'
  const use = list => list.length && ((releases = list), render())
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE) || 'null')
    if (c && Date.now() - c.at < 600000) return use(c.list)
  } catch {}
  fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
    .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(list => {
      const got = fromGitHub(list)
      try {
        sessionStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), list: got }))
      } catch {}
      use(got)
    })
    .catch(() => {})
})()
