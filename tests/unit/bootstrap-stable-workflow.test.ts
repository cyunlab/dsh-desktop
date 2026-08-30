import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflow = await readFile(new URL('../../.github/workflows/bootstrap-promote-stable.yml', import.meta.url), 'utf8')

describe('first-updater bootstrap promotion workflow', () => {
  /** bootstrap 只能人工 dispatch，绝不接收 release 发布事件。 */
  it('is a dedicated manual-only workflow with exact approved identity inputs', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/\brelease:\s*\n/)
    for (const input of ['approved_tag', 'approved_version', 'approved_commit']) {
      expect(workflow).toMatch(new RegExp(`${input}:[\\s\\S]*required: true`))
    }
  })

  /** 生产 Environment 的人工审批保护 bootstrap OSS 身份与最终写入。 */
  it('uses production Environment and never calls the normal evidence verifier', () => {
    expect(workflow).toContain('environment: production')
    expect(workflow).toContain('uses: ./.github/workflows/bootstrap-update-smoke.yml')
    expect(workflow).toContain('verify-bootstrap-update-evidence.mjs')
    expect(workflow).toContain('--require-real-bootstrap')
    expect(workflow).not.toContain('verify-update-smoke-evidence.mjs')
    expect(workflow).not.toContain('--require-real-native')
    expect(workflow).not.toContain('signing_configured: true')
  })

  /** 显式输入贯穿 candidate preparation、evidence 和 finalization，Stable 仍是最后写入。 */
  it('binds the approved tag version and commit through prepare and finalize', () => {
    expect(workflow).toContain('--prepare-bootstrap')
    expect(workflow).toContain('--finalize-bootstrap')
    expect(workflow).toContain('github.event.inputs.approved_tag')
    expect(workflow).toContain('github.event.inputs.approved_version')
    expect(workflow).toContain('github.event.inputs.approved_commit')
    for (const variable of [
      'UPDATER_BOOTSTRAP_TAG',
      'UPDATER_BOOTSTRAP_VERSION',
      'UPDATER_BOOTSTRAP_COMMIT',
      'UPDATER_BOOTSTRAP_LEGACY_MANIFEST_SHA256'
    ]) expect(workflow).toContain(`vars.${variable}`)
    expect(workflow).toContain('--approved-legacy-manifest-sha256')
    expect(workflow).toContain('--approved-legacy-version')
    expect(workflow.match(/--approved-tag/g)).toHaveLength(2)
    expect(workflow.match(/--approved-version/g)).toHaveLength(2)
    expect(workflow.match(/--approved-commit/g)).toHaveLength(2)
    expect(workflow.match(/--approved-legacy-manifest-sha256/g)).toHaveLength(2)
    expect(workflow.match(/--approved-legacy-version/g)).toHaveLength(2)
    const verify = workflow.lastIndexOf('verify-bootstrap-update-evidence.mjs')
    const credentials = workflow.lastIndexOf('configure-aliyun-credentials-action@')
    const finalize = workflow.lastIndexOf('--finalize-bootstrap')
    expect(verify).toBeGreaterThan(-1)
    expect(credentials).toBeGreaterThan(verify)
    expect(finalize).toBeGreaterThan(credentials)
  })

  /** 所有第三方 Actions 必须固定到完整 commit。 */
  it('pins every third-party Action to a full commit', () => {
    for (const match of workflow.matchAll(/uses:\s+([^\s#]+@[^\s#]+)/g)) {
      expect(match[1]).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/)
    }
  })
})
