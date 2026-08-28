import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflow = (await readFile(new URL('../../.github/workflows/promote-stable.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')

describe('Stable promotion workflow contract', () => {
  /** 确保只有正式发布事件能够触发 Stable promotion。 */
  it('runs only after a GitHub Release is published', () => {
    expect(workflow).toMatch(/^on:\n  release:\n    types: \[published\]/m)
    expect(workflow).not.toContain('workflow_dispatch')
    expect(workflow).not.toContain('push:')
    expect(workflow).toMatch(/concurrency:\n  group: stable-promotion\n  cancel-in-progress: false/)
  })

  /** 确保所有可执行代码来自可信默认分支，Release tag 只作为待验证数据读取。 */
  it('validates the release tag with trusted default-branch code before requesting OIDC', () => {
    expect(workflow).toContain('ref: ${{ github.event.repository.default_branch }}')
    expect(workflow).toContain('fetch-depth: 0')
    expect(workflow).not.toContain('ref: ${{ github.event.release.tag_name }}')
    expect(workflow).toContain('git merge-base --is-ancestor "refs/tags/${RELEASE_TAG}^{}" refs/remotes/origin/main')
    expect(workflow).toContain('for manifest in package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock; do')
    expect(workflow).toContain('git show "refs/tags/${RELEASE_TAG}^{}:${manifest}" > "$MANIFEST_ROOT/${manifest}"')
    expect(workflow).toContain('node scripts/verify-release-version.mjs "$RELEASE_TAG" "$MANIFEST_ROOT"')
    const validation = workflow.indexOf('node scripts/verify-release-version.mjs')
    const credentials = workflow.indexOf('aliyun/configure-aliyun-credentials-action@')
    expect(validation).toBeGreaterThan(-1)
    expect(credentials).toBeGreaterThan(validation)
  })

  /** 确保 production job 独占最小 OIDC 和 Release 读取权限。 */
  it('scopes OIDC to the production promotion job', () => {
    expect(workflow).toMatch(/^permissions:\n  contents: read$/m)
    expect(workflow).toMatch(/promote-stable:[\s\S]*environment: production[\s\S]*permissions:\n      contents: read\n      id-token: write/)
    expect(workflow.match(/id-token: write/g)).toHaveLength(1)
  })

  /** 确保所有外部 action 固定到可审计的完整提交。 */
  it('pins every third-party action to a reviewed commit', () => {
    const actions = [...workflow.matchAll(/uses:\s+([^\s#]+@[^\s#]+)(?:\s+#\s+(v\S+))?/g)]
    expect(actions).toHaveLength(3)
    for (const [, action, version] of actions) {
      expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/)
      expect(version).toMatch(/^v\d+\.\d+\.\d+$/)
    }
  })

  /** 确保 OIDC、OSS 和下载域名全部由 production Environment 参数化。 */
  it('uses parameterized Alibaba Cloud and OSS configuration', () => {
    for (const variable of [
      'ALIBABA_CLOUD_OIDC_PROVIDER_ARN',
      'ALIBABA_CLOUD_ROLE_ARN',
      'OSS_BUCKET',
      'OSS_REGION',
      'UPDATE_BASE_URL'
    ]) expect(workflow).toContain(`vars.${variable}`)
    expect(workflow).toContain('audience: sts.aliyuncs.com')
    expect(workflow).not.toMatch(/acs:ram::\d+/)
  })

  /** 确保 publisher 使用经过固定校验的官方 ossutil，而非未验证的远程安装脚本。 */
  it('installs the pinned ossutil binary after verifying its checksum', () => {
    expect(workflow).toContain('ossutil/1.7.19/ossutil-v1.7.19-linux-amd64.zip')
    expect(workflow).toContain('dcc512e4a893e16bbee63bc769339d8e56b21744fd83c8212a9d8baf28767343')
    expect(workflow).toContain('sha256sum --check')
    expect(workflow).toContain('OSSUTIL_BIN_DIR="$RUNNER_TEMP/bin"')
    expect(workflow).toContain('echo "$OSSUTIL_BIN_DIR" >> "$GITHUB_PATH"')
    expect(workflow).not.toMatch(/curl[^\n]*\|\s*(?:ba)?sh/)
  })

  /** 确保默认 publisher verifier 获得固定 minisign 工具和公开验证密钥。 */
  it('provides minisign and the updater public key to the trusted publisher', () => {
    expect(workflow).toContain('minisign=0.11-1')
    expect(workflow).toContain('minisign -v')
    expect(workflow).toContain('TAURI_SIGNING_PUBLIC_KEY: ${{ vars.TAURI_SIGNING_PUBLIC_KEY }}')
  })

  /** 确保 publisher 接收 published Release 的 tag、正文和全部下载资产。 */
  it('passes the published release and downloaded assets to the publisher', () => {
    expect(workflow).toContain('github.event.release.tag_name')
    expect(workflow).toContain('github.event.release.body')
    expect(workflow).toContain('github.event.release.upload_url')
    expect(workflow).toContain('node scripts/promote-stable-release.mjs')
    expect(workflow).toContain('--assets artifacts')
    expect(workflow).toContain('--prefix dsh-desktop')
    expect(workflow).toContain('for target in windows-x86_64 linux-x86_64 darwin-aarch64 darwin-x86_64; do')
    expect(workflow).toContain('artifacts/${target}')
    expect(workflow).toContain('dsh-desktop-${target}-updater.*')
  })
})
