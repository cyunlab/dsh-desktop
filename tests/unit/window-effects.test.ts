import { describe, expect, it, vi } from 'vitest'
import { navigateToHostSafely, openExternalSafely } from '../../src/main/window-effects.js'

describe('window effects', () => {
  it('contains external-open rejections', async () => {
    const openExternal = vi.fn(async () => { throw new Error('system browser unavailable') })
    await expect(openExternalSafely(openExternal, 'https://example.test')).resolves.toBeUndefined()
    expect(openExternal).toHaveBeenCalledWith('https://example.test')
  })

  it('restores the startup page and reports Host navigation rejection', async () => {
    const failure = new Error('http://127.0.0.1:1234/?token=secret')
    const restore = vi.fn(async () => undefined)
    const onFailure = vi.fn()
    await expect(navigateToHostSafely(async () => { throw failure }, restore, onFailure)).resolves.toBeUndefined()
    expect(restore).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledWith(failure)
  })

  it('contains startup-page restoration rejection too', async () => {
    const onFailure = vi.fn()
    await expect(navigateToHostSafely(
      async () => { throw new Error('host failed') },
      async () => { throw new Error('startup page failed') },
      onFailure
    )).resolves.toBeUndefined()
    expect(onFailure).toHaveBeenCalledOnce()
  })
})
