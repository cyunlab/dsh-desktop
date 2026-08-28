import type { BaselineProvenance, UpdateSmokeEvidence, UpdateSmokeTarget } from './verify-update-smoke-evidence.mjs'

export interface NativeUpdateSmokeOptions {
  readonly target: UpdateSmokeTarget
  readonly candidateTag: string
  readonly candidateCommit: string
  readonly candidateManifest: string
  readonly candidatePackage: string
  readonly candidateSignature: string
  readonly baselineTag: string
  readonly baselineVersion: string
  readonly baselineCommit: string
  readonly baselineArtifact: string
  readonly baselineSignature: string
  readonly baselineStableManifest: string
  readonly baselineProvenance: BaselineProvenance
  readonly baselineArtifactUrl: string
  readonly outputDirectory: string
}

/** 运行 native driver 并生成 checksummed evidence。 */
export function runNativeUpdateSmoke(
  options: NativeUpdateSmokeOptions,
  environment?: NodeJS.ProcessEnv,
  dependencies?: {
    readonly runDriver?: (executable: string, args: string[], environment: NodeJS.ProcessEnv) => Promise<{ readonly stdout: Buffer; readonly stderr: string }>
  }
): Promise<{ readonly evidence: UpdateSmokeEvidence; readonly evidencePath: string; readonly checksumPath: string }>
