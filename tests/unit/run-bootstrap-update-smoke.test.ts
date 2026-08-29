import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { runBootstrapUpdateSmoke } from '../../scripts/run-bootstrap-update-smoke.mjs'

const roots: string[] = []

/** 创建 bootstrap producer 的固定候选输入。 */
async function inputs() {
  const directory = await mkdtemp(path.join(tmpdir(), 'bootstrap-update-smoke-'))
  roots.push(directory)
  const candidatePackage = path.join(directory, 'candidate.exe')
  const candidateSignature = path.join(directory, 'candidate.exe.sig')
  const candidateManifest = path.join(directory, 'candidate-manifest.json')
  await Promise.all([
    writeFile(candidatePackage, 'candidate-package'),
    writeFile(candidateSignature, 'candidate-signature'),
    writeFile(candidateManifest, '{"version":"2.1.0"}\n')
  ])
  return {
    target: 'windows-x86_64' as const,
    candidateTag: 'v2.1.0',
    candidateCommit: '1'.repeat(40),
    candidateManifest,
    candidateManifestUrl: `https://updates.cyunlab.com/dsh-desktop/candidates/2.1.0/${'1'.repeat(40)}/${createHash('sha256').update('{"version":"2.1.0"}\n').digest('hex')}-latest.json`,
    candidatePackage,
    candidateSignature,
    candidatePackageUrl: 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/windows-x86_64/placeholder-package.exe',
    candidateReleaseUrl: 'https://github.com/cyunlab/dsh-desktop/releases/tag/v2.1.0',
    expectedUpdaterEndpoint: 'https://updates.cyunlab.com/dsh-desktop/channels/stable/latest.json',
    expectedUpdaterPublicKey: Buffer.from('untrusted comment: minisign public key fixture\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').toString('base64'),
    signingConfigured: 'false' as const,
    outputDirectory: directory
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('bootstrap update smoke producer public seam', () => {
  /** 未配置 repository-owned driver 时 producer 必须在落盘前 fail closed。 */
  it('fails without writing evidence when native fresh-install automation is unavailable', async () => {
    const options = await inputs()
    await expect(runBootstrapUpdateSmoke(options, {})).rejects.toThrow('DSH_BOOTSTRAP_UPDATE_SMOKE_DRIVER is required')
    await expect(readFile(path.join(options.outputDirectory, 'windows-x86_64.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  /** macOS signing 决策必须由 production 显式给出合法布尔文本。 */
  it('rejects a missing or invalid signing decision before invoking the driver', async () => {
    const missing = await inputs()
    delete (missing as Partial<typeof missing>).signingConfigured
    await expect(runBootstrapUpdateSmoke(missing, { DSH_BOOTSTRAP_UPDATE_SMOKE_DRIVER: '/test/adapter' }, { runDriver: async () => { throw new Error('must not run') } })).rejects.toThrow('signingConfigured')
    const invalid = await inputs()
    ;(invalid as { signingConfigured: string }).signingConfigured = 'auto'
    await expect(runBootstrapUpdateSmoke(invalid, { DSH_BOOTSTRAP_UPDATE_SMOKE_DRIVER: '/test/adapter' }, { runDriver: async () => { throw new Error('must not run') } })).rejects.toThrow('true or false')
  })

  /** production producer 只允许固定 repo-owned driver，错误 runner 必须在产证前 fail closed。 */
  it('rejects external drivers and emits nothing on a mismatched native runner', async () => {
    const external = await inputs()
    await expect(runBootstrapUpdateSmoke(external, { DSH_BOOTSTRAP_UPDATE_SMOKE_DRIVER: '/tmp/untrusted-bootstrap-driver' }))
      .rejects.toThrow('fixed repository-owned native driver')
    const repositoryOwned = await inputs()
    await expect(runBootstrapUpdateSmoke(repositoryOwned, {
      DSH_BOOTSTRAP_UPDATE_SMOKE_DRIVER: 'scripts/bootstrap-update-smoke-driver.mjs',
      PATH: process.env.PATH
    })).rejects.toThrow('hosted runner does not match bootstrap target')
    await expect(readFile(path.join(repositoryOwned.outputDirectory, 'windows-x86_64.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  /** 测试 adapter 只能生成独立 local fixture，不能冒充 production bootstrap。 */
  it('writes checksummed bootstrap-local-fixture evidence from a complete test adapter', async () => {
    const options = await inputs()
    const digest = createHash('sha256').update('candidate-package').digest('hex')
    options.candidatePackageUrl = `https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/windows-x86_64/${digest.slice(0, 12)}-candidate.exe`
    const completedAt = new Date(Date.now() - 60_000)
    const observation = {
      runner: { os: 'windows', arch: 'x86_64' },
      started_at: new Date(completedAt.valueOf() - 10 * 60_000).toISOString(),
      completed_at: completedAt.toISOString(),
      installation: { mode: 'fresh-install', installed_version: '2.1.0', launched: true },
      platform: { package_kind: 'nsis-exe', install_scope: 'current-user', authenticode: 'not-required', code_signing: 'not-applicable', notarization: 'not-applicable', install_registry_root: 'HKCU', install_location_class: 'user-profile', msi_present: false },
      observations: Object.fromEntries([
        'updater_endpoint_enabled', 'updater_public_key_enabled', 'updater_signature_verified', 'immutable_object_identity_verified',
        'official_node', 'cli_runtime_closure', 'desktop_capabilities_package', 'desktop_update_client_package', 'composition_patch'
      ].map(key => [key, true])),
      observation_sources: {
        configuration_identity: 'runtime-jsonl', signature_identity: 'node-ed25519-minisign', package_identity: 'immutable-manifest-sha256',
        installation_identity: 'native-platform', host_readiness: 'fixed-origin-http', runtime_closure: 'installed-filesystem'
      }
    }
    let invocation: { args?: string[]; environment?: NodeJS.ProcessEnv } = {}
    const result = await runBootstrapUpdateSmoke(options, { DSH_BOOTSTRAP_UPDATE_SMOKE_DRIVER: '/test/adapter', PATH: '/trusted/bin', HOME: '/home/runner', TMPDIR: '/tmp' }, {
      runDriver: async (_executable: string, args: string[], environment: NodeJS.ProcessEnv) => {
        invocation = { args, environment }
        return { stdout: Buffer.from(JSON.stringify(observation)), stderr: '' }
      }
    })
    expect(result.evidence.evidence_kind).toBe('bootstrap-local-fixture')
    expect(result.evidence.claims_previous_stable_upgrade).toBe(false)
    expect(await readFile(result.checksumPath, 'utf8')).toMatch(/^[0-9a-f]{64}  windows-x86_64\.json\n$/)
    expect(invocation.args).toEqual(expect.arrayContaining([
      '--candidate-manifest-url', options.candidateManifestUrl,
      '--candidate-package-url', options.candidatePackageUrl,
      '--expected-updater-endpoint', options.expectedUpdaterEndpoint,
      '--expected-updater-public-key', options.expectedUpdaterPublicKey,
      '--expected-manifest-sha256', createHash('sha256').update('{"version":"2.1.0"}\n').digest('hex'),
      '--expected-package-sha256', digest
    ]))
    expect(invocation.environment).toEqual({ PATH: '/trusted/bin', HOME: '/home/runner', TMPDIR: '/tmp', DSH_BOOTSTRAP_UPDATE_SMOKE_OUTPUT: 'json' })
  })
})
