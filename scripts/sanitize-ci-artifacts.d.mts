interface SanitizeOptions {
  workspace?: string
  outputDirectory?: string
  candidates?: readonly string[]
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}

interface SanitizeResult {
  files: readonly { source: string; output: string; bytes: number; truncated: boolean }[]
  omitted: readonly string[]
  totalBytes: number
}

export function redactCiText(value: string): string
export function sanitizeArtifactDirectory(options?: SanitizeOptions): Promise<SanitizeResult>
