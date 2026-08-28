import { describe, expect, it, vi } from 'vitest'

import { createInMemoryAppUpdateCapability } from '../src/testing.js'

describe('in-memory AppUpdateCapability', () => {
  it('immediately gives a new observer the current complete snapshot', () => {
    const { capability } = createInMemoryAppUpdateCapability({ kind: 'none' })
    const observer = vi.fn()

    capability.observe(observer)

    expect(observer).toHaveBeenCalledOnce()
    expect(observer).toHaveBeenCalledWith({ kind: 'none' })
  })

  it('publishes deterministic states until an observer disposes its subscription', () => {
    const { capability, controller } = createInMemoryAppUpdateCapability({ kind: 'none' })
    const observer = vi.fn()
    const dispose = capability.observe(observer)

    controller.publish({ kind: 'available', version: '2.1.0', releaseNotes: 'Ready' })
    dispose()
    controller.publish({ kind: 'staged', version: '2.1.0', releaseNotes: 'Ready' })

    expect(observer.mock.calls).toEqual([
      [{ kind: 'none' }],
      [{ kind: 'available', version: '2.1.0', releaseNotes: 'Ready' }],
    ])
  })
})
