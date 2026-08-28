import { describe, expect, it, vi } from 'vitest'

import { createTauriAppUpdateCapabilityWithTransport } from '../src/tauri-adapter.js'

describe('Tauri AppUpdateCapability', () => {
  it('subscribes before reading the initial snapshot and keeps a newer racing event', async () => {
    let publishNative: (snapshot: unknown) => void = () => {
      throw new Error('listener was not installed')
    }
    let resolveInitial: (snapshot: unknown) => void = () => {
      throw new Error('snapshot was not requested')
    }
    const initial = new Promise<unknown>(resolve => {
      resolveInitial = resolve
    })
    const creating = createTauriAppUpdateCapabilityWithTransport({
      listenSnapshot: async observer => {
        publishNative = observer
        return () => undefined
      },
      readSnapshot: async () => initial,
      openSurface: async () => undefined,
    })
    await Promise.resolve()

    publishNative({
      sequence: 5,
      state: { kind: 'staged', version: '2.1.0', release_notes: 'Ready' },
      automatic_download: true,
      next_check_at: null,
    })
    resolveInitial({
      sequence: 4,
      state: { kind: 'available', version: '2.1.0', release_notes: 'Ready' },
      automatic_download: true,
      next_check_at: null,
    })
    const capability = await creating
    const observer = vi.fn()

    capability.observe(observer)

    expect(observer).toHaveBeenCalledWith({
      kind: 'staged',
      version: '2.1.0',
      releaseNotes: 'Ready',
    })
  })

  it('publishes only strictly newer snapshots and stops a disposed observer', async () => {
    let publishNative: (snapshot: unknown) => void = () => undefined
    const capability = await createTauriAppUpdateCapabilityWithTransport({
      listenSnapshot: async observer => {
        publishNative = observer
        return () => undefined
      },
      readSnapshot: async () => ({
        sequence: 1,
        state: { kind: 'idle' },
        automatic_download: true,
        next_check_at: null,
      }),
      openSurface: async () => undefined,
    })
    const observer = vi.fn()
    const dispose = capability.observe(observer)

    publishNative({
      sequence: 3,
      state: { kind: 'available', version: '2.1.0', release_notes: 'Ready' },
    })
    publishNative({
      sequence: 2,
      state: { kind: 'failed', operation: 'check', retryable: true, message: 'stale' },
    })
    publishNative({
      sequence: 3,
      state: { kind: 'staged', version: '2.1.0', release_notes: 'duplicate' },
    })
    publishNative({
      sequence: 4,
      state: {
        kind: 'downloading',
        version: '2.1.0',
        release_notes: 'Ready',
        progress: { kind: 'known_total', downloaded_bytes: 25, total_bytes: 100 },
      },
    })
    dispose()
    publishNative({
      sequence: 5,
      state: { kind: 'staged', version: '2.1.0', release_notes: 'Ready' },
    })

    expect(observer.mock.calls).toEqual([
      [{ kind: 'none' }],
      [{ kind: 'available', version: '2.1.0', releaseNotes: 'Ready' }],
      [{
        kind: 'downloading',
        version: '2.1.0',
        releaseNotes: 'Ready',
        downloadedBytes: 25,
        totalBytes: 100,
      }],
    ])
  })

  it('normalizes native open failures without exposing their details', async () => {
    const openSurface = vi.fn(async () => {
      throw new Error('secret native detail')
    })
    const capability = await createTauriAppUpdateCapabilityWithTransport({
      listenSnapshot: async () => () => undefined,
      readSnapshot: async () => ({ sequence: 0, state: { kind: 'up_to_date' } }),
      openSurface,
    })

    await expect(capability.open()).rejects.toEqual(
      expect.objectContaining({
        name: 'AppUpdateCapabilityError',
        code: 'native_failure',
        message: 'Desktop could not open the update surface.',
      }),
    )
    expect(openSurface).toHaveBeenCalledOnce()
  })

  it('unsubscribes its native listener when the initial state is invalid', async () => {
    const unlisten = vi.fn()

    await expect(createTauriAppUpdateCapabilityWithTransport({
      listenSnapshot: async () => unlisten,
      readSnapshot: async () => ({ sequence: -1, state: { kind: 'idle' } }),
      openSurface: async () => undefined,
    })).rejects.toEqual(expect.objectContaining({
      code: 'native_failure',
      message: 'Desktop update state is unavailable.',
    }))
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('normalizes native subscription failures', async () => {
    await expect(createTauriAppUpdateCapabilityWithTransport({
      listenSnapshot: async () => {
        throw new Error('secret event detail')
      },
      readSnapshot: async () => ({ sequence: 0, state: { kind: 'idle' } }),
      openSurface: async () => undefined,
    })).rejects.toEqual(expect.objectContaining({
      name: 'AppUpdateCapabilityError',
      code: 'native_failure',
      message: 'Desktop update state is unavailable.',
    }))
  })

  it('maps retryable failures and unknown-length downloads without native fields', async () => {
    let publishNative: (snapshot: unknown) => void = () => undefined
    const capability = await createTauriAppUpdateCapabilityWithTransport({
      listenSnapshot: async observer => {
        publishNative = observer
        return () => undefined
      },
      readSnapshot: async () => ({
        sequence: 7,
        state: { kind: 'failed', operation: 'download', retryable: true, message: 'Try again' },
        automatic_download: false,
        next_check_at: { secs: 10, nanos: 0 },
      }),
      openSurface: async () => undefined,
    })
    const observer = vi.fn()
    capability.observe(observer)
    publishNative({
      sequence: 8,
      state: {
        kind: 'downloading',
        version: '2.1.0',
        release_notes: 'Ready',
        progress: { kind: 'unknown_total', downloaded_bytes: 512 },
      },
    })

    expect(observer.mock.calls).toEqual([
      [{ kind: 'failed', operation: 'download', retryable: true, message: 'Try again' }],
      [{
        kind: 'downloading',
        version: '2.1.0',
        releaseNotes: 'Ready',
        downloadedBytes: 512,
      }],
    ])
  })
})
