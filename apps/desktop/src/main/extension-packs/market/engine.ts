/** 清单里 engines.pixelsky 要求的最低版本，给「需要像素星空 X 以上」用：取范围里第一个完整版本号，没有就原样返回 */
export function engineNeed(range: string): string {
  const m = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(range)
  return m ? m[0] : range.trim()
}
