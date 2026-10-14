import { describe, expect, it } from 'vitest'
import { isNoopSlot, moveToSlot, slotAt } from './reorder'

describe('slotAt', () => {
  const mids = [10, 30, 50]
  it('is 0 above the first midpoint', () => expect(slotAt(mids, 5)).toBe(0))
  it('is between items past a midpoint', () => expect(slotAt(mids, 31)).toBe(2))
  it('is the end past the last midpoint', () => expect(slotAt(mids, 99)).toBe(3))
  it('is 0 for an empty list', () => expect(slotAt([], 5)).toBe(0))
})

describe('moveToSlot', () => {
  const list = ['a', 'b', 'c', 'd']
  it('moves down', () => expect(moveToSlot(list, 0, 3)).toEqual(['b', 'c', 'a', 'd']))
  it('moves to the end', () => expect(moveToSlot(list, 1, 4)).toEqual(['a', 'c', 'd', 'b']))
  it('moves up', () => expect(moveToSlot(list, 3, 1)).toEqual(['a', 'd', 'b', 'c']))
  it('moves to the start', () => expect(moveToSlot(list, 2, 0)).toEqual(['c', 'a', 'b', 'd']))
  it('leaves the order for the slots either side of the item', () => {
    expect(moveToSlot(list, 1, 1)).toEqual(list)
    expect(moveToSlot(list, 1, 2)).toEqual(list)
    expect(isNoopSlot(1, 2)).toBe(true)
    expect(isNoopSlot(1, 3)).toBe(false)
  })
  it('ignores an index out of range', () => expect(moveToSlot(list, 9, 0)).toEqual(list))
  it('does not change the input', () => {
    const copy = [...list]
    moveToSlot(copy, 0, 4)
    expect(copy).toEqual(list)
  })
})
