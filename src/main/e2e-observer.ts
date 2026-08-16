import { appendFile } from 'node:fs/promises'

export function recordE2EEvent(event: 'second-instance' | 'external-link'): void {
  const file = process.env.DSH_DESKTOP_TEST_EVENTS
  if (!file) return
  void appendFile(file, `${JSON.stringify({ event })}\n`, 'utf8').catch(() => undefined)
}

export function shouldSuppressExternalOpen(): boolean {
  return process.env.DSH_DESKTOP_TEST_EVENTS !== undefined
}
