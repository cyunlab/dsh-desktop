import { describe, expect, it, vi } from 'vitest'
import { configureElectronRuntime } from '../../src/main/electron-runtime.js'

describe('Electron runtime', () => {
  it('removes the Windows application menu and makes spawned app executables run as Node workers', () => {
    const env: NodeJS.ProcessEnv = {}
    const removeApplicationMenu = vi.fn()

    configureElectronRuntime({ platform: 'win32', env, removeApplicationMenu })

    expect(removeApplicationMenu).toHaveBeenCalledOnce()
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('leaves other platform menus and process environments unchanged', () => {
    const env: NodeJS.ProcessEnv = {}
    const removeApplicationMenu = vi.fn()

    configureElectronRuntime({ platform: 'darwin', env, removeApplicationMenu })

    expect(removeApplicationMenu).not.toHaveBeenCalled()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})
