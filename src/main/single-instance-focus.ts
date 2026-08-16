export interface FocusableWindow {
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export type FocusAction = 'restored' | 'shown' | 'focused'

export class SingleInstanceFocusCoordinator {
  #window?: FocusableWindow
  #pending = false

  constructor(private readonly observe: (action: FocusAction) => void = () => {}) {}

  requestFocus(): void {
    if (!this.#window) {
      this.#pending = true
      return
    }
    focus(this.#window, this.observe)
  }

  attach(window: FocusableWindow): void {
    this.#window = window
    if (!this.#pending) return
    this.#pending = false
    focus(window, this.observe)
  }

  detach(window: FocusableWindow): void {
    if (this.#window === window) this.#window = undefined
  }
}

function focus(window: FocusableWindow, observe: (action: FocusAction) => void): void {
  if (window.isMinimized()) {
    window.restore()
    observe('restored')
  }
  window.show()
  observe('shown')
  window.focus()
  observe('focused')
}
