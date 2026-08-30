import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { runNativeUpdateSmoke } from '../../scripts/run-native-update-smoke.mjs'
import { REQUIRED_SMOKE_CHECKPOINTS } from '../../scripts/verify-update-smoke-evidence.mjs'

const roots: string[] = []

/** 生成验证窗口内的时间，避免测试随日历时间自然过期。 */
function recentObservationTimes() {
  const completedAt = new Date()
  const startedAt = new Date(completedAt.valueOf() - 20 * 60 * 1000)
  return { started_at: startedAt.toISOString(), completed_at: completedAt.toISOString() }
}

/** 创建单目标 runner 的固定输入。 */
async function inputs() {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-update-smoke-'))
  roots.push(directory)
  const baseline = path.join(directory, 'baseline.exe')
  const baselineSignature = path.join(directory, 'baseline.exe.sig')
  const candidate = path.join(directory, 'candidate.exe')
  const candidateSignature = path.join(directory, 'candidate.exe.sig')
  const manifest = path.join(directory, 'candidate-manifest.json')
  const stableManifest = path.join(directory, 'stable-manifest.json')
  await Promise.all([
    writeFile(baseline, 'published-baseline'),
    writeFile(baselineSignature, 'baseline-signature'),
    writeFile(candidate, 'candidate-package'),
    writeFile(candidateSignature, 'candidate-signature'),
    writeFile(manifest, '{"version":"2.1.0"}\n'),
    writeFile(stableManifest, '{"version":"2.0.15"}\n')
  ])
  return {
    target: 'windows-x86_64' as const,
    candidateTag: 'v2.1.0',
    candidateCommit: '1'.repeat(40),
    candidateManifest: manifest,
    candidatePackage: candidate,
    candidateSignature,
    baselineTag: 'v2.0.15',
    baselineVersion: '2.0.15',
    baselineCommit: '9'.repeat(40),
    baselineArtifact: baseline,
    baselineSignature,
    baselineStableManifest: stableManifest,
    baselineArtifactUrl: 'https://updates.cyunlab.com/dsh-desktop/releases/2.0.15/windows-x86_64/baseline.exe',
    baselineProvenance: 'published-release' as const,
    updaterEndpoint: 'https://updates.cyunlab.com/dsh-desktop/channels/stable/latest.json',
    updaterPublicKey: 'public-updater-key',
    updaterPublicKeySha256: createHash('sha256').update('public-updater-key').digest('hex'),
    signingConfigured: 'false' as const,
    outputDirectory: directory
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('native update smoke harness public seam', () => {
  /** 未配置长期 native driver 时必须 fail closed，不可合成通过证据。 */
  it('fails before writing evidence when the native automation driver is unavailable', async () => {
    const options = await inputs()
    await expect(runNativeUpdateSmoke(options, {})).rejects.toThrow('DSH_UPDATE_SMOKE_DRIVER is required')
    await expect(readFile(path.join(options.outputDirectory, 'windows-x86_64.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  /** production evidence 不接受环境变量替换成任意外部 driver。 */
  it('rejects a non-repository driver for promotion-eligible execution', async () => {
    const options = await inputs()
    await expect(runNativeUpdateSmoke(options, { DSH_UPDATE_SMOKE_DRIVER: '/tmp/untrusted-driver' }))
      .rejects.toThrow('fixed repository-owned native driver')
  })

  /** 测试 adapter 只能生成 local fixture，不能冒充真实原生证据。 */
  it('writes bounded local evidence from a complete test adapter observation', async () => {
    const options = await inputs()
    const observation = {
      runner: { os: 'windows', arch: 'x86_64' },
      ...recentObservationTimes(),
      platform: { package_kind: 'nsis-exe', install_scope: 'current-user', authenticode: 'not-required', code_signing: 'not-applicable', notarization: 'not-applicable', install_registry_root: 'HKCU', install_location_class: 'user-profile', msi_present: false },
      observations: {
        official_node: true,
        cli_runtime_closure: true,
        desktop_capabilities_package: true,
        desktop_update_client_package: true,
        composition_patch: true,
        trusted_updater_configuration: true
      },
      checkpoints: REQUIRED_SMOKE_CHECKPOINTS.map(id => ({ id, status: 'passed', details: `${id} native observation` }))
    }
    let driverArguments: string[] = []
    const dependencies = {
      runDriver: async (_executable: string, args: string[]) => {
        driverArguments = args
        return { stdout: Buffer.from(JSON.stringify(observation)), stderr: '' }
      }
    }
    const result = await runNativeUpdateSmoke(options, { DSH_UPDATE_SMOKE_DRIVER: '/trusted/repo-native-driver' }, dependencies)
    expect(result.evidence.target).toBe('windows-x86_64')
    expect(result.evidence.evidence_kind).toBe('local-fixture')
    expect(result.evidence.baseline.provenance).toBe('local-fixture')
    expect(driverArguments).toEqual(expect.arrayContaining([
      '--baseline-version', '2.0.15',
      '--candidate-version', '2.1.0',
      '--candidate-package-sha256', createHash('sha256').update('candidate-package').digest('hex'),
      '--updater-endpoint', options.updaterEndpoint,
      '--updater-public-key', options.updaterPublicKey,
      '--updater-public-key-sha256', options.updaterPublicKeySha256,
      '--signing-configured', 'false',
    ]))
    expect(await readFile(result.checksumPath, 'utf8')).toMatch(/^[0-9a-f]{64}  windows-x86_64\.json\n$/)
  })

  /** 测试 adapter 即使声明 source rebuild 也必须保持 local fixture。 */
  it('never upgrades a test adapter to source-rebuild or real-native evidence', async () => {
    const options = { ...await inputs(), baselineProvenance: 'source-rebuild' as const }
    const observation = {
      runner: { os: 'windows', arch: 'x86_64' },
      ...recentObservationTimes(),
      platform: { package_kind: 'nsis-exe', install_scope: 'current-user', authenticode: 'not-required', code_signing: 'not-applicable', notarization: 'not-applicable', install_registry_root: 'HKCU', install_location_class: 'user-profile', msi_present: false },
      observations: Object.fromEntries(['official_node', 'cli_runtime_closure', 'desktop_capabilities_package', 'desktop_update_client_package', 'composition_patch', 'trusted_updater_configuration'].map(key => [key, true])),
      checkpoints: REQUIRED_SMOKE_CHECKPOINTS.map(id => ({ id, status: 'passed' }))
    }
    const result = await runNativeUpdateSmoke(options, { DSH_UPDATE_SMOKE_DRIVER: '/trusted/repo-native-driver' }, { runDriver: async () => ({ stdout: Buffer.from(JSON.stringify(observation)), stderr: '' }) })
    expect(result.evidence.evidence_kind).toBe('local-fixture')
  })
})
