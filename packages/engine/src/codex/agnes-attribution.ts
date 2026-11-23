export interface AgnesAttribution {
  model: string
  marker?: string
}

export const agnesTag = (marker: string): string => `[pixelsky-agnes:${marker}]`
export const hasAgnesTag = (text: string, marker: string): boolean =>
  text.trimStart().split(/\r?\n/, 1)[0] === agnesTag(marker)
export const stripAgnesTag = (text: string): string =>
  text.replace(/^\s*\[pixelsky-agnes:[0-9a-f-]{36}\][ \t]*\r?\n/i, '')
