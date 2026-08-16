import { describe, expect, it, vi } from 'vitest'
import { NullDiagnostics, type DiagnosticContext } from '../../src/main/diagnostics.js'
import { createStartupActions } from '../../src/main/startup-actions.js'

const context: DiagnosticContext = {
  appVersion: '0.1.0', electronVersion: '43.4.0', nodeVersion: '24.1.0', platform: 'darwin', arch: 'arm64'
}

describe('startup native actions', () => {
  it('copies the controlled summary and reveals exactly the selected log directory', async () => {
    const writeClipboard = vi.fn()
    const revealPath = vi.fn(async () => '')
    const actions = createStartupActions(
      () => ({ state: 'failed', message: 'Safe failure summary' }), context, '/platform/logs',
      { writeClipboard, revealPath }, new NullDiagnostics()
    )
    await actions.copyDiagnostics()
    await actions.revealLogs()
    expect(writeClipboard).toHaveBeenCalledWith(expect.stringContaining('Startup failed.'))
    expect(revealPath).toHaveBeenCalledWith('/platform/logs')
  })

  it('contains clipboard and shell failures and records them', async () => {
    const actionFailure = vi.fn()
    const diagnostics = { lifecycle: vi.fn(), assignedPort: vi.fn(), navigationRejected: vi.fn(), failure: vi.fn(), actionFailure }
    const actions = createStartupActions(
      () => ({ state: 'failed', message: 'Safe failure summary' }), context, '/platform/logs',
      {
        writeClipboard: () => { throw new Error('clipboard rejected') },
        revealPath: async () => 'No file manager'
      }, diagnostics
    )
    await expect(actions.copyDiagnostics()).resolves.toBeUndefined()
    await expect(actions.revealLogs()).resolves.toBeUndefined()
    expect(actionFailure).toHaveBeenCalledTimes(2)
  })
})
