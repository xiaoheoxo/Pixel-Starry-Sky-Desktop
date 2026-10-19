// 按需加载的页面没下下来（弱网、刚断网）时：只在这一块显示「没加载出来 · 重试」，不让整个页面白屏。
// React.lazy 会记住失败的结果，所以重试就是刷新页面；没网时先不刷（刷了只会看到离线页），提示连上再试。
// resetKey 变了（换了页面）就清掉错误，别的页面照常显示。
import { Component, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'

interface Props {
  resetKey: string
  children: ReactNode
}

export class PageBoundary extends Component<Props, { failed: boolean; offline: boolean }> {
  state = { failed: false, offline: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false, offline: false })
  }

  private retry = (): void => {
    if (navigator.onLine === false) this.setState({ offline: true })
    else location.reload()
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex h-app min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app px-8 text-center">
        <p className="text-ui text-fg">这一页没加载出来</p>
        <p className="text-meta text-fg-muted">
          {this.state.offline ? '现在没有网络，连上后再点重试。' : '可能是网络不稳，点重试再加载一次。'}
        </p>
        <button
          type="button"
          onClick={this.retry}
          className="mt-1 inline-flex min-h-11 items-center gap-2 rounded-full border border-line-subtle bg-surface px-5 text-ui text-fg-secondary active:bg-hover"
        >
          <RefreshCw size={16} /> 重试
        </button>
      </div>
    )
  }
}
