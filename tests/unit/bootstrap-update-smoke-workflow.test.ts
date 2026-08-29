import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflow = await readFile(new URL('../../.github/workflows/bootstrap-update-smoke.yml', import.meta.url), 'utf8')

describe('bootstrap update smoke reusable workflow contract', () => {
  /** workflow 以确定输入运行四个匹配的 GitHub hosted native runner。 */
  it('runs the exact four-target production matrix against one immutable candidate', () => {
    expect(workflow).toContain('workflow_call:')
    expect(workflow).not.toContain('workflow_dispatch:')
    for (const input of ['candidate_tag', 'candidate_commit', 'manifest_url', 'manifest_sha256']) expect(workflow).toContain(`${input}:`)
    for (const value of ['windows-2025', 'ubuntu-22.04', 'macos-15', 'macos-15-intel', 'windows-x86_64', 'linux-x86_64', 'darwin-aarch64', 'darwin-x86_64']) expect(workflow).toContain(value)
    expect(workflow).toMatch(/bootstrap-smoke:[\s\S]*environment: production/)
    expect(workflow).toContain('node-version: 24')
    expect(workflow).toContain('ref: ${{ github.event.repository.default_branch }}')
    expect(workflow).not.toContain('ref: ${{ inputs.candidate_commit }}')
    expect(workflow).toContain('APPROVED_TAG: ${{ vars.UPDATER_BOOTSTRAP_TAG }}')
    expect(workflow).toContain('APPROVED_VERSION: ${{ vars.UPDATER_BOOTSTRAP_VERSION }}')
    expect(workflow).toContain('APPROVED_COMMIT: ${{ vars.UPDATER_BOOTSTRAP_COMMIT }}')
    expect(workflow).toContain('test "$CANDIDATE_TAG" = "$APPROVED_TAG"')
    expect(workflow).toContain('test "${CANDIDATE_TAG#v}" = "$APPROVED_VERSION"')
    expect(workflow).toContain('test "$CANDIDATE_COMMIT" = "$APPROVED_COMMIT"')
    expect(workflow).toContain('test "$SIGNING_CONFIGURED" = true || test "$SIGNING_CONFIGURED" = false')
    expect(workflow).toContain('SIGNING_CONFIGURED: ${{ vars.UPDATER_BOOTSTRAP_MACOS_SIGNING_CONFIGURED }}')
  })

  /** 产证必须调用 fail-closed producer，聚合只接受真实 bootstrap evidence。 */
  it('never synthesizes evidence and emits one attested aggregate artifact', () => {
    expect(workflow).toContain('DSH_BOOTSTRAP_UPDATE_SMOKE_DRIVER: scripts/bootstrap-update-smoke-driver.mjs')
    expect(workflow).toContain('node scripts/run-bootstrap-update-smoke.mjs')
    expect(workflow).toContain('node scripts/verify-bootstrap-update-evidence.mjs')
    expect(workflow).toContain('--require-real-bootstrap')
    expect(workflow).not.toContain('bootstrap-local-fixture')
    expect(workflow).toContain('attestations: write')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('bootstrap-update-evidence-${{ inputs.candidate_tag }}-${{ inputs.candidate_commit }}')
    expect(workflow).toContain('retention-days: 30')
  })

  /** production job 把受保护的公开 updater identity 显式交给 producer。 */
  it('passes the exact endpoint, public key, URLs and content identity to the native driver', () => {
    expect(workflow).toContain('UPDATE_BASE_URL: ${{ vars.UPDATE_BASE_URL }}')
    expect(workflow).toContain('TAURI_SIGNING_PUBLIC_KEY: ${{ vars.TAURI_SIGNING_PUBLIC_KEY }}')
    expect(workflow).toContain('--expected-updater-endpoint "$expected_updater_endpoint"')
    expect(workflow).toContain('--expected-updater-public-key "$TAURI_SIGNING_PUBLIC_KEY"')
    expect(workflow).toContain('--signing-configured "$SIGNING_CONFIGURED"')
  })
})
