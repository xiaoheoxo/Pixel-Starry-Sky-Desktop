import { expect, it } from 'vitest'
import { captureDotScroll, DOT_BOTTOM, nearDotBottom, restoreDotScroll } from './scrollPosition'

const setup = (top = 450, height = 1000) => {
  const scroller = {
    scrollTop: top,
    clientHeight: 200,
    scrollHeight: height,
    getBoundingClientRect: () => ({ top: 100 }),
  }
  const coordinates = [300, 425, 550, 675]
  const messages = {
    children: coordinates.map((_, i) => ({
      dataset: { dotScrollRow: `msg-${i}` },
      getBoundingClientRect: () => ({
        top: coordinates[i]! - scroller.scrollTop + 100,
        bottom: coordinates[i]! - scroller.scrollTop + 225,
      }),
    })),
  }
  return {
    scroller: scroller as unknown as HTMLElement,
    messages: messages as unknown as HTMLElement,
    coordinates,
    size: scroller,
  }
}
it('keeps the same part of a visible message after prepending history or returning at a stale scroll offset', () => {
  const { scroller, messages, coordinates } = setup()
  const saved = captureDotScroll(scroller, messages)
  expect(saved).toEqual({ bottom: false, top: 450, anchor: { id: 'msg-1', offset: -25 } })
  for (let i = 0; i < coordinates.length; i++) coordinates[i]! += 300
  scroller.scrollTop = 0
  restoreDotScroll(scroller, messages, saved)
  expect(scroller.scrollTop).toBe(750)
})
it('keeps a bottom-pinned reader at the latest message when the content grows', () => {
  const { scroller, messages, size } = setup(780)
  expect(nearDotBottom(scroller)).toBe(true)
  expect(captureDotScroll(scroller, messages)).toEqual(DOT_BOTTOM)
  size.scrollHeight = 1250
  restoreDotScroll(scroller, messages, DOT_BOTTOM)
  expect(scroller.scrollTop).toBe(1250)
})
it('falls back to the saved position when the old message is no longer in this page', () => {
  const { scroller, messages } = setup(0)
  restoreDotScroll(scroller, messages, { bottom: false, top: 125, anchor: { id: 'expired', offset: 0 } })
  expect(scroller.scrollTop).toBe(125)
})
