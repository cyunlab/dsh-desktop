import { appendFile } from 'node:fs/promises'

export type E2EEvent = 'second-instance' | 'external-link' | 'window-restored' | 'window-shown' | 'window-focused'

let pendingWrite = Promise.resolve()

export function recordE2EEvent(event: E2EEvent): void {
  const file = process.env.DSH_DESKTOP_TEST_EVENTS
  if (!file) return
  pendingWrite = pendingWrite
    .then(() => appendFile(file, `${JSON.stringify({ event })}\n`, 'utf8'))
    .catch(() => undefined)
}

export function shouldSuppressExternalOpen(): boolean {
  return process.env.DSH_DESKTOP_TEST_EVENTS !== undefined
}
