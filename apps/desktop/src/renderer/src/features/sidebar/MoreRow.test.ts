import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MouseEvent, ReactElement } from 'react'
import { MoreRow } from './MoreRow'

const { effect } = vi.hoisted(() => ({
  effect: vi.fn<(setup: () => () => void) => void>(),
}))
vi.mock('react', async importOriginal => ({
  ...(await importOriginal<typeof import('react')>()),
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: effect,
}))

let cleanup: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  effect.mockImplementation(setup => {
    cleanup = setup()
  })
})
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
})

function setup(expandAll = true) {
  const onClick = vi.fn()
  const onShowAll = vi.fn()
  const row = MoreRow({ label: '55 more', open: false, onClick, onShowAll: expandAll ? onShowAll : undefined })
  const { props } = row as ReactElement<{ onClick: (event: MouseEvent<HTMLButtonElement>) => void }>
  const click = (detail: number, shiftKey = false) =>
    props.onClick({ detail, shiftKey } as MouseEvent<HTMLButtonElement>)
  return { click, onClick, onShowAll }
}

it('reveals only the next page after the second-click window', () => {
  const { click, onClick, onShowAll } = setup()
  click(1)
  expect(onClick).not.toHaveBeenCalled()
  vi.runAllTimers()
  expect(onClick).toHaveBeenCalledOnce()
  expect(onShowAll).not.toHaveBeenCalled()
})

it('opens all immediately on the second click without first moving the button', () => {
  const { click, onClick, onShowAll } = setup()
  click(1)
  vi.advanceTimersByTime(200)
  click(2)
  expect(onShowAll).toHaveBeenCalledOnce()
  vi.runAllTimers()
  expect(onClick).not.toHaveBeenCalled()
})

it('keeps keyboard activation and archived rows immediate', () => {
  const next = setup()
  next.click(0)
  expect(next.onClick).toHaveBeenCalledOnce()
  next.click(1, true)
  expect(next.onShowAll).toHaveBeenCalledOnce()

  const archived = setup(false)
  archived.click(1)
  expect(archived.onClick).toHaveBeenCalledOnce()
  expect(archived.onShowAll).not.toHaveBeenCalled()
})

it('cancels a pending reveal when closing the list', () => {
  const { click, onClick } = setup()
  click(1)
  cleanup?.()
  vi.runAllTimers()
  expect(onClick).not.toHaveBeenCalled()
})
