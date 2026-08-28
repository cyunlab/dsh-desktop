export type UpdateSmokeTarget = 'windows-x86_64' | 'linux-x86_64' | 'darwin-aarch64' | 'darwin-x86_64'
export type UpdateSmokeEvidenceKind = 'real-native' | 'local-fixture' | 'source-rebuild'
export type BaselineProvenance = 'published-release' | 'source-rebuild' | 'local-fixture'

export interface UpdateSmokeEvidence {
  readonly schema_version: 1
  readonly evidence_kind: UpdateSmokeEvidenceKind
  readonly target: UpdateSmokeTarget
  readonly runner: { readonly os: string; readonly arch: string }
  readonly candidate: {
    readonly tag: string
    readonly version: string
    readonly commit: string
    readonly manifest_sha256: string
    readonly package_sha256: string
    readonly signature_sha256: string
  }
  readonly baseline: {
    readonly tag: string
    readonly version: string
    readonly commit: string
    readonly provenance: BaselineProvenance
    readonly artifact_sha256: string
    readonly signature_sha256: string
    readonly stable_manifest_sha256: string
    readonly artifact_url: string
  }
  readonly started_at: string
  readonly completed_at: string
  readonly platform: Readonly<Record<string, string | boolean>>
  readonly observations: Readonly<Record<string, boolean>>
  readonly checkpoints: readonly { readonly id: string; readonly status: 'passed' | 'failed'; readonly details?: string }[]
  readonly diagnostics?: string
}

export interface UpdateSmokeExpectations {
  readonly tag: string
  readonly version: string
  readonly commit: string
  readonly manifest_sha256: string
  readonly baselineTag?: string
  readonly baseline_manifest_sha256?: string
  readonly maxAgeHours: number
  readonly requireRealNative?: boolean
  readonly now?: Date
}

export const REQUIRED_SMOKE_TARGETS: readonly UpdateSmokeTarget[]
export const REQUIRED_SMOKE_CHECKPOINTS: readonly string[]

/** 验证单目标 evidence，供原生 harness 落盘前调用。 */
export function verifyUpdateSmokeEvidenceDocument(document: UpdateSmokeEvidence, expectations: UpdateSmokeExpectations): UpdateSmokeTarget

/** 验证内存中的完整四目标 evidence 集合。 */
export function verifyUpdateSmokeEvidenceSet(documents: readonly UpdateSmokeEvidence[], expectations: UpdateSmokeExpectations): {
  readonly schemaVersion: 1
  readonly targets: readonly UpdateSmokeTarget[]
  readonly candidate: Readonly<Pick<UpdateSmokeEvidence['candidate'], 'tag' | 'version' | 'commit' | 'manifest_sha256'>>
}

/** 验证目录内严格命名、逐字节 checksum 的四目标 evidence。 */
export function verifyUpdateSmokeEvidenceDirectory(directory: string, expectations: UpdateSmokeExpectations): Promise<ReturnType<typeof verifyUpdateSmokeEvidenceSet>>

/** 运行公开 evidence verifier CLI。 */
export function runUpdateSmokeEvidenceCli(args?: string[], now?: Date): Promise<ReturnType<typeof verifyUpdateSmokeEvidenceSet>>
