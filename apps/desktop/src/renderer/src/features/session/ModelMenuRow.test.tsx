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

it('distinguishes relay benchmark references and relay prices from verified route data', () => {
  const markup = renderToStaticMarkup(
    <ModelRow
      title="gpt-6-astra"
      referenceOnly
      evidence={{ arc2Xhigh: 93.3 }}
      iq={{
        score: 55,
        effort: 'xhigh',
        cohortSize: 6,
        radarWeight: 40,
        analysisWeight: 50,
        arcWeight: 10,
        radarScore: 130,
        analysisScore: 55,
        disagreement: 17,
      }}
      price={{ price: { currency: 'USD', input: 10, output: 50 }, basis: 'relay-reference' }}
    />,
  )
  expect(markup).toMatch(/IQ 55 (?:参考|ref\.)/)
  expect(markup).toMatch(/不是中转实际扣费|not the relay’s actual charge/)
  expect(markup).toContain('ARC-AGI-2')
})
