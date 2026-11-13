import { Fragment, useLayoutEffect, useRef } from 'react'
import type { SkillCommand } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { commandDescription } from '@/i18n/commandDescriptions'
import { tr } from '@/i18n/core'
import { usePluginText } from '@/features/settings/plugins/text'
import type { PromptCommand } from '@/features/extpacks/prompts/usePromptCommands'
import type { AppCommand } from '@/features/resume/useResumeCommand'

export function CommandMenu({
  id,
  commands,
  selected,
  onChoose,
  onSettings,
}: {
  id: string
  commands: Array<SkillCommand | PromptCommand | AppCommand>
  selected: number
  onChoose: (index: number) => void
  onSettings: () => void
}) {
  const { locale } = useI18n()
  const text = usePluginText()
  const listRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const list = listRef.current
    const option = list?.querySelector<HTMLElement>(`[data-command-index="${selected}"]`)
    if (!list || !option) return
    // 只移动候选列表，避免 scrollIntoView 连带移动外层对话或窗格。
    const reveal = (): void => {
      const viewport = list.getBoundingClientRect(),
        row = option.getBoundingClientRect()
      if (row.top < viewport.top) list.scrollTop += row.top - viewport.top
      else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(list)
    observer.observe(option)
    return () => observer.disconnect()
  }, [commands, selected, locale])

  return (
    <div className="absolute right-0 bottom-full left-0 z-30 mb-2 overflow-hidden rounded-lg border border-line-card bg-popover p-1 shadow-menu">
      <div
        ref={listRef}
        id={id}
        role="listbox"
        aria-label={text('技能与命令')}
        className="max-h-72 overflow-y-auto overscroll-contain"
      >
        {commands.length === 0 && <div className="px-3 py-2 text-meta text-fg-muted">{tr('commands.menuEmpty')}</div>}
        {commands.map((command, index) => {
          if (command.invocation === 'prompt') {
            return (
              <button
                type="button"
                role="option"
                tabIndex={-1}
                id={`${id}-${index}`}
                data-command-index={index}
                aria-selected={index === selected}
                key={`${command.invocation}:${command.name}`}
                onMouseDown={event => event.preventDefault()}
                onClick={() => onChoose(index)}
                className={cn(
                  'flex w-full min-w-0 flex-col gap-1 rounded-md px-3 py-2 text-left text-list',
                  index === selected ? 'bg-selected' : 'hover:bg-hover',
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{command.prompt.title}</span>
                  <span className="shrink-0 rounded bg-hover px-1.5 text-meta text-fg-muted">{tr('prompts.chip')}</span>
                </span>
                {command.prompt.description && (
                  <span title={command.prompt.description} className="truncate text-meta text-fg-muted">
                    {command.prompt.description}
                  </span>
                )}
              </button>
            )
          }
          if (command.invocation === 'app') {
            // 分组标题：这一组的第一条前面写一行（D277）
            const prev = commands[index - 1]
            const heading =
              command.group && !(prev?.invocation === 'app' && prev.group === command.group) ? command.group : null
            return (
              <Fragment key={`${command.invocation}:${command.name}`}>
                {heading && (
                  <div role="presentation" className="px-3 pt-2 pb-1 text-label text-fg-faint">
                    {tr(`appCommand.group.${heading}`)}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  tabIndex={-1}
                  id={`${id}-${index}`}
                  data-command-index={index}
                  data-app-command={command.name}
                  aria-selected={index === selected}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => onChoose(index)}
                  className={cn(
                    'flex w-full min-w-0 flex-col gap-1 rounded-md px-3 py-2 text-left text-list',
                    index === selected ? 'bg-selected' : 'hover:bg-hover',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">/{command.name}</span>
                    <span className="shrink-0 rounded bg-hover px-1.5 text-meta text-fg-muted">
                      {tr('resume.chip')}
                    </span>
                  </span>
                  <span title={command.description} className="truncate text-meta text-fg-muted">
                    {command.description}
                  </span>
                </button>
              </Fragment>
            )
          }
          const description = commandDescription(command, locale)
          return (
            <button
              type="button"
              role="option"
              tabIndex={-1}
              id={`${id}-${index}`}
              data-command-index={index}
              aria-selected={index === selected}
              key={`${command.invocation}:${command.name}`}
              onMouseDown={event => event.preventDefault()}
              onClick={() => onChoose(index)}
              className={cn(
                'flex w-full min-w-0 flex-col gap-1 rounded-md px-3 py-2 text-left text-list',
                index === selected ? 'bg-selected' : 'hover:bg-hover',
              )}
            >
              <span className="font-medium">
                {command.invocation === 'skill' ? '$' : '/'}
                {command.name}
              </span>
              <span title={description} className="truncate text-meta text-fg-muted">
                {description}
              </span>
            </button>
          )
        })}
      </div>
      <button
        type="button"
        onMouseDown={event => event.preventDefault()}
        onClick={onSettings}
        className="w-full rounded-md px-3 py-2 text-left text-meta text-accent-fg hover:bg-hover"
      >
        {text('打开插件配置')}
      </button>
    </div>
  )
}
