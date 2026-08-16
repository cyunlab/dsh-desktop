export type E2EEvent = 'startup-page-loaded' | 'web-client-loaded' | 'second-instance' | 'external-link' | 'window-restored' | 'window-shown' | 'window-focused'

let pendingWrite: Promise<unknown> | undefined

export function recordE2EEvent(event: E2EEvent): void {
  const file = process.env.DSH_DESKTOP_TEST_EVENTS
  if (!file) return
  pendingWrite = (pendingWrite ?? Promise.resolve())
    .then(async () => {
      const { appendFile } = await import('node:fs/promises')
      await appendFile(file, `${JSON.stringify({ event })}\n`, 'utf8')
    })
    .catch(() => undefined)
}

export function shouldSuppressExternalOpen(): boolean {
  return process.env.DSH_DESKTOP_TEST_EVENTS !== undefined
}
