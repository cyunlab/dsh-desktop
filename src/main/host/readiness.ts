export interface ReadinessOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
  readonly fetch?: typeof globalThis.fetch
  readonly signal?: AbortSignal
}

/** 轮询 Host HTTP surface；默认给首次 Harness 组合留出宽松启动窗口。 */
export async function waitForHttpReady(origin: string, options: ReadinessOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const intervalMs = options.intervalMs ?? 100
  const request = options.fetch ?? globalThis.fetch
  const signal = options.signal
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    throwIfAborted(signal)
    const remaining = Math.max(1, deadline - Date.now())
    const requestControl = createRequestController(signal, Math.min(1_000, remaining))
    try {
      const response = await raceWithAbort(
        request(origin, { redirect: 'error', signal: requestControl.signal }),
        requestControl.signal
      )
      throwIfAborted(signal)
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal)
      lastError = error
    } finally {
      requestControl.dispose()
    }
    await waitForDelay(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal)
  }
  throw new Error(`Host did not become ready within ${timeoutMs} ms`, { cause: lastError })
}

/** 即使测试或替代 fetch 不尊重 AbortSignal，也能结束当前请求等待。 */
async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => finish(undefined, abortReason(signal))
    const finish = (value?: T, error?: unknown): void => {
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolve(value as T)
      else reject(error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(value => finish(value), error => finish(undefined, error))
  })
}

/** 在单次 fetch 上施加可取消且会被清理的超时控制器。 */
function createRequestController(parent: AbortSignal | undefined, timeoutMs: number): {
  readonly signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(parent?.reason)
  const timeout = setTimeout(() => controller.abort(new Error('Host readiness request timed out')), timeoutMs)
  parent?.addEventListener('abort', onAbort, { once: true })
  if (parent?.aborted) onAbort()
  return {
    signal: controller.signal,
    dispose(): void {
      clearTimeout(timeout)
      parent?.removeEventListener('abort', onAbort)
    }
  }
}

/** 等待下一次轮询并在调用方取消时立即释放 timer。 */
function waitForDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal)
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => finish(abortReason(signal))
    const finish = (error?: unknown): void => {
      if (timer === undefined) return
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    timer = setTimeout(() => finish(), milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/** 统一把已取消的 readiness 转换为调用方提供的 reason。 */
function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error('Host readiness was cancelled')
}

/** 在开始网络请求或 timer 前抛出取消原因。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}
