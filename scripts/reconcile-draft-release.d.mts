export interface GhResult { exitCode: number; stdout: string; stderr: string }
export interface ReconcileOptions {
  repository: string | undefined
  tag: string | undefined
  title: string
  notesFile: string | undefined
  artifacts: string[]
}
export function reconcileDraftRelease(
  options: ReconcileOptions,
  dependencies?: { runGh?: (args: string[]) => Promise<GhResult> }
): Promise<'created' | 'updated'>
