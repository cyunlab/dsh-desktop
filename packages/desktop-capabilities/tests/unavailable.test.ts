import { describe, expect, it, vi } from 'vitest'

import {
  AppUpdateCapabilityError,
  createUnavailableAppUpdateCapability,
} from '../src/index.js'

describe('unavailable AppUpdateCapability', () => {
  it('represents a normal browser as unavailable immediately', () => {
    const capability = createUnavailableAppUpdateCapability()
    const observer = vi.fn()

    capability.observe(observer)

    expect(observer).toHaveBeenCalledWith({ kind: 'unavailable' })
  })

  it('rejects opening with a stable typed unavailable error', async () => {
    const capability = createUnavailableAppUpdateCapability()

    await expect(capability.open()).rejects.toEqual(
      expect.objectContaining<AppUpdateCapabilityError>({
        name: 'AppUpdateCapabilityError',
        code: 'unavailable',
        message: 'Desktop update capability is unavailable.',
      }),
    )
  })
})
