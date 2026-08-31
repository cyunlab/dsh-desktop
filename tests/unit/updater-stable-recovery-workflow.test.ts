import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflow = await readFile(new URL('../../.github/workflows/recover-updater-stable.yml', import.meta.url), 'utf8')

describe('broken updater Stable recovery workflow', () => {
  /** recovery 只能手动提交精确身份，并由 production 环境保护准备与最终写入。 */
  it('binds a manual candidate to protected production variables', () => {
    expect(workflow).toContain('workflow_dispatch:')
    for (const input of ['approved_tag', 'approved_version', 'approved_commit']) expect(workflow).toContain(`${input}:`)
    expect(workflow.match(/environment: production/g)).toHaveLength(2)
    for (const name of [
      'UPDATER_RECOVERY_TAG', 'UPDATER_RECOVERY_VERSION', 'UPDATER_RECOVERY_COMMIT',
      'UPDATER_RECOVERY_MANIFEST_SHA256', 'UPDATER_RECOVERY_MACOS_SIGNING_CONFIGURED',
      'UPDATER_RECOVERY_BROKEN_STABLE_VERSION', 'UPDATER_RECOVERY_BROKEN_STABLE_MANIFEST_SHA256',
      'UPDATER_RECOVERY_PRIOR_RECEIPT_KEY', 'UPDATER_RECOVERY_PRIOR_RECEIPT_SHA256',
      'UPDATER_RECOVERY_FAILED_PROMOTION_RUN_ID',
    ]) expect(workflow).toContain(`vars.${name}`)
  })

  /** 四平台 evidence 必须来自共享 fresh-install producer 并按 recovery 身份验证。 */
  it('requires attested four-target fresh-install evidence', () => {
    expect(workflow).toContain('uses: ./.github/workflows/bootstrap-update-smoke.yml')
    expect(workflow).toContain('secrets: inherit')
    expect(workflow).toContain('approval_kind: broken-updater-recovery')
    expect(workflow).toContain('gh attestation verify')
    expect(workflow).toContain('--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/bootstrap-update-smoke.yml"')
    expect(workflow).toContain('--signer-digest "$GITHUB_SHA"')
    expect(workflow).toContain('--deny-self-hosted-runners')
    expect(workflow).toContain('--require-real-bootstrap')
    expect(workflow).toContain('--require-macos-signing')
    expect(workflow).toContain('attestations: write')
  })

  /** 最终 job 只取得短期 OIDC 凭证，并调用 receipt-first、Stable-last recovery 模式。 */
  it('writes the immutable recovery receipt before Stable through OIDC', () => {
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('aliyun/configure-aliyun-credentials-action@')
    expect(workflow).toContain('--finalize-updater-recovery')
    expect(workflow).toContain('--candidate candidate/candidate.json --evidence evidence')
    expect(workflow).not.toContain('ALIBABA_CLOUD_ACCESS_KEY_ID: ${{ secrets.')
    expect(workflow).toContain('group: stable-promotion')
    expect(workflow).toContain('ref: ${{ github.sha }}')
  })
})
