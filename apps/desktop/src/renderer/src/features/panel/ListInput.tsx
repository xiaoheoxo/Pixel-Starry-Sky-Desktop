import { useEffect, useState } from 'react'

const split = (text: string): string[] =>
  text
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

/**
 * 逗号分隔的列表输入框（标签、环境变量名）：输入框里留用户原样打的字，只把拆好的列表交出去。
 * 以前每打一个字就拆开再拼回去显示，打出的空格、逗号当场被吃掉（「my tag」变「mytag」、逗号打不出来）
 */
export function ListInput({
  value,
  onChange,
  className,
}: {
  value: readonly string[]
  onChange: (list: string[]) => void
  className?: string
}) {
  const [text, setText] = useState(value.join(', '))
  // 外面换了值（打开另一个任务、重置表单）且和输入框里的对不上时，跟着显示
  useEffect(() => {
    setText(current => (split(current).join('\n') === value.join('\n') ? current : value.join(', ')))
  }, [value])
  return (
    <input
      value={text}
      onChange={e => {
        setText(e.target.value)
        onChange(split(e.target.value))
      }}
      className={className}
    />
  )
}
