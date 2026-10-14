// Drag-to-reorder arithmetic. A "slot" is a gap between items: slot 0 is
// before the first item, slot n is after the last.

/** The slot the pointer is over, given each item's midpoint along the drag axis. */
export function slotAt(midpoints: number[], pointer: number): number {
  const i = midpoints.findIndex((m) => pointer < m)
  return i < 0 ? midpoints.length : i
}

/** True when dropping item `from` into `slot` leaves the order unchanged. */
export function isNoopSlot(from: number, slot: number): boolean {
  return slot === from || slot === from + 1
}

/** `list` with the item at `from` moved into `slot` (slots counted in the original list). */
export function moveToSlot<T>(list: readonly T[], from: number, slot: number): T[] {
  if (from < 0 || from >= list.length || isNoopSlot(from, slot)) return [...list]
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(slot > from ? slot - 1 : slot, 0, item)
  return next
}
