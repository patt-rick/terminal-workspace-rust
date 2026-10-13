/**
 * Spread onto a shell control so clicking it does not move keyboard focus out
 * of the terminal. The control stays reachable with the keyboard.
 */
export const keepFocus = {
  onMouseDown: (e: { preventDefault(): void }): void => e.preventDefault(),
}
