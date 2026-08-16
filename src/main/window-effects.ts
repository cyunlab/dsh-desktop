export async function openExternalSafely(openExternal: (url: string) => Promise<unknown>, url: string): Promise<void> {
  try { await openExternal(url) } catch { /* Future diagnostics are tracked separately. */ }
}

export async function navigateToHostSafely(
  loadHost: () => Promise<unknown>,
  restoreStartupPage: () => Promise<unknown>,
  onFailure: (error: unknown) => void
): Promise<void> {
  try {
    await loadHost()
  } catch (error) {
    try { await restoreStartupPage() } catch { /* The window remains controlled even if rendering fails. */ }
    onFailure(error)
  }
}
