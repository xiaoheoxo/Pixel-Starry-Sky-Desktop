import { describe, expect, it } from 'vitest'
import { assertPublicHost, isPublicAddress, type LookupFn } from '../src/tools/ip-guard.ts'

describe('isPublicAddress：IPv4 边界', () => {
  it.each([
    ['1.1.1.1', true],
    ['93.184.216.34', true],
    ['0.0.0.0', false],
    ['0.255.255.255', false],
    ['1.0.0.0', true],
    ['9.255.255.255', true],
    ['10.0.0.0', false],
    ['10.255.255.255', false],
    ['11.0.0.0', true],
    ['100.63.255.255', true],
    ['100.64.0.0', false],
    ['100.127.255.255', false],
    ['100.128.0.0', true],
    ['127.0.0.1', false],
    ['127.255.255.255', false],
    ['169.253.255.255', true],
    ['169.254.0.0', false],
    ['169.254.169.254', false],
    ['169.255.0.0', true],
    ['172.15.255.255', true],
    ['172.16.0.0', false],
    ['172.31.255.255', false],
    ['172.32.0.0', true],
    ['192.0.0.1', false],
    ['192.0.1.1', true],
    ['192.167.255.255', true],
    ['192.168.0.0', false],
    ['192.168.255.255', false],
    ['192.169.0.0', true],
    ['223.255.255.255', true],
    ['224.0.0.1', false],
    ['240.0.0.1', false],
    ['255.255.255.255', false],
  ])('%s -> %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected)
  })

  it('198.18.0.0/15（fake-ip 代理用的基准测试网段）算公网', () => {
    expect(isPublicAddress('198.18.0.1')).toBe(true)
    expect(isPublicAddress('198.19.255.255')).toBe(true)
  })
})

describe('isPublicAddress：IPv6', () => {
  it.each([
    ['::', false],
    ['::1', false],
    ['fe80::1', false],
    ['febf::1', false],
    ['fec0::1', false], // 已废弃的 site-local，仍可能在内网里用
    ['feff::1', false],
    ['ff00::', false],
    ['100::1', false], // 丢弃前缀 100::/64
    ['100:0:0:1::1', true],
    ['fc00::1', false],
    ['fdff::1', false],
    ['fb00::1', true],
    ['ff02::1', false],
    ['2606:4700::1111', true],
    ['2001:4860:4860::8888', true],
  ])('%s -> %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected)
  })

  it('IPv4 映射：两种写法都按内嵌的 IPv4 判断', () => {
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false)
    expect(isPublicAddress('::ffff:7f00:1')).toBe(false)
    expect(isPublicAddress('::FFFF:7F00:0001')).toBe(false)
    expect(isPublicAddress('0:0:0:0:0:ffff:10.0.0.1')).toBe(false)
    expect(isPublicAddress('::ffff:a00:1')).toBe(false)
    expect(isPublicAddress('::ffff:93.184.216.34')).toBe(true)
    expect(isPublicAddress('::ffff:5db8:d822')).toBe(true)
  })

  it('IPv4 兼容 ::/96', () => {
    expect(isPublicAddress('::127.0.0.1')).toBe(false)
    expect(isPublicAddress('::7f00:1')).toBe(false)
    expect(isPublicAddress('::10.0.0.1')).toBe(false)
    expect(isPublicAddress('::93.184.216.34')).toBe(true)
  })

  it('NAT64 64:ff9b::/96', () => {
    expect(isPublicAddress('64:ff9b::127.0.0.1')).toBe(false)
    expect(isPublicAddress('64:ff9b::7f00:1')).toBe(false)
    expect(isPublicAddress('64:ff9b::a00:1')).toBe(false)
    expect(isPublicAddress('64:ff9b::5db8:d822')).toBe(true)
  })

  it('本地用途的 NAT64 64:ff9b:1::/48 整段不放行', () => {
    expect(isPublicAddress('64:ff9b:1::7f00:1')).toBe(false)
    expect(isPublicAddress('64:ff9b:1::5db8:d822')).toBe(false)
  })

  it('IPv4-translated ::ffff:0:0:0/96 按内嵌的 IPv4 判断', () => {
    expect(isPublicAddress('::ffff:0:7f00:1')).toBe(false)
    expect(isPublicAddress('::ffff:0:5db8:d822')).toBe(true)
  })

  it('Teredo 2001::/32 整段不放行（里面嵌着别的 IPv4）', () => {
    expect(isPublicAddress('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe(false)
    expect(isPublicAddress('2001:db8::1')).toBe(true) // 2001:db8 不是 Teredo
  })

  it('6to4 2002::/16：第 16~48 位是内嵌 IPv4', () => {
    expect(isPublicAddress('2002:7f00:1::')).toBe(false)
    expect(isPublicAddress('2002:7f00:0001:abcd::1')).toBe(false)
    expect(isPublicAddress('2002:a00:1::')).toBe(false)
    expect(isPublicAddress('2002:5db8:d822::1')).toBe(true)
  })

  it('带 zone 后缀的链路本地地址', () => {
    expect(isPublicAddress('fe80::1%eth0')).toBe(false)
  })
})

