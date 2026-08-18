import type { DesktopPaths } from '../paths.js'
import { prepareDesktopPaths } from '../paths.js'
import type { HostHandle, HostLauncher } from '../host/launcher.js'
import type { LifecycleSnapshot, LifecycleState } from '../../shared/startup-contract.js'
import { userFacingStartupError } from './startup-failure.js'
import { NullDiagnostics, type DiagnosticsSink } from '../diagnostics.js'

type SnapshotListener = (snapshot: LifecycleSnapshot) => void

export class ApplicationLifecycle {
  #snapshot: LifecycleSnapshot = Object.freeze({ state: 'idle', message: 'Waiting to start' })
  #handle?: HostHandle
  #operation?: Promise<void>
  #retryOperation?: Promise<void>
  #navigationFailureOperation?: Promise<void>
  #stopping?: Promise<void>
  #shutdownRequested = false
  readonly #listeners = new Set<SnapshotListener>()

  constructor(readonly launcher: HostLauncher, readonly paths: DesktopPaths, readonly shutdownTimeoutMs = 5_000, readonly diagnostics: DiagnosticsSink = new NullDiagnostics()) {}
  get snapshot(): LifecycleSnapshot { return this.#snapshot }
  subscribe(listener: SnapshotListener): () => void { this.#listeners.add(listener); listener(this.#snapshot); return () => this.#listeners.delete(listener) }

  start(): Promise<void> { return this.#run(false) }
  retry(): Promise<void> {
    if (this.#shutdownRequested) return this.#stopping ?? Promise.resolve()
    if (this.#retryOperation) return this.#retryOperation
    if (this.#snapshot.state !== 'failed') return this.#operation ?? Promise.resolve()
    // A failed snapshot is published just before the current boot promise's
    // finally handler clears it. Queue the fresh attempt so a renderer retry
    // received in that small window is not mistaken for the failed attempt.
    const previous = this.#operation
    this.#retryOperation = (async () => {
      await previous?.catch(() => undefined)
      if (this.#shutdownRequested) return
      await this.#run(true)
    })().finally(() => { this.#retryOperation = undefined })
    return this.#retryOperation
  }
  #run(retry: boolean): Promise<void> {
    if (this.#operation) return this.#operation
    this.#operation = this.#boot(retry).finally(() => { this.#operation = undefined })
    return this.#operation
  }
  async #boot(retry: boolean): Promise<void> {
    try {
      if (this.#shutdownRequested) return
      if (retry) {
        this.#transition('retrying', 'Retrying startup')
        await this.#disposeHandle()
        if (this.#shutdownRequested) return
      }
      this.#transition('preparing', 'Preparing application data')
      await prepareDesktopPaths(this.paths)
      if (this.#shutdownRequested) return
      this.#transition('booting', 'Starting local Host')
      const handle = await this.launcher.launch(this.paths)
      if (this.#shutdownRequested) {
        await handle.dispose()
        return
      }
      this.#handle = handle
      this.#observeHostClosure(handle)
      if (handle.binding) this.diagnostics.assignedPort(handle.binding.port)
      this.#transition('probing', 'Checking local Web Client', this.#handle.origin)
      this.#transition('ready', 'Web Client is ready', this.#handle.origin)
    } catch (error) {
      if (!this.#shutdownRequested) this.diagnostics.failure('host-startup', error)
      try { await this.#disposeHandle() }
      catch (disposeError) {
        if (!this.#shutdownRequested) this.diagnostics.failure('host-disposal', disposeError)
      }
      if (!this.#shutdownRequested) this.#transition('failed', userFacingStartupError('host-startup', error))
    }
  }
  reportHostNavigationFailure(error: unknown): Promise<void> {
    if (this.#navigationFailureOperation) return this.#navigationFailureOperation
    if (this.#shutdownRequested || this.#snapshot.state !== 'ready') return Promise.resolve()
    this.#navigationFailureOperation = this.#recoverFromNavigationFailure(error)
      .finally(() => { this.#navigationFailureOperation = undefined })
    return this.#navigationFailureOperation
  }
  async #recoverFromNavigationFailure(error: unknown): Promise<void> {
    this.diagnostics.failure('host-navigation', error)
    try { await this.#disposeHandle() }
    catch (disposeError) {
      if (!this.#shutdownRequested) this.diagnostics.failure('host-disposal', disposeError)
    }
    if (this.#shutdownRequested) return
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
      await this.#retryOperation?.catch(() => undefined)
      await this.#operation?.catch(() => undefined)
      await this.#navigationFailureOperation?.catch(() => undefined)
      await this.#disposeHandle().catch(error => {
        if (this.#snapshot.state === 'stopping') this.diagnostics.failure('host-shutdown', error)
      })
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      await Promise.race([
        cleanup(),
        new Promise<void>(resolve => {
          timeout = setTimeout(() => { timedOut = true; resolve() }, this.shutdownTimeoutMs)
        })
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
    if (timedOut) this.diagnostics.failure('host-shutdown-timeout', new Error('Host shutdown exceeded its configured bound'))
    this.#transition('stopped', 'Stopped')
  }
  async flushDiagnostics(timeoutMs = 1_000): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.diagnostics.flush(),
        new Promise<void>(resolve => { timeout = setTimeout(resolve, timeoutMs) })
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }
  async #disposeHandle(): Promise<void> { const handle = this.#handle; this.#handle = undefined; await handle?.dispose() }

  /** 将 ready 后的意外 Host 退出转换为可恢复的 failed 状态。 */
  #observeHostClosure(handle: HostHandle): void {
    if (!handle.closed) return
    void handle.closed.then(event => {
      if (event.intentional || this.#shutdownRequested || this.#handle !== handle || this.#snapshot.state !== 'ready') return
      this.#handle = undefined
      const error = event.error ?? new Error(`Host child exited with ${event.code ?? event.signal ?? 'unknown'}`)
      this.diagnostics.failure('host-runtime', error)
      this.#transition('failed', userFacingStartupError('host-startup', error))
    }).catch(error => {
      if (this.#shutdownRequested || this.#handle !== handle || this.#snapshot.state !== 'ready') return
      this.#handle = undefined
      this.diagnostics.failure('host-runtime', error)
      this.#transition('failed', userFacingStartupError('host-startup', error))
    })
  }

  #transition(state: LifecycleState, message: string, origin?: string): void {
    this.#snapshot = Object.freeze({ state, message, ...(origin ? { origin } : {}) })
    this.diagnostics.lifecycle(this.#snapshot)
    for (const listener of this.#listeners) listener(this.#snapshot)
  }
}
