export interface FocusableWindow {
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export class SingleInstanceFocusCoordinator {
  #window?: FocusableWindow
  #pending = false

  requestFocus(): void {
    if (!this.#window) {
      this.#pending = true
      return
    }
    focus(this.#window)
  }

  attach(window: FocusableWindow): void {
    this.#window = window
    if (!this.#pending) return
    this.#pending = false
    focus(window)
  }

  detach(window: FocusableWindow): void {
    if (this.#window === window) this.#window = undefined
  }
}

function focus(window: FocusableWindow): void {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
