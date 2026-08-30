import { describe, expect, it } from 'vitest'

import { runNativeUpdateSmokeDriver } from '../../scripts/native-update-smoke-driver.mjs'

/** 创建不触碰磁盘的完整 driver 选项。 */
function driverOptions() {
  return {
    target: 'windows-x86_64',
    baselineArtifact: '/assets/baseline.exe',
    baselineSignature: '/assets/baseline.exe.sig',
    baselineVersion: '2.1.5',
    candidatePackage: '/assets/candidate.exe',
    candidateSignature: '/assets/candidate.exe.sig',
    candidateVersion: '2.1.6',
    candidateManifest: Buffer.from('{"version":"2.1.6"}\n'),
    candidatePackageSha256: 'a'.repeat(64),
    updaterEndpoint: 'https://updates.cyunlab.com/dsh-desktop/channels/stable/latest.json',
    updaterPublicKey: 'encoded public key',
    updaterPublicKeySha256: 'b'.repeat(64),
    signingConfigured: 'false' as const,
  }
}

/** 创建一组按真实升级合同记录调用顺序的平台系统边界。 */
function successfulPlatformAdapter(events: string[]) {
  const baseline = { root: '/installed/app', executable: '/installed/app/Desktop', version: '2.1.5' }
  const updated = { ...baseline, version: '2.1.6' }
  return {
    /** 验证 runner 与目标平台匹配。 */
    assertRunner() { events.push('runner.matched') },
    /** fresh-install exact previous Stable。 */
    async installBaseline() { events.push('baseline.installed'); return baseline },
    /** 从安装树验证 Official Node、Runtime closure 与 Desktop packages。 */
    async inspectInstalledRuntime(installation: typeof baseline) {
      events.push(`runtime.inspected.${installation.version}`)
      return {
        official_node: true,
        cli_runtime_closure: true,
        desktop_capabilities_package: true,
        desktop_update_client_package: true,
        composition_patch: true,
        trusted_updater_configuration: true,
      }
    },
    /** 运行 runner-only TLS gate。 */
    async withTlsGate(_config: unknown, action: (gate: { waitForRequest(): Promise<void>; restoreRouting(): Promise<void>; releaseManifest(): Promise<void> }) => Promise<void>) {
      events.push('tls.entered')
      await action({
        async waitForRequest() { events.push('manifest.requested') },
        async restoreRouting() { events.push('routing.restored') },
        async releaseManifest() { events.push('manifest.released') },
      })
      events.push('tls.closed')
    },
    /** 启动已安装 Desktop。 */
    async launch(installation: typeof baseline) { events.push(`app.launched.${installation.version}`); return { pid: installation.version === '2.1.5' ? 101 : 202 } },
    /** 等候 Desktop 配置身份、版本与固定 Host Ready。 */
    async waitForReady(_launch: unknown, version: string) { events.push(`app.ready.${version}`) },
    /** 验证 staging metadata 与 package bytes 已绑定候选。 */
    async waitForStaged() { events.push('candidate.staged') },
    /** 通过原生 window close 请求正常关闭。 */
    async requestNormalClose() { events.push('normal-close.requested') },
    /** 确认 Desktop 和 Host process tree 均退出。 */
    async waitForNormalClose() { events.push('normal-close.confirmed') },
    /** 从同一安装位置验证候选已替换成功。 */
    async inspectUpdatedInstallation() { events.push('candidate.installed'); return updated },
    /** 正常关闭安装不能自行重启应用。 */
    async assertNotRelaunched() { events.push('no-relaunch.confirmed') },
    /** 清理 runner 本次创建的安装与状态。 */
    async cleanup() { events.push('cleanup.completed') },
    platform: {
      package_kind: 'nsis-exe', install_scope: 'current-user', authenticode: 'not-required',
      code_signing: 'not-applicable', notarization: 'not-applicable', install_registry_root: 'HKCU',
      install_location_class: 'user-profile', msi_present: false,
    },
    runner: { os: 'windows', arch: 'x86_64' },
  }
}

describe('real native update driver public seam', () => {
  /** promotion observation 必须来自完整 previous-Stable 到 candidate 的真实安装顺序。 */
  it('updates the installed baseline on normal close and proves the updated app is ready', async () => {
    const events: string[] = []
    const observation = await runNativeUpdateSmokeDriver(driverOptions(), successfulPlatformAdapter(events))
    expect(events).toEqual([
      'runner.matched',
      'baseline.installed',
      'runtime.inspected.2.1.5',
      'tls.entered',
      'app.launched.2.1.5',
      'app.ready.2.1.5',
      'manifest.requested',
      'routing.restored',
      'manifest.released',
      'candidate.staged',
      'normal-close.requested',
      'normal-close.confirmed',
      'candidate.installed',
      'no-relaunch.confirmed',
      'app.launched.2.1.6',
      'app.ready.2.1.6',
      'runtime.inspected.2.1.6',
      'tls.closed',
      'cleanup.completed',
    ])
    expect(observation.runner).toEqual({ os: 'windows', arch: 'x86_64' })
    expect(observation.observations).toMatchObject({ official_node: true, trusted_updater_configuration: true })
    expect(observation.checkpoints.map(checkpoint => checkpoint.id)).toEqual([
      'update.available',
      'update.downloaded',
      'update.staged',
      'install.normal_close_requested',
      'host.cleanup_confirmed_normal_close',
      'install.normal_close_completed',
      'app.normal_close_no_relaunch',
      'app.updated_version_launched',
      'app.updated_origin_ready',
      'artifact.updater_signature_verified',
    ])
  })

  /** 任一步失败时不得返回 promotion observation，且仍清理 runner 安装。 */
  it('fails closed and cleans up when the candidate never stages', async () => {
    const events: string[] = []
    const adapter = successfulPlatformAdapter(events)
    adapter.waitForStaged = async () => { events.push('candidate.staging-failed'); throw new Error('staging timeout') }
    await expect(runNativeUpdateSmokeDriver({ ...driverOptions(), candidateManifest: Buffer.from('{}\n') }, adapter)).rejects.toThrow('staging timeout')
    expect(events.at(-1)).toBe('cleanup.completed')
  })
})
