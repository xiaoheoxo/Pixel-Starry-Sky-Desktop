import { useMemo } from 'react'
import { encode } from 'uqr'

/** 固定显示尺寸：整数倍放大后落在 min–max 像素之间（付款码用，docs/ui/in-app-payment.md §6.7） */
export interface QrFitSize {
  min: number
  max: number
}

/**
 * 每个格子放大几倍：取放得进 max 的最大整数倍（整数像素才不发虚、扫得出来）；
 * 码太密、1 倍也放不进时就用 1 倍。modules 是含空白边的总格数，min 只用来说明目标范围（整数倍不一定凑得到 min）
 */
export function qrFitScale(modules: number, { max }: QrFitSize): number {
  if (!(modules > 0)) return 1
  return Math.max(1, Math.floor(max / modules))
}

/**
 * 二维码：深色模块画在浅色底上（扫码器大多不认反色的码）。M1 截图后用 jsQR 核对过两种主题都能扫。
 * 只用设计变量：浅色主题用 surface 底 + fg 模块；深色主题（dark）两者对调，仍然是「浅底深码」。主题由调用方传入（ui/ 不依赖 features/）。
 * 默认每格 scale 像素（手机配对用）；传 fit 就按码的格数算整数倍，落在固定范围内（付款码用）。
 * 内容只在本地编码，不经过任何网络服务。
 */
export function QrCode({
  text,
  label,
  scale = 4,
  ecc = 'L',
  fit,
  dark = false,
}: {
  text: string
  label: string
  scale?: number
  /** 纠错等级：付款链接可能很长，付款码用 'M' */
  ecc?: 'L' | 'M' | 'Q' | 'H'
  fit?: QrFitSize
  /** 深色主题 */
  dark?: boolean
}) {
  // 四周留 4 格空白（规范要求）；每格整数像素，不然边缘发虚、扫不出来
  const qr = useMemo(() => encode(text, { ecc, border: 4 }), [text, ecc])
  const size = qr.size * (fit ? qrFitScale(qr.size, fit) : scale)
  const path = useMemo(() => {
    let d = ''
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`
      }),
    )
    return d
  }, [qr])
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      className={dark ? 'rounded-md bg-fg fill-surface' : 'rounded-md bg-surface fill-fg ring-1 ring-line'}
    >
      <path d={path} />
    </svg>
  )
}
