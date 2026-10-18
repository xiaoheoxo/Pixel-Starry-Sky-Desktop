import { describe, expect, it } from 'vitest'
import {
  EMPTY_DRAFT,
  answeredCount,
  canWriteIn,
  collectAnswers,
  displayLabel,
  draftAnswer,
  isRecommended,
  pickOption,
  recommendedAnswers,
  toggleOther,
} from './questionModel'

const q = (question: string, labels: string[], multiSelect = false) => ({
  question,
  header: '',
  multiSelect,
  options: labels.map(label => ({ label, description: '' })),
})

describe('提问卡片的推荐项', () => {
  it('认中英文和全角半角括号，显示时去掉记号', () => {
    expect(isRecommended('7 天（推荐）')).toBe(true)
    expect(isRecommended('Keep it (Recommended)')).toBe(true)
    expect(isRecommended('30 天')).toBe(false)
    expect(displayLabel('7 天（推荐）')).toBe('7 天')
    expect(displayLabel('Keep it (Recommended)')).toBe('Keep it')
  })

  it('每题都有推荐才给答案；多选题选全部推荐项，单选只取第一个', () => {
    expect(
      recommendedAnswers([
        q('多久', ['7 天（推荐）', '30 天']),
        q('提示', ['一行字 (推荐)', '小圆点（推荐）', '不提示'], true),
      ]),
    ).toEqual({ 多久: '7 天（推荐）', 提示: '一行字 (推荐), 小圆点（推荐）' })
    expect(recommendedAnswers([q('多久', ['7 天（推荐）']), q('提示', ['一行字', '小圆点'])])).toBeNull()
    expect(recommendedAnswers([])).toBeNull()
  })
})

describe('提问卡片的「其他」自己输入', () => {
  const single = { ...q('部署方式？', ['给你 SSH 访问', '我自己执行']), allowOther: true }
  const multi = { ...q('要哪些？', ['日志', '托盘'], true), allowOther: true }

  it('单选：选「其他」清掉选项，再选选项又取消「其他」；填了内容才算答完', () => {
    let d = pickOption(single, EMPTY_DRAFT, '我自己执行')
    expect(draftAnswer(single, d)).toBe('我自己执行')
    d = toggleOther(single, d)
    expect(d).toMatchObject({ picks: [], other: true })
    expect(draftAnswer(single, d)).toBeNull()
    d = { ...d, text: '  先发我脚本看看  ' }
    expect(draftAnswer(single, d)).toBe('先发我脚本看看')
    d = pickOption(single, d, '给你 SSH 访问')
    expect(d.other).toBe(false)
    expect(draftAnswer(single, d)).toBe('给你 SSH 访问')
  })

  it('多选：「其他」和勾选的选项一起提交，用「, 」连起来；收起「其他」后输入不算', () => {
    let d = pickOption(multi, EMPTY_DRAFT, '日志')
    d = { ...toggleOther(multi, d), text: '设置同步' }
    expect(draftAnswer(multi, d)).toBe('日志, 设置同步')
    d = toggleOther(multi, d)
    expect(draftAnswer(multi, d)).toBe('日志')
  })

  it('没有选项的题直接输入；全部答完才给答案', () => {
    const open = q('还有什么要求？', [])
    expect(canWriteIn(open)).toBe(true)
    expect(canWriteIn(q('二选一', ['a', 'b']))).toBe(false)
    expect(
      collectAnswers([single, open], { [single.question]: pickOption(single, EMPTY_DRAFT, '我自己执行') }),
    ).toBeNull()
    expect(
      collectAnswers([single, open], {
        [single.question]: pickOption(single, EMPTY_DRAFT, '我自己执行'),
        [open.question]: { ...EMPTY_DRAFT, text: '没有' },
      }),
    ).toEqual({ [single.question]: '我自己执行', [open.question]: '没有' })
  })
})

describe('已回答题数', () => {
  const a = q('A', ['x', 'y'])
  const b = { ...q('B', ['x', 'y']), allowOther: true }
  it('只数答完的：没选、选了「其他」却没填都不算', () => {
    expect(answeredCount([a, b], {})).toBe(0)
    const picked = { [a.question]: pickOption(a, EMPTY_DRAFT, 'x') }
    expect(answeredCount([a, b], picked)).toBe(1)
    expect(answeredCount([a, b], { ...picked, [b.question]: toggleOther(b, EMPTY_DRAFT) })).toBe(1)
    expect(answeredCount([a, b], { ...picked, [b.question]: { ...toggleOther(b, EMPTY_DRAFT), text: 'z' } })).toBe(2)
    expect(answeredCount([], {})).toBe(0)
  })
})
