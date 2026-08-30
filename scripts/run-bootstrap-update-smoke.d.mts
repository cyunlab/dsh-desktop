import type { BootstrapUpdateEvidence, BootstrapUpdateTarget } from './verify-bootstrap-update-evidence.mjs'

export interface BootstrapUpdateSmokeOptions {
  readonly target: BootstrapUpdateTarget
  readonly candidateTag: string
  readonly candidateCommit: string
  readonly candidateManifest: string
  readonly candidateManifestUrl: string
  readonly candidatePackage: string
  readonly candidateSignature: string
  readonly candidatePackageUrl: string
  readonly candidateReleaseUrl: string
  readonly expectedUpdaterEndpoint: string
  readonly expectedUpdaterPublicKey: string
  readonly signingConfigured: 'true' | 'false'
  readonly outputDirectory: string
}

/** 运行 bootstrap native driver 并生成 checksummed evidence。 */
export function runBootstrapUpdateSmoke(
  options: BootstrapUpdateSmokeOptions,
  environment?: NodeJS.ProcessEnv,
  dependencies?: {
    readonly runDriver?: (executable: string, args: string[], environment: NodeJS.ProcessEnv) => Promise<{ readonly stdout: Buffer; readonly stderr: string }>
  }
): Promise<{ readonly evidence: BootstrapUpdateEvidence; readonly evidencePath: string; readonly checksumPath: string }>
