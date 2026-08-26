export interface GhResult { exitCode: number; stdout: string; stderr: string }
export interface ReconcileOptions {
  repository: string | undefined
  tag: string | undefined
  title: string
  notesFile: string | undefined
  artifacts: string[]
}
/** 创建或更新指定 tag 的草稿发布。 */
export function reconcileDraftRelease(
  options: ReconcileOptions,
  dependencies?: { runGh?: (args: string[]) => Promise<GhResult> }
): Promise<'created' | 'updated'>
