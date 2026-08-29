export type BootstrapUpdateTarget = 'windows-x86_64' | 'linux-x86_64' | 'darwin-aarch64' | 'darwin-x86_64'
export type BootstrapEvidenceKind = 'bootstrap-fresh-install' | 'bootstrap-local-fixture'

export interface BootstrapUpdateEvidence {
  readonly schema_version: 1
  readonly evidence_kind: BootstrapEvidenceKind
  readonly claims_previous_stable_upgrade: false
  readonly target: BootstrapUpdateTarget
  readonly runner: { readonly os: string; readonly arch: string }
  readonly candidate: {
    readonly tag: string
    readonly version: string
    readonly commit: string
    readonly provenance: 'published-release' | 'local-fixture'
    readonly release_url: string
    readonly manifest_url: string
    readonly manifest_sha256: string
    readonly package_url: string
    readonly package_sha256: string
    readonly signature_sha256: string
  }
  readonly installation: { readonly mode: 'fresh-install'; readonly installed_version: string; readonly launched: true }
  readonly started_at: string
  readonly completed_at: string
  readonly platform: Readonly<Record<string, string | boolean>>
  readonly observations: Readonly<Record<string, boolean>>
  readonly diagnostics?: string
}

export interface BootstrapUpdateExpectations {
  readonly tag: string
  readonly version: string
  readonly commit: string
  readonly manifest_sha256: string
  readonly maxAgeHours: number
  readonly requireRealBootstrap?: boolean
  readonly now?: Date
}

export const REQUIRED_BOOTSTRAP_TARGETS: readonly BootstrapUpdateTarget[]

/** 验证单目标 bootstrap evidence。 */
export function verifyBootstrapUpdateEvidenceDocument(document: unknown, expectations: BootstrapUpdateExpectations): BootstrapUpdateTarget

/** 验证内存中的完整四目标 bootstrap evidence 集。 */
export function verifyBootstrapUpdateEvidenceSet(documents: readonly unknown[], expectations: BootstrapUpdateExpectations): {
  readonly schemaVersion: 1
  readonly targets: readonly BootstrapUpdateTarget[]
  readonly candidate: Readonly<Pick<BootstrapUpdateEvidence['candidate'], 'tag' | 'version' | 'commit' | 'manifest_sha256'>>
}

/** 验证目录内严格命名和 checksummed 的 bootstrap evidence。 */
export function verifyBootstrapUpdateEvidenceDirectory(directory: string, expectations: BootstrapUpdateExpectations): Promise<ReturnType<typeof verifyBootstrapUpdateEvidenceSet>>

/** 运行公开 bootstrap verifier CLI。 */
export function runBootstrapUpdateEvidenceCli(args?: string[], now?: Date): Promise<ReturnType<typeof verifyBootstrapUpdateEvidenceSet>>
