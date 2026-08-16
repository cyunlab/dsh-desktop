export interface ReadinessOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
  readonly fetch?: typeof globalThis.fetch
}

export async function waitForHttpReady(origin: string, options: ReadinessOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const intervalMs = options.intervalMs ?? 100
  const request = options.fetch ?? globalThis.fetch
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    try {
      const response = await request(origin, {
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(1_000, remaining))
      })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))))
  }
  throw new Error(`Host did not become ready within ${timeoutMs} ms`, { cause: lastError })
}
