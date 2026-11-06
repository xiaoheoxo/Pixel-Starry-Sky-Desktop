import { useI18n } from '@/i18n/I18nProvider'
import { useEffect, useRef } from 'react'
import { useTheme } from '@/features/appearance/ThemeProvider'
import { useGlassOnWindow } from './glass'
import { useWallpaper } from './wallpaper'

/**
 * 壁纸层：固定铺满窗口、在所有界面下面（z-index -1），上面盖一层主题底色，透明度由「透出程度」决定。
 * 浅色主题下壁纸降低饱和度、稍微提亮，避免把界面洗成灰色（Mirasim 的做法）。docs/ui/settings.md §6
 */
export function WallpaperLayer() {
  useI18n()
  const wp = useWallpaper()
  const { resolved } = useTheme()
  const glass = useGlassOnWindow()
  const videoRef = useRef<HTMLVideoElement>(null)

  // 视频：窗口隐藏 / 最小化时暂停，回来再播
  useEffect(() => {
    if (wp.kind !== 'video') return
    const onVisibility = () => {
      const v = videoRef.current
      if (!v) return
      if (document.hidden) v.pause()
      else void v.play().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [wp.kind, wp.url])

  // 毛玻璃透桌面：壁纸不显示，否则挡住桌面
  if (!wp.name || !wp.url || glass?.source === 'desk') return null

  const light = resolved === 'light'
  // 毛玻璃透壁纸：滤镜直接加在壁纸上（比各区域 backdrop-filter 省），底色由各区域自己盖，这里不再加遮罩
  const blur = glass ? glass.blur : wp.blur
  const filters = glass
    ? `blur(${blur}px) saturate(${glass.saturate}%) brightness(${glass.brightness}%)`
    : [light ? 'saturate(0.55) brightness(1.08)' : '', blur > 0 ? `blur(${blur}px)` : ''].filter(Boolean).join(' ')
  const mediaStyle = {
    filter: filters || undefined,
    // 模糊会让边缘变透明，放大一点盖住
    transform: blur > 0 ? `scale(${1 + blur / 200})` : undefined,
  }
  // 遮罩越不透明，背景透出越少；浅色主题遮罩更厚一些
  const tintOpacity = glass ? 0 : light ? 1 - wp.show * 0.6 : 1 - wp.show

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {wp.kind === 'video' ? (
        <video
          ref={videoRef}
          key={wp.url}
          src={wp.url}
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
          style={mediaStyle}
        />
      ) : (
        <img
          key={wp.url}
          src={wp.url}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          style={mediaStyle}
        />
      )}
      <div className="absolute inset-0 bg-wall-tint" style={{ opacity: tintOpacity }} />
    </div>
  )
}
