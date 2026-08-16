import type { LifecycleSnapshot } from '../shared/startup-contract.js'
import { buildRedactedDiagnosticSummary, type DiagnosticContext, type DiagnosticsSink } from './diagnostics.js'

export interface StartupNativeActions {
  writeClipboard(text: string): void
  revealPath(path: string): Promise<string>
}

export function createStartupActions(
  getSnapshot: () => LifecycleSnapshot,
  context: DiagnosticContext,
  logsPath: string,
  native: StartupNativeActions,
  diagnostics: DiagnosticsSink
) {
  return {
    async copyDiagnostics(): Promise<void> {
      try { native.writeClipboard(buildRedactedDiagnosticSummary(getSnapshot(), context)) }
      catch (error) { diagnostics.actionFailure('copy-diagnostics', error) }
    },
    async revealLogs(): Promise<void> {
      try {
        const result = await native.revealPath(logsPath)
        if (result) diagnostics.actionFailure('reveal-logs', new Error(result))
      } catch (error) { diagnostics.actionFailure('reveal-logs', error) }
    }
  }
}
