import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const operationsGuideUrl = new URL('../../docs/update-release-operations.md', import.meta.url)

describe('automatic update release operations guide', () => {
  // 验证维护者能从手册中找到生产发布所需的完整外部资源清单。
  it('documents the external production resources without claiming they already exist', () => {
    const guide = readFileSync(operationsGuideUrl, 'utf8')

    expect(guide).toContain('尚未实际创建或验证')
    expect(guide).toContain('cn-shenzhen')
    expect(guide).toContain('dsh-desktop/')
    expect(guide).toContain('updates.cyunlab.com')
    expect(guide).toContain('OSS Versioning')
    expect(guide).toContain('GitHub `production` Environment')
    expect(guide).toContain('离线加密备份')
  })

  // 验证运维无需猜测 production Environment 的变量和密钥名称。
  it('names every production Environment variable and secret exactly', () => {
    const guide = readFileSync(operationsGuideUrl, 'utf8')
    const requiredNames = [
      'ALIBABA_CLOUD_OIDC_PROVIDER_ARN',
      'ALIBABA_CLOUD_ROLE_ARN',
      'OSS_BUCKET',
      'OSS_REGION',
      'UPDATE_BASE_URL',
      'TAURI_SIGNING_PRIVATE_KEY',
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'
    ]

    for (const name of requiredNames) {
      expect(guide).toContain(`\`${name}\``)
    }
  })

  // 验证构建任务只能读取签名密钥，而云身份仅授予 promotion 任务。
  it('separates build signing access from promotion cloud identity', () => {
    const guide = readFileSync(operationsGuideUrl, 'utf8')

    expect(guide).toContain('Build matrix jobs may reference `production` only to read the two `TAURI_SIGNING_*` secrets')
    expect(guide).toContain('The promotion job is the only job granted `permissions: id-token: write`')
    expect(guide).toContain('Build jobs must not consume or pass OIDC provider/role variables, request an ID token, or receive Alibaba Cloud credentials')
    expect(guide).not.toContain('Only the promotion job may reference this Environment')
  })

  // 验证身份信任被限定到仓库的 production Environment，发布角色也只覆盖 Desktop 前缀。
  it('documents exact OIDC identity and prefix-scoped OSS authorization', () => {
    const guide = readFileSync(operationsGuideUrl, 'utf8')

    expect(guide).toContain('repo:cyunlab/dsh-desktop:environment:production')
    expect(guide).toContain('https://token.actions.githubusercontent.com')
    expect(guide).toContain('sts.aliyuncs.com')
    expect(guide).toContain('acs:oss:*:*:<bucket-name>/dsh-desktop/*')
    expect(guide).toContain('Do not grant `oss:*`')
  })

  // 验证手册明确区分草稿、正式 promotion 与失败后的安全恢复路径。
  it('keeps Draft releases out of Stable and documents recovery without downgrade or deletion', () => {
    const guide = readFileSync(operationsGuideUrl, 'utf8')

    expect(guide).toContain('A Draft does not promote')
    expect(guide).toContain('GitHub Release `published` event')
    expect(guide).toContain('using OSS Versioning')
    expect(guide).toContain('Do not attempt an automatic downgrade')
    expect(guide).toContain('Do not delete GitHub Release assets or OSS release objects')
  })
})
