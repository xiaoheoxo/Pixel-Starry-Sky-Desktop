import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DotDeliveryNotice } from './DotDeliveryNotice'

describe('uncertain Dot delivery', () => {
  it('offers verification and explicit clearing without a resend action', () => {
    const html = renderToStaticMarkup(
      <DotDeliveryNotice
        text="Submitted task"
        web="https://chatgpt.com/dots/example"
        busy={false}
        onResolve={() => {}}
      />,
    )
    expect(html).toContain('Submitted task')
    expect(html).toContain('https://chatgpt.com/dots/example')
    expect(html).toContain('已核对，解除等待（不重发）')
    expect(html).toContain('不会重发消息或撤回云端任务')
    expect(html).not.toContain('disabled=""')
  })
  it('disables clearing while the queue operation is pending', () => {
    expect(
      renderToStaticMarkup(
        <DotDeliveryNotice text="" web="https://chatgpt.com/dots/example" busy onResolve={() => {}} />,
      ),
    ).toContain('disabled=""')
  })
})
