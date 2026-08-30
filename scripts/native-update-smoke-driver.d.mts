export interface NativeUpdateDriverOptions {
  readonly target: string
  readonly baselineArtifact: string
  readonly baselineSignature: string
  readonly baselineVersion: string
  readonly candidatePackage: string
  readonly candidateSignature: string
  readonly candidateVersion: string
  readonly candidateManifest: Buffer
  readonly candidatePackageSha256: string
  readonly updaterEndpoint: string
  readonly updaterPublicKey: string
  readonly updaterPublicKeySha256: string
  readonly signingConfigured: 'true' | 'false'
  readonly [key: string]: unknown
}

export interface NativeUpdatePlatformAdapter {
  readonly runner: Readonly<Record<string, unknown>>
  readonly platform: Readonly<Record<string, unknown>>
  assertRunner(target: string): void
  installBaseline(options: NativeUpdateDriverOptions): Promise<unknown>
  inspectInstalledRuntime(installation: unknown, options: NativeUpdateDriverOptions): Promise<Record<string, boolean>>
  withTlsGate(config: { readonly endpoint: string; readonly manifest: Buffer }, action: (gate: {
    waitForRequest(): Promise<void>
    restoreRouting(): Promise<void>
    releaseManifest(): Promise<void>
  }) => Promise<void>): Promise<void>
  launch(installation: unknown, options: NativeUpdateDriverOptions): Promise<unknown>
  waitForReady(launch: unknown, version: string, options: NativeUpdateDriverOptions): Promise<void>
  waitForStaged(installation: unknown, options: NativeUpdateDriverOptions): Promise<void>
  requestNormalClose(launch: unknown, installation: unknown, options: NativeUpdateDriverOptions): Promise<void>
  waitForNormalClose(launch: unknown, installation: unknown, options: NativeUpdateDriverOptions): Promise<void>
  inspectUpdatedInstallation(installation: unknown, options: NativeUpdateDriverOptions): Promise<unknown>
  assertNotRelaunched(launch: unknown, installation: unknown, options: NativeUpdateDriverOptions): Promise<void>
  cleanup(): Promise<void>
}

/** 在接触安装包前确认真实 runner 与目标完全一致。 */
export function assertNativeRunner(target: string): void

/** 执行 previous-Stable 正常退出安装，并证明同一安装位置的新版本重新达到 Host Ready。 */
export function runNativeUpdateSmokeDriver(options: NativeUpdateDriverOptions, platformAdapter: NativeUpdatePlatformAdapter): Promise<{
  readonly runner: Readonly<Record<string, unknown>>
  readonly started_at: string
  readonly completed_at: string
  readonly platform: Readonly<Record<string, unknown>>
  readonly observations: Readonly<Record<string, boolean>>
  readonly checkpoints: readonly { readonly id: string; readonly status: 'passed' }[]
}>
