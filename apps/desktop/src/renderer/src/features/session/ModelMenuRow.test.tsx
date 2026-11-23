import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ModelRow } from './ModelMenuRow'

it('keeps the full description on its own wrapping line above the price', () => {
  const main = '次旗舰：适合复杂编码、跨文件重构和有明确验收的长任务；需要时候可以逐项阅读完整的说明。'
  const markup = renderToStaticMarkup(
    <ModelRow
      title="GPT-6.1 Sol"
      position="次旗舰"
      desc="openai/gpt-6.1-sol-long-name-no-breaks-abcdefghijklmnopqrstuvwxyz"
      guide={{ main, evaluator: '' }}
      price={{ price: { currency: 'USD', input: 2, output: 10 }, basis: 'standard' }}
      onPick={() => undefined}
    />,
  )
  expect(markup).toContain(main)
  expect(markup).toMatch(/data-model-guide="true" class="block [^"]*whitespace-normal[^"]*overflow-wrap:anywhere/)
  expect(markup).toMatch(/data-model-price="true" [^>]*class="block [^"]*whitespace-normal[^"]*overflow-wrap:anywhere/)
})