describe('isPublicAddress：非法输入按非公网', () => {
  it.each([
    '',
    'abc',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '01.2.3.4x',
    '1::2::3',
    ':::',
    '12345::1',
    '::g',
    '[::1]',
    ' 8.8.8.8',
  ])('%j', ip => {
    expect(isPublicAddress(ip)).toBe(false)
  })
})

describe('assertPublicHost', () => {
  const table: Record<string, string[]> = {
    'pub.example': ['93.184.216.34', '2606:4700::1111'],
    'mixed.example': ['93.184.216.34', '10.0.0.5'],
    'empty.example': [],
  }
  const lookup: LookupFn = async host => {
    const addrs = table[host]
    if (!addrs) throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' })
    return addrs.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  }

  it('IP 字面量直接判断（IPv6 带方括号也行），不走 lookup', async () => {
    const never: LookupFn = async () => {
      throw new Error('should not be called')
    }
    expect(await assertPublicHost('8.8.8.8', never)).toEqual({ ok: true })
    expect(await assertPublicHost('127.0.0.1', never)).toEqual({ ok: false, address: '127.0.0.1' })
    expect(await assertPublicHost('[::1]', never)).toEqual({ ok: false, address: '::1' })
    expect(await assertPublicHost('[2606:4700::1111]', never)).toEqual({ ok: true })
  })

  it('localhost / *.localhost 不解析直接拦截（含大小写、末尾点）', async () => {
    expect(await assertPublicHost('localhost', lookup)).toMatchObject({ ok: false })
    expect(await assertPublicHost('LocalHost.', lookup)).toMatchObject({ ok: false })
    expect(await assertPublicHost('a.b.localhost', lookup)).toMatchObject({ ok: false, address: 'a.b.localhost' })
    expect(await assertPublicHost('notlocalhost', lookup)).toMatchObject({ ok: false, error: 'ENOTFOUND' })
  })

  it('域名：每个解析结果都得是公网', async () => {
    expect(await assertPublicHost('pub.example', lookup)).toEqual({ ok: true })
    expect(await assertPublicHost('mixed.example', lookup)).toEqual({ ok: false, address: '10.0.0.5' })
  })

  it('本机网卡上的地址算非公网：字面量和解析结果都看（含 IPv4 映射写法）', async () => {
    const own = () => new Set(['240e:390:0:0:0:0:0:1', '203.0.113.7'])
    const self: LookupFn = async () => [{ address: '240e:390::1', family: 6 }]
    expect(await assertPublicHost('[240e:390::1]', lookup, own)).toEqual({ ok: false, address: '240e:390::1' })
    expect(await assertPublicHost('203.0.113.7', lookup, own)).toEqual({ ok: false, address: '203.0.113.7' })
    expect(await assertPublicHost('[::ffff:203.0.113.7]', lookup, own)).toMatchObject({ ok: false })
    expect(await assertPublicHost('self.example', self, own)).toEqual({ ok: false, address: '240e:390::1' })
    expect(await assertPublicHost('pub.example', lookup, own)).toEqual({ ok: true })
  })

  it('末尾点：localhost 判断去掉全部末尾点，解析用原来的名字', async () => {
    const asked: string[] = []
    const record: LookupFn = async host => {
      asked.push(host)
      return [{ address: '93.184.216.34', family: 4 }]
    }
    expect(await assertPublicHost('localhost..', record)).toMatchObject({ ok: false })
    expect(await assertPublicHost('pub.example.', record)).toEqual({ ok: true })
    expect(asked).toEqual(['pub.example.'])
  })

  it('解析失败 / 空结果：拦截并带原因', async () => {
    expect(await assertPublicHost('nx.example', lookup)).toEqual({ ok: false, error: 'ENOTFOUND' })
    expect(await assertPublicHost('empty.example', lookup)).toEqual({ ok: false, error: 'no addresses' })
  })
})
