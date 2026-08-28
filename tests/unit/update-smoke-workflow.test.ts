import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflow = await readFile(new URL('../../.github/workflows/update-smoke.yml', import.meta.url), 'utf8')

describe('native update smoke reusable workflow contract', () => {
  /** workflow 只能由可信工作流复用或人工启动，并接收完整候选绑定。 */
  it('declares reusable inputs and a deterministic evidence output', () => {
    expect(workflow).toContain('workflow_call:')
    for (const input of ['candidate_tag', 'candidate_commit', 'manifest_url', 'manifest_sha256', 'previous_stable_tag']) {
      expect(workflow).toContain(`${input}:`)
    }
    expect(workflow).toContain('evidence_artifact_name:')
    expect(workflow).toContain('update-smoke-evidence-${{ inputs.candidate_tag }}-${{ inputs.candidate_commit }}')
  })

  /** 四个目标必须在匹配的 hosted native runner 上执行且不读取 Stable manifest。 */
  it('runs the exact four-target matrix against an isolated manifest', () => {
    for (const value of ['windows-2025', 'ubuntu-22.04', 'macos-15', 'macos-15-intel', 'windows-x86_64', 'linux-x86_64', 'darwin-aarch64', 'darwin-x86_64']) {
      expect(workflow).toContain(value)
    }
    expect(workflow).toContain('fail-fast: false')
    expect(workflow).toContain('ISOLATED_MANIFEST_URL: ${{ inputs.manifest_url }}')
    expect(workflow).toContain('default: https://updates.cyunlab.com/dsh-desktop/channels/stable/latest.json')
    expect(workflow).toContain('STABLE_MANIFEST_URL: ${{ inputs.stable_manifest_url }}')
    expect(workflow).toContain('--manifest-url "$ISOLATED_MANIFEST_URL"')
  })

  /** runner 通过真实 harness 产证并上传每目标 checksum，fixture 不可进入该 workflow。 */
  it('runs the native adapter and verifies real evidence before aggregation', () => {
    expect(workflow).toContain('node scripts/run-native-update-smoke.mjs')
    expect(workflow).toContain('--baseline-provenance published-release')
    expect(workflow).toContain('node scripts/verify-update-smoke-evidence.mjs')
    expect(workflow).toContain('--require-real-native')
    expect(workflow).toContain('.json.sha256')
    expect(workflow).not.toContain('local-fixture')
    expect(workflow).toContain('DSH_UPDATE_SMOKE_DRIVER: scripts/native-update-smoke-driver.mjs')
  })

  /** workflow 代码必须来自默认分支，candidate commit 只作为待验证数据。 */
  it('never executes candidate commit workflow code', () => {
    expect(workflow).toContain('ref: ${{ github.event.repository.default_branch }}')
    expect(workflow).not.toContain('ref: ${{ inputs.candidate_commit }}')
    expect(workflow).toContain('git merge-base --is-ancestor "$CANDIDATE_COMMIT" "refs/remotes/origin/$DEFAULT_BRANCH"')
    expect(workflow).toContain('git rev-parse "refs/tags/${CANDIDATE_TAG}^{}"')
  })

  /** 真实 runner 必须覆盖安装语义、Runtime closure 与各平台约束。 */
  it('provides all native inputs without weakening Windows, Linux, or macOS trust assumptions', () => {
    expect(workflow).toContain('DSH_UPDATE_SMOKE_DRIVER')
    expect(workflow).toContain('pnpm ensure:official-node')
    expect(workflow).toContain('desktop-capabilities')
    expect(workflow).toContain('desktop-update-client')
    expect(workflow).toContain('cordis.patch.yml')
    expect(workflow).toContain('nsis-exe')
    expect(workflow).toContain('current-user')
    expect(workflow).toContain('not-required')
    expect(workflow).toContain('appimage')
    expect(workflow).toContain('app-tar-gz')
    expect(workflow).toContain('APPLE_SIGNING_IDENTITY')
    expect(workflow).toContain('APPLE_API_ISSUER')
  })

  /** evidence 通过 GitHub 原生 attestations 签名并按候选与 target 唯一命名。 */
  it('checksums, attests, and retains bounded evidence artifacts', () => {
    expect(workflow).toContain('attestations: write')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toMatch(/uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d+\.\d+\.\d+/)
    expect(workflow).toContain('retention-days: 30')
    expect(workflow).toContain('update-smoke-evidence-${{ inputs.candidate_tag }}-${{ inputs.candidate_commit }}-${{ matrix.target }}')
  })
})
