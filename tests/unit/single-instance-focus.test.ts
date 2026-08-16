import { describe, expect, it, vi } from 'vitest'
import { SingleInstanceFocusCoordinator, type FocusableWindow } from '../../src/main/single-instance-focus.js'

function fakeWindow(minimized = false): FocusableWindow {
  return {
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn()
  }
}

describe('single-instance focus coordinator', () => {
  it('retains a second-instance request that arrives before window creation', () => {
    const coordinator = new SingleInstanceFocusCoordinator()
    const window = fakeWindow(true)

    coordinator.requestFocus()
    expect(window.focus).not.toHaveBeenCalled()

    coordinator.attach(window)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('focuses an attached window immediately', () => {
    const coordinator = new SingleInstanceFocusCoordinator()
    const window = fakeWindow()
    coordinator.attach(window)
    coordinator.requestFocus()
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })
})
