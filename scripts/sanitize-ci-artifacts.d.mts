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

/** 清除 CI 文本中的凭据、用户内容和精确 URL 位置。 */
export function redactCiText(value: string): string
/** 输出受大小限制的脱敏诊断文件。 */
export function sanitizeArtifactDirectory(options?: SanitizeOptions): Promise<SanitizeResult>
