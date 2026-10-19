// 我的：配对过的电脑（切换、在手机上删掉）、锁屏提醒、主题、关于
import type { ReactNode } from 'react'
import { Check, Laptop, Plus, ShieldCheck, SquarePlus, Trash2 } from 'lucide-react'
import { connections, phoneFingerprint } from '@/connection'
import { useConnections } from '@/data/hooks'
import { linkStateText } from '@/i18n/zh'
import { promptInstall, useInstallEntry } from '@/platform/pwa'
import { Dot, Row, Screen, Section, Segmented } from '@/ui'
import { PushRow } from './PushRow'
import { THEMES, useThemePreference } from './theme'

export function MeScreen({ menu, onAdd, onInstall }: { menu: ReactNode; onAdd: () => void; onInstall: () => void }) {
  const { list, active } = useConnections()
  const [theme, setTheme] = useThemePreference()
  const install = useInstallEntry()
  return (
    <Screen large title="我的" leading={menu}>
      <div className="flex flex-col gap-6 pb-8">
        <Section title="电脑">
          {list.map(p => {
            const state = connections.state(p.deviceId)
            return (
              <Row
                key={p.deviceId}
                icon={<Laptop size={22} strokeWidth={1.5} />}
                title={p.desktopName}
                subtitle={
                  <span className="inline-flex items-center gap-1.5">
                    <Dot
                      tone={
                        state === 'ready'
                          ? 'online'
                          : state === 'removed' || state === 'incompatible'
                            ? 'danger'
                            : 'muted'
                      }
                    />
                    {state ? linkStateText[state] : ''}
                  </span>
                }
                trailing={active?.deviceId === p.deviceId ? <Check size={20} className="text-accent-fg" /> : undefined}
                onClick={() => connections.select(p.deviceId)}
              />
            )
          })}
          <Row
            icon={<Plus size={22} strokeWidth={1.5} />}
            title="添加电脑"
            subtitle="扫码，或粘贴电脑上复制的配对链接"
            onClick={onAdd}
            chevron
          />
        </Section>

        {install > 0 && (
          <Section>
            <Row
              icon={<SquarePlus size={22} strokeWidth={1.5} />}
              title="添加到主屏幕"
              subtitle="像 App 一样从桌面图标打开，没有地址栏"
              onClick={() => (install === 2 ? void promptInstall() : onInstall())}
              chevron={install === 1}
            />
          </Section>
        )}

        {list.length > 0 && <PushRow onInstall={onInstall} />}

        {active && (
          <Section title="安全">
            <Row
              icon={<ShieldCheck size={20} strokeWidth={1.5} />}
              title="电脑指纹"
              trailing={<code className="font-mono text-meta text-fg-muted">{active.fingerprint}</code>}
            />
            <Row
              icon={<ShieldCheck size={20} strokeWidth={1.5} />}
              title="本机指纹"
              trailing={<code className="font-mono text-meta text-fg-muted">{phoneFingerprint(active)}</code>}
            />
            <Row
              icon={<Trash2 size={20} strokeWidth={1.5} className="text-danger" />}
              title={<span className="text-danger">在这部手机上删掉「{active.desktopName}」</span>}
              subtitle="电脑那边要在 设置 › 手机 里移除"
              onClick={() => {
                if (confirm(`在这部手机上删掉「${active.desktopName}」？`)) connections.forget(active.deviceId)
              }}
            />
          </Section>
        )}

        <div className="px-4">
          <div className="px-1 pb-2 text-meta font-medium text-fg-muted">主题</div>
          <Segmented options={THEMES} value={theme} onChange={setTheme} />
        </div>

        <p className="px-5 text-center text-label text-fg-faint">
          像素星空 · 手机版（网页）。内容在手机和电脑之间端到端加密。
        </p>
      </div>
    </Screen>
  )
}
