import { getModelRoleGuide } from '@pixelsky/protocol'
import { getLocale } from '@/i18n/core'

export function modelRoleGuide(id: string | null | undefined): ReturnType<typeof getModelRoleGuide> {
  return getModelRoleGuide(id, getLocale() === 'en-US' ? 'en' : 'zh')
}
