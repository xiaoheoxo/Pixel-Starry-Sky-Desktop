import { describe, expect, it } from 'vitest'
import { chooseLocale, localeOfSystem } from './systemLocale'

describe('默认界面语言跟着系统走', () => {
  it('中文系统（任何地区）用简体中文，其他用英文；只看首选', () => {
    expect(localeOfSystem(['zh-CN'])).toBe('zh-CN')
    expect(localeOfSystem(['zh-TW', 'en-US'])).toBe('zh-CN')
    expect(localeOfSystem(['zh_CN.UTF-8'])).toBe('zh-CN')
    expect(localeOfSystem(['zh'])).toBe('zh-CN')
    expect(localeOfSystem(['en-US', 'zh-CN'])).toBe('en-US')
    expect(localeOfSystem(['de-DE'])).toBe('en-US')
    expect(localeOfSystem(['zu-ZA'])).toBe('en-US')
    expect(localeOfSystem(['', null, 'zh-HK'])).toBe('zh-CN')
    expect(localeOfSystem([])).toBe('en-US')
  })

  it('选过就用选的；老用户没选过记成中文；新装按系统、不记', () => {
    expect(chooseLocale('en-US', true, ['zh-CN'])).toEqual({ locale: 'en-US', persist: false })
    expect(chooseLocale('zh-CN', false, ['en-US'])).toEqual({ locale: 'zh-CN', persist: false })
    expect(chooseLocale(null, true, ['en-US'])).toEqual({ locale: 'zh-CN', persist: true })
    expect(chooseLocale(null, false, ['en-US'])).toEqual({ locale: 'en-US', persist: false })
    expect(chooseLocale('fr', false, ['zh-CN'])).toEqual({ locale: 'zh-CN', persist: false })
  })
})
