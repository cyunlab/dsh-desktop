export interface PrepareUpdateSmokeAssetOptions {
  readonly manifestUrl: string
  readonly target: string
  readonly expectedVersion: string
  readonly outputDirectory: string
  readonly label: 'baseline' | 'candidate'
}

/** 从 manifest 下载并验证一个 target 的 content-addressed updater。 */
export function prepareUpdateSmokeAsset(options: PrepareUpdateSmokeAssetOptions, dependencies?: { readonly fetcher?: (url: string, init?: RequestInit) => Promise<Response> }): Promise<{
  readonly artifactPath: string
  readonly signaturePath: string
  readonly manifestPath: string
  readonly artifactUrl: string
  readonly packageSha256: string
  readonly signatureSha256: string
  readonly manifestSha256: string
}>
