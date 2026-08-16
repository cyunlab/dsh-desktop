export type StartupFailureKind = 'host-startup' | 'host-navigation'

const messages: Record<StartupFailureKind, string> = {
  'host-startup': 'The local Host could not start. Retry or copy diagnostics for help.',
  'host-navigation': 'The local Web Client could not be opened. Retry or copy diagnostics for help.'
}

/** Maps failures to bounded, stable copy. Exception text never crosses into the renderer. */
export function userFacingStartupError(kind: StartupFailureKind, _error: unknown): string {
  return messages[kind]
}
