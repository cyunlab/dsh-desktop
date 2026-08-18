import { describe, expect, it, vi } from 'vitest'
import { configureElectronRuntime } from '../../src/main/electron-runtime.js'

describe('Electron runtime', () => {
  it('removes the Windows application menu without mutating process environment', () => {
    const removeApplicationMenu = vi.fn()

    configureElectronRuntime({ platform: 'win32', removeApplicationMenu })

    expect(removeApplicationMenu).toHaveBeenCalledOnce()
  })

  it('leaves other platform menus unchanged', () => {
    const removeApplicationMenu = vi.fn()

    configureElectronRuntime({ platform: 'darwin', removeApplicationMenu })

    expect(removeApplicationMenu).not.toHaveBeenCalled()
  })
})
