import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from './cn'
import { DiscardBar } from './DiscardBar'
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  busy,
  error,
  danger,
  warn,
  focusInput,
  confirmDisabled,
  extra,
  dirty,
  wide,
  hideConfirm,
  onConfirm,
  onCancel,
}: {
  title: string
  description: ReactNode
  confirmLabel: string
  cancelLabel: string
  busy: boolean
  error?: string | null
  danger?: boolean
  /** 确认按钮用警告色（放宽权限之类，比删除轻一档） */
  warn?: boolean
  focusInput?: boolean
  confirmDisabled?: boolean
  /** 取消和确认之间的第三个按钮（比如「打开 Git 面板」） */
  extra?: { label: string; onClick: () => void }
  /** 弹窗里是表单且有没保存的改动：取消 / Esc / 点背景先在弹窗里问一句「放弃改动？」，不直接关 */
  dirty?: boolean
  /** 内容多的表单（合并面板）：宽一些 */
  wide?: boolean
  /** 没什么要确认的（管理列表）：只留一个关闭按钮 */
  hideConfirm?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDivElement>(null),
    cancel = useRef<HTMLButtonElement>(null),
    titleId = useId(),
    descriptionId = useId(),
    [asking, setAsking] = useState(false)
  const requestCancel = (): void => {
    if (busy) return
    if (dirty && !asking) setAsking(true)
    else onCancel()
  }
  const callbacks = useRef({ requestCancel, asking })
  callbacks.current = { requestCancel, asking }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const input = focusInput ? ref.current?.querySelector<HTMLInputElement>('input') : null
    if (input) {
      input.focus({ preventScroll: true })
      input.select()
    } else cancel.current?.focus({ preventScroll: true })
    const key = (event: KeyboardEvent): void => {
      // 弹窗里又开了一层弹窗时只有最上面那层处理按键（后开的排在 body 最后），不然 Esc 会把两层一起关掉
      if ([...document.querySelectorAll('[data-session-confirm]')].at(-1) !== ref.current) return
      if (event.key === 'Escape') {
        // 输入法候选框里的 Esc、弹窗里展开着的下拉菜单、标了 data-own-escape 的输入框（行内改名）的 Esc 交给它们自己，不关整个弹窗
        const target = event.target as HTMLElement | null
        if (
          event.isComposing ||
          target?.closest?.('[aria-haspopup][aria-expanded="true"],[role="listbox"],[data-own-escape]')
        )
          return
        event.preventDefault()
        event.stopPropagation()
        // 正在问「放弃改动？」时 Esc 是回去继续编辑
        if (callbacks.current.asking) setAsking(false)
        else callbacks.current.requestCancel()
      }
      if (event.key === 'Tab') {
        const items = [
            ...(ref.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
            ) ?? []),
          ],
          first = items[0],
          last = items.at(-1)
        if (!first) {
          event.preventDefault()
          ref.current?.focus()
          return
        }
        if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) {
          event.preventDefault()
          last?.focus()
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !ref.current?.contains(document.activeElement))
        ) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('keydown', key, true)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-scrim p-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget) requestCancel()
      }}
    >
      <div
        ref={ref}
        data-session-confirm
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        // 最高到窗口高度（外层留了 p-4）：标题和按钮固定，内容多了在中间滚动，不会把弹窗撑出窗口
        className={cn(
          'pop-in flex max-h-full w-full flex-col',
          wide ? 'max-w-xl' : 'max-w-md',
          'rounded-xl border border-line-card bg-popover p-5 text-fg shadow-popover outline-none',
        )}
      >
        <h3 id={titleId} className="shrink-0 break-words text-section font-semibold">
          {title}
        </h3>
        <div
          id={descriptionId}
          className="-mx-1 mt-3 min-h-0 overflow-y-auto px-1 text-list leading-relaxed text-fg-secondary [scrollbar-width:thin]"
        >
          {description}
        </div>
        {error && (
          <p role="alert" className="mt-3 shrink-0 break-words text-meta text-danger">
            {error}
          </p>
        )}
        {asking && <DiscardBar onKeep={() => setAsking(false)} onDiscard={onCancel} />}
        <div className="mt-5 flex shrink-0 flex-wrap justify-end gap-2">
          <button
            ref={cancel}
            disabled={busy}
            onClick={requestCancel}
            className="press rounded-md border border-line px-3 py-2 text-ui hover:bg-hover disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          {extra && (
            <button
              disabled={busy}
              onClick={extra.onClick}
              className="press rounded-md border border-line px-3 py-2 text-ui hover:bg-hover disabled:opacity-50"
            >
              {extra.label}
            </button>
          )}
          {!hideConfirm && (
            <button
              disabled={busy || confirmDisabled}
              onClick={onConfirm}
              className={cn(
                'press rounded-md px-3 py-2 text-ui font-medium disabled:opacity-50',
                danger ? 'bg-danger text-accent-on' : warn ? 'bg-warn text-accent-on' : 'bg-primary text-primary-fg',
              )}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
