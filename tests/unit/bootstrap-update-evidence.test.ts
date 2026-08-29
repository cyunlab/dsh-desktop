import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  REQUIRED_BOOTSTRAP_TARGETS,
  runBootstrapUpdateEvidenceCli,
  verifyBootstrapUpdateEvidenceDirectory,
  verifyBootstrapUpdateEvidenceSet
} from '../../scripts/verify-bootstrap-update-evidence.mjs'
import { verifyUpdateSmokeEvidenceSet } from '../../scripts/verify-update-smoke-evidence.mjs'

const roots: string[] = []

const candidate = {
  tag: 'v2.1.0',
  version: '2.1.0',
  commit: '1234567890abcdef1234567890abcdef12345678',
  manifest_sha256: 'a'.repeat(64)
}

/** 根据目标生成一份官方发布物 fresh-install bootstrap 证据。 */
function validEvidence(target: string) {
  const runner = {
    'windows-x86_64': { os: 'windows', arch: 'x86_64' },
    'linux-x86_64': { os: 'linux', arch: 'x86_64' },
    'darwin-aarch64': { os: 'macos', arch: 'aarch64' },
    'darwin-x86_64': { os: 'macos', arch: 'x86_64' }
  }[target]!
  const platform = {
    'windows-x86_64': { package_kind: 'nsis-exe', install_scope: 'current-user', authenticode: 'not-required', code_signing: 'not-applicable', notarization: 'not-applicable', install_registry_root: 'HKCU', install_location_class: 'user-profile', msi_present: false },
    'linux-x86_64': { package_kind: 'appimage', install_scope: 'user', authenticode: 'not-applicable', code_signing: 'not-applicable', notarization: 'not-applicable', replacement_eligible: true, executable_bit: true },
    'darwin-aarch64': { package_kind: 'app-tar-gz', install_scope: 'user', authenticode: 'not-applicable', signing_credentials_configured: true, code_signing: 'verified', notarization: 'verified' },
    'darwin-x86_64': { package_kind: 'app-tar-gz', install_scope: 'user', authenticode: 'not-applicable', signing_credentials_configured: true, code_signing: 'verified', notarization: 'verified' }
  }[target]!
  return {
    schema_version: 1,
    evidence_kind: 'bootstrap-fresh-install',
    claims_previous_stable_upgrade: false,
    target,
    runner,
    candidate: {
      ...candidate,
      provenance: 'published-release',
      release_url: 'https://github.com/cyunlab/dsh-desktop/releases/tag/v2.1.0',
      manifest_url: `https://updates.cyunlab.com/dsh-desktop/candidates/2.1.0/${candidate.commit}/${candidate.manifest_sha256}-latest.json`,
      package_url: `https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/${target}/${'b'.repeat(12)}-package`,
      package_sha256: 'b'.repeat(64),
      signature_sha256: 'c'.repeat(64)
    },
    installation: { mode: 'fresh-install', installed_version: '2.1.0', launched: true },
    started_at: '2026-08-29T08:00:00.000Z',
    completed_at: '2026-08-29T08:10:00.000Z',
    platform,
    observations: {
      updater_endpoint_enabled: true,
      updater_public_key_enabled: true,
      updater_signature_verified: true,
      immutable_object_identity_verified: true,
      official_node: true,
      cli_runtime_closure: true,
      desktop_capabilities_package: true,
      desktop_update_client_package: true,
      composition_patch: true
    }
  }
}

