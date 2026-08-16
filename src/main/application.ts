import type { DesktopPaths } from './paths.js'
import { prepareDesktopPaths } from './paths.js'
import type { HostHandle, HostLauncher } from './host-launcher.js'
import type { LifecycleSnapshot, LifecycleState } from '../shared/startup-contract.js'
import { userFacingStartupError } from './user-facing-error.js'

type SnapshotListener = (snapshot: LifecycleSnapshot) => void

export class ApplicationLifecycle {
  #snapshot: LifecycleSnapshot = Object.freeze({ state: 'idle', message: 'Waiting to start' })
  #handle?: HostHandle
  #operation?: Promise<void>
  #stopping?: Promise<void>
  #shutdownRequested = false
  readonly #listeners = new Set<SnapshotListener>()

  constructor(readonly launcher: HostLauncher, readonly paths: DesktopPaths, readonly shutdownTimeoutMs = 5_000) {}
  get snapshot(): LifecycleSnapshot { return this.#snapshot }
  subscribe(listener: SnapshotListener): () => void { this.#listeners.add(listener); listener(this.#snapshot); return () => this.#listeners.delete(listener) }

  start(): Promise<void> { return this.#run(false) }
  retry(): Promise<void> {
    if (this.#snapshot.state !== 'failed') return this.#operation ?? Promise.resolve()
    return this.#run(true)
  }
  #run(retry: boolean): Promise<void> {
    if (this.#operation) return this.#operation
    this.#operation = this.#boot(retry).finally(() => { this.#operation = undefined })
    return this.#operation
  }
  async #boot(retry: boolean): Promise<void> {
    try {
      if (retry) { this.#transition('retrying', 'Retrying startup'); await this.#disposeHandle() }
      this.#transition('preparing', 'Preparing application data')
      await prepareDesktopPaths(this.paths)
      this.#transition('booting', 'Starting local Host')
      const handle = await this.launcher.launch(this.paths)
      if (this.#shutdownRequested) {
        await handle.dispose()
        return
      }
      this.#handle = handle
      this.#transition('probing', 'Checking local Web Client', this.#handle.origin)
      this.#transition('ready', 'Web Client is ready', this.#handle.origin)
    } catch (error) {
      await this.#disposeHandle().catch(() => undefined)
      if (!this.#shutdownRequested) this.#transition('failed', userFacingStartupError('host-startup', error))
    }
  }
  async reportHostNavigationFailure(error: unknown): Promise<void> {
    if (this.#shutdownRequested || this.#snapshot.state !== 'ready') return
    await this.#disposeHandle().catch(() => undefined)
    this.#transition('failed', userFacingStartupError('host-navigation', error))
  }
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping
    this.#stopping = this.#stop()
    return this.#stopping
  }
  async #stop(): Promise<void> {
    if (this.#snapshot.state === 'stopped') return
    this.#shutdownRequested = true
    this.#transition('stopping', 'Stopping local Host')
    const cleanup = async (): Promise<void> => {
      // A launch that has not returned a handle yet still owns resources and
      // process-global path state. Its shutdown branch disposes that late
      // handle; wait for the whole branch before declaring cleanup complete.
      await this.#operation?.catch(() => undefined)
      await this.#disposeHandle()
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        cleanup(),
        new Promise<void>(resolve => { timeout = setTimeout(resolve, this.shutdownTimeoutMs) })
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
    this.#transition('stopped', 'Stopped')
  }
  async #disposeHandle(): Promise<void> { const handle = this.#handle; this.#handle = undefined; await handle?.dispose() }
  #transition(state: LifecycleState, message: string, origin?: string): void {
    this.#snapshot = Object.freeze({ state, message, ...(origin ? { origin } : {}) })
    for (const listener of this.#listeners) listener(this.#snapshot)
  }
}
