import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflow = (await readFile(new URL('../../.github/workflows/promote-stable.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')

describe('Stable promotion workflow contract', () => {
  /** 确保只有正式发布事件能够触发 Stable promotion。 */
  it('runs only after a GitHub Release is published', () => {
    expect(workflow).toMatch(/^on:\n  release:\n    types: \[published\]/m)
    expect(workflow).not.toContain('workflow_dispatch')
    expect(workflow).not.toContain('push:')
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

  /** 确保 publisher 接收 published Release 的 tag、正文和全部下载资产。 */
  it('passes the published release and downloaded assets to the publisher', () => {
    expect(workflow).toContain('github.event.release.tag_name')
    expect(workflow).toContain('github.event.release.body')
    expect(workflow).toContain('github.event.release.upload_url')
    expect(workflow).toContain('node scripts/promote-stable-release.mjs')
    expect(workflow).toContain('--assets artifacts')
    expect(workflow).toContain('--prefix dsh-desktop')
  })
})
