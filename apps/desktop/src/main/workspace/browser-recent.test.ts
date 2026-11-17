import { describe, expect, it } from 'vitest'
import { pushRecent } from './browser-recent'

describe('内置浏览器的最近地址', () => {
  it('新的在前，去重（不管结尾斜杠和 #），最多 8 个', () => {
    expect(pushRecent(['http://a/', 'http://b/'], 'http://b')).toEqual(['http://b', 'http://a/'])
    expect(pushRecent(['http://a/x#top'], 'http://a/x')).toEqual(['http://a/x'])
    const many = Array.from({ length: 8 }, (_, i) => `http://h${i}/`)
    expect(pushRecent(many, 'http://new/')).toHaveLength(8)
    expect(pushRecent(many, 'http://new/')[0]).toBe('http://new/')
  })
  it('只记 http / https / file', () => {
    expect(pushRecent(['http://a/'], 'about:blank')).toEqual(['http://a/'])
    expect(pushRecent(undefined, 'file:///D:/p/index.html')).toEqual(['file:///D:/p/index.html'])
  })
})
