import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const operationsGuideUrl = new URL('../../docs/update-release-operations.md', import.meta.url)

describe('automatic update release operations guide', () => {
  // 验证维护者能从手册中找到生产资源、当前 Stable 与永久审计凭据。
  it('documents the verified infrastructure and current updater Stable', () => {
    const guide = readFileSync(operationsGuideUrl, 'utf8')

    expect(guide).toContain('protected GitHub Actions diagnostic verified')
    expect(guide).toContain('v2.1.11')
    expect(guide).toContain('33367060346')
    expect(guide).toContain('7155061849558db113b6d059fa21b9a3969aacc2386cb4d10c8a08b603a71c68')
    expect(guide).toContain('abb51c70fc12cfbc67e694e0805481f8cd16d89c2278818b403e3f4ed12cd455')
    expect(guide).toContain('f919e61e61a5375f697bcba78237042aa73d4ecca399e50a2f947ef99510b3df')
    expect(guide).not.toContain('installed clients are not yet on the automatic-update channel')
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
      'TAURI_SIGNING_PUBLIC_KEY',
      'TAURI_SIGNING_PRIVATE_KEY',
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'
    ]

    for (const name of requiredNames) {
      expect(guide).toContain(`\`${name}\``)
    }
  })

  // 验证 candidate OSS 写入前使用与 Desktop 相同的公钥验证全部平台包。
  it('requires pre-write signature verification with the embedded public key', () => {
    const guide = readFileSync(operationsGuideUrl, 'utf8')

    expect(guide).toContain('before uploading them')
    expect(guide).toContain('Windows `.exe`, Linux `.AppImage`, and two macOS `.app.tar.gz` updater files')
    expect(guide).toContain('embedded public key must be identical to `TAURI_SIGNING_PUBLIC_KEY`')
  })

  // 验证不可变发布对象使用内容寻址键，并避免与 Versioning 互斥的防覆盖设置。
  it('uses content-addressed release keys with Versioning-compatible retries', () => {
    const guide = readFileSync(operationsGuideUrl, 'utf8')

    expect(guide).toContain('<sha256-prefix>-<artifact-basename>')
    expect(guide).toContain('Different bytes therefore always produce a different OSS key')
    expect(guide).toContain('byte-for-byte identical')
    expect(guide).toContain('Do not configure an OSS prevent-overwrite rule or `x-oss-forbid-overwrite`')
    expect(guide).not.toContain('Enable a prevent-overwrite rule for `dsh-desktop/releases/`')
    expect(guide).not.toContain('conditional writes that refuse overwrite')
  })

  // 验证构建任务没有云身份，OIDC 仅授予两段最小 OSS 写入任务。
  it('separates build signing access from promotion cloud identity', () => {
    const guide = readFileSync(operationsGuideUrl, 'utf8')

    expect(guide).toContain('Exactly two OSS jobs consume Alibaba Cloud OIDC provider/role variables')
    expect(guide).toContain('`prepare-candidate` may write only content-addressed immutable objects')
    expect(guide).toContain('Native smoke jobs receive no id-token permission')
    expect(guide).toContain('Evidence admission jobs may use GitHub\'s token to verify artifact attestations')
    expect(guide).not.toContain('Only the promotion job may reference this Environment')
  })

  // 验证身份信任被限定到仓库的 production Environment，发布角色也只覆盖 Desktop 前缀。
  it('documents exact OIDC identity and prefix-scoped OSS authorization', () => {
    const guide = readFileSync(operationsGuideUrl, 'utf8')

    expect(guide).toContain('repo:cyunlab@318327647/dsh-desktop@1335996339:environment:production')
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