/** 将四目标证据与逐字节 checksum 写入严格目录。 */
async function writeEvidenceDirectory(documents = REQUIRED_BOOTSTRAP_TARGETS.map(validEvidence)) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bootstrap-evidence-'))
  roots.push(directory)
  for (const document of documents) {
    const body = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
    const file = path.join(directory, `${document.target}.json`)
    await writeFile(file, body)
    await writeFile(`${file}.sha256`, `${createHash('sha256').update(body).digest('hex')}  ${path.basename(file)}\n`)
  }
  return directory
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('bootstrap update evidence verifier public seam', () => {
  /** 完整的四目标 fresh-install 集合必须严格绑定已批准候选。 */
  it('accepts exactly four official published-artifact fresh-install documents', () => {
    const documents = REQUIRED_BOOTSTRAP_TARGETS.map(validEvidence)
    const result = verifyBootstrapUpdateEvidenceSet(documents, {
      ...candidate,
      now: new Date('2026-08-29T09:00:00.000Z'),
      maxAgeHours: 24,
      requireRealBootstrap: true
    })
    expect(result).toEqual({ schemaVersion: 1, targets: REQUIRED_BOOTSTRAP_TARGETS, candidate })
  })

  /** OSS package URL 必须由完整 package digest 的固定前缀内容寻址。 */
  it('rejects an immutable package URL whose basename is not bound to the package digest', () => {
    const documents = REQUIRED_BOOTSTRAP_TARGETS.map(validEvidence)
    documents[0]!.candidate.package_url = 'https://updates.cyunlab.com/dsh-desktop/releases/2.1.0/windows-x86_64/ffffffffffff-package.exe'
    expect(() => verifyBootstrapUpdateEvidenceSet(documents, {
      ...candidate,
      now: new Date('2026-08-29T09:00:00.000Z'),
      maxAgeHours: 24,
      requireRealBootstrap: true
    })).toThrow('package_url digest prefix')
  })

  /** candidate manifest URL 必须同时绑定 version、commit 和 manifest digest。 */
  it('rejects a candidate manifest URL with a changed immutable identity', () => {
    const documents = REQUIRED_BOOTSTRAP_TARGETS.map(validEvidence)
    documents[0]!.candidate.manifest_url = `https://updates.cyunlab.com/dsh-desktop/candidates/2.1.0/${candidate.commit}/${'f'.repeat(64)}-latest.json`
    expect(() => verifyBootstrapUpdateEvidenceSet(documents, { ...candidate, now: new Date('2026-08-29T09:00:00.000Z'), maxAgeHours: 24, requireRealBootstrap: true }))
      .toThrow('manifest_url digest')
  })

  /** 发布的 JSON Schema 必须与 verifier 的版本、类型和四目标保持一致。 */
  it('keeps the published bootstrap JSON Schema aligned with the verifier', async () => {
    const schema = JSON.parse(await readFile(new URL('../../docs/bootstrap-update-evidence-v1.schema.json', import.meta.url), 'utf8'))
    expect(schema.properties.schema_version.const).toBe(1)
    expect(schema.properties.evidence_kind.enum).toEqual(['bootstrap-fresh-install', 'bootstrap-local-fixture'])
    expect(schema.properties.claims_previous_stable_upgrade.const).toBe(false)
    expect(schema.properties.target.enum).toEqual(REQUIRED_BOOTSTRAP_TARGETS)
  })

  /** bootstrap evidence 永远不能被 normal previous-Stable verifier 接受。 */
  it('cannot satisfy the normal require-real-native update evidence seam', () => {
    expect(() => verifyUpdateSmokeEvidenceSet(REQUIRED_BOOTSTRAP_TARGETS.map(validEvidence), {
      ...candidate,
      now: new Date('2026-08-29T09:00:00.000Z'),
      maxAgeHours: 24,
      requireRealNative: true
    })).toThrow('invalid evidence_kind')
  })

  /** 声称 previous-Stable upgrade 或使用 fixture/source provenance 必须被生产 admission 拒绝。 */
  it('rejects previous-Stable upgrade claims and non-published provenance', () => {
    const upgradeClaim = REQUIRED_BOOTSTRAP_TARGETS.map(validEvidence)
    upgradeClaim[0]!.claims_previous_stable_upgrade = true
    expect(() => verifyBootstrapUpdateEvidenceSet(upgradeClaim, { ...candidate, now: new Date('2026-08-29T09:00:00.000Z'), maxAgeHours: 24, requireRealBootstrap: true }))
      .toThrow('must not claim a previous-Stable upgrade')
    const fixture = REQUIRED_BOOTSTRAP_TARGETS.map(validEvidence)
    fixture[0]!.candidate.provenance = 'local-fixture'
    expect(() => verifyBootstrapUpdateEvidenceSet(fixture, { ...candidate, now: new Date('2026-08-29T09:00:00.000Z'), maxAgeHours: 24, requireRealBootstrap: true }))
      .toThrow('provenance does not match')
  })

  /** 错候选、runner、安装版本与缺失 Runtime closure 观察都必须 fail closed。 */
  it('rejects mismatched candidate, runner, installed version, and runtime closure', () => {
    const cases = [
      ['candidate commit does not match', (documents: ReturnType<typeof validEvidence>[]) => { documents[0]!.candidate.commit = 'f'.repeat(40) }],
      ['runner contract mismatch', (documents: ReturnType<typeof validEvidence>[]) => { documents[2]!.runner.arch = 'x86_64' }],
      ['installed version does not match', (documents: ReturnType<typeof validEvidence>[]) => { documents[1]!.installation.installed_version = '2.0.15' }],
      ['required bootstrap observation did not pass', (documents: ReturnType<typeof validEvidence>[]) => { documents[3]!.observations.composition_patch = false }]
    ] as const
    for (const [message, mutate] of cases) {
      const documents = REQUIRED_BOOTSTRAP_TARGETS.map(validEvidence)
      mutate(documents)
      expect(() => verifyBootstrapUpdateEvidenceSet(documents, { ...candidate, now: new Date('2026-08-29T09:00:00.000Z'), maxAgeHours: 24, requireRealBootstrap: true })).toThrow(message)
    }
  })

  /** 集合与目录必须拒绝缺失、重复、陈旧和被篡改证据。 */
  it('rejects incomplete, duplicate, stale, and checksum-tampered evidence', async () => {
    expect(() => verifyBootstrapUpdateEvidenceSet(REQUIRED_BOOTSTRAP_TARGETS.slice(1).map(validEvidence), { ...candidate, now: new Date('2026-08-29T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('do not exactly match')
    expect(() => verifyBootstrapUpdateEvidenceSet([...REQUIRED_BOOTSTRAP_TARGETS.map(validEvidence), validEvidence('linux-x86_64')], { ...candidate, now: new Date('2026-08-29T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('duplicate bootstrap evidence target')
    expect(() => verifyBootstrapUpdateEvidenceSet(REQUIRED_BOOTSTRAP_TARGETS.map(validEvidence), { ...candidate, now: new Date('2026-08-31T09:00:00.000Z'), maxAgeHours: 24 }))
      .toThrow('bootstrap evidence is stale')
    const directory = await writeEvidenceDirectory()
    await expect(verifyBootstrapUpdateEvidenceDirectory(directory, { ...candidate, now: new Date('2026-08-29T09:00:00.000Z'), maxAgeHours: 24, requireRealBootstrap: true })).resolves.toMatchObject({ targets: REQUIRED_BOOTSTRAP_TARGETS })
    await writeFile(path.join(directory, 'linux-x86_64.json'), '{}\n')
    await expect(verifyBootstrapUpdateEvidenceDirectory(directory, { ...candidate, now: new Date('2026-08-29T09:00:00.000Z'), maxAgeHours: 24 })).rejects.toThrow('checksum mismatch')
  })

  /** CLI 使用固定候选参数并默认不将 fixture 升格为真实 bootstrap。 */
  it('verifies the public CLI directory seam with explicit real-bootstrap admission', async () => {
    const directory = await writeEvidenceDirectory()
    await expect(runBootstrapUpdateEvidenceCli([
      '--evidence', directory,
      '--candidate-tag', candidate.tag,
      '--candidate-commit', candidate.commit,
      '--manifest-sha256', candidate.manifest_sha256,
      '--max-age-hours', '24',
      '--require-real-bootstrap'
    ], new Date('2026-08-29T09:00:00.000Z'))).resolves.toMatchObject({ candidate })
  })
})
