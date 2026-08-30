import { describe, expect, it } from 'vitest'

import { withUpdateSmokeTlsGate } from '../../scripts/update-smoke-tls-gate.mjs'

/** 创建只记录公开系统边界调用的 TLS gate adapter。 */
function recordingAdapter(events: string[]) {
  return {
    /** 生成仅供本次 runner 使用的临时 CA 与 leaf identity。 */
    async createTlsIdentity() {
      events.push('identity.created')
      return { authority: '/tmp/ca.pem', certificate: '/tmp/leaf.pem', key: '/tmp/leaf.key', fingerprint: 'a'.repeat(40) }
    },
    /** 把临时 CA 安装到当前 runner 的平台信任存储。 */
    async installCertificateAuthority() { events.push('trust.installed') },
    /** 启动固定 path、先 hold response 的本机 HTTPS server。 */
    async startHttpsGate() {
      events.push('server.started')
      return {
        /** 确认真实 Desktop 已建立 manifest 请求。 */
        async waitForRequest() { events.push('request.observed') },
        /** 放出 byte-exact 候选 manifest。 */
        async releaseManifest() { events.push('manifest.released') },
        /** 关闭本机 HTTPS server。 */
        async close() { events.push('server.closed') },
      }
    },
    /** 把 updates hostname 临时映射到 loopback。 */
    async routeHostname() { events.push('routing.installed') },
    /** byte-for-byte 恢复 runner 的原始 hosts 与 DNS 状态。 */
    async restoreHostname() { events.push('routing.restored') },
    /** 删除本次安装的唯一 CA。 */
    async removeCertificateAuthority() { events.push('trust.removed') },
  }
}

describe('runner-only update smoke TLS gate public seam', () => {
  /** 只有真实 manifest 请求已到达且真实 DNS 已恢复后，gate 才能放出候选 bytes。 */
  it('holds the exact Stable request until routing is restored', async () => {
    const events: string[] = []
    const manifest = Buffer.from('{"version":"2.1.6"}\n')
    await withUpdateSmokeTlsGate({
      endpoint: 'https://updates.cyunlab.com/dsh-desktop/channels/stable/latest.json',
      manifest,
    }, async gate => {
      await gate.waitForRequest()
      await gate.restoreRouting()
      await gate.releaseManifest()
      events.push('action.completed')
    }, recordingAdapter(events))
    expect(events).toEqual([
      'identity.created',
      'trust.installed',
      'server.started',
      'routing.installed',
      'request.observed',
      'routing.restored',
      'manifest.released',
      'action.completed',
      'server.closed',
      'trust.removed',
    ])
  })

  /** action 失败也必须先恢复 hosts，再关闭 server 并移除临时 CA。 */
  it('restores every runner mutation when the native action fails', async () => {
    const events: string[] = []
    await expect(withUpdateSmokeTlsGate({
      endpoint: 'https://updates.cyunlab.com/dsh-desktop/channels/stable/latest.json',
      manifest: Buffer.from('{}\n'),
    }, async () => {
      throw new Error('native launch failed')
    }, recordingAdapter(events))).rejects.toThrow('native launch failed')
    expect(events.slice(-3)).toEqual(['routing.restored', 'server.closed', 'trust.removed'])
  })
})
