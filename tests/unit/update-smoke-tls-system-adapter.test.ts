import { describe, expect, it } from 'vitest'

import {
  buildTemporaryHostsBytes,
  runBoundedCommand,
  tlsTrustCommandPlan,
} from '../../scripts/update-smoke-tls-system-adapter.mjs'

describe('update smoke TLS system adapter pure contracts', () => {
  /** 临时 hosts 映射必须只追加唯一 production hostname，并保留原字节与换行风格。 */
  it('adds one exact loopback mapping without rewriting existing hosts bytes', () => {
    const original = Buffer.from('127.0.0.1 localhost\r\n::1 localhost\r\n')
    expect(buildTemporaryHostsBytes(original, 'updates.cyunlab.com', '127.0.0.1')).toEqual(Buffer.from(
      '127.0.0.1 localhost\r\n::1 localhost\r\n127.0.0.1 updates.cyunlab.com\r\n',
    ))
    expect(() => buildTemporaryHostsBytes(
      Buffer.from('127.0.0.1 updates.cyunlab.com # stale\n'),
      'updates.cyunlab.com',
      '127.0.0.1',
    )).toThrow('already contains')
  })

  /** 信任根的安装和删除必须按平台绑定唯一证书指纹，不能清空或泛删信任存储。 */
  it('builds exact per-platform trust-store mutation plans', () => {
    const identity = {
      authority: '/tmp/ca.pem',
      sha1Fingerprint: 'AB'.repeat(20),
      trustName: 'dsh-update-smoke-AABB',
    }
    expect(tlsTrustCommandPlan('darwin', identity, '/tmp/unused.crt')).toEqual({
      install: { executable: 'sudo', args: ['-n', 'security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', '/tmp/ca.pem'] },
      remove: { executable: 'sudo', args: ['-n', 'security', 'delete-certificate', '-Z', identity.sha1Fingerprint, '/Library/Keychains/System.keychain'] },
    })
    expect(tlsTrustCommandPlan('win32', identity, '/tmp/unused.crt')).toEqual({
      install: { executable: 'certutil.exe', args: ['-addstore', '-f', 'Root', '/tmp/ca.pem'] },
      remove: { executable: 'certutil.exe', args: ['-delstore', 'Root', identity.sha1Fingerprint] },
    })
    expect(tlsTrustCommandPlan('linux', identity, '/usr/local/share/ca-certificates/dsh-update-smoke-AABB.crt')).toEqual({
      install: [
        { executable: 'sudo', args: ['-n', 'install', '-m', '0644', '/tmp/ca.pem', '/usr/local/share/ca-certificates/dsh-update-smoke-AABB.crt'] },
        { executable: 'sudo', args: ['-n', 'update-ca-certificates'] },
      ],
      remove: [
        { executable: 'sudo', args: ['-n', 'rm', '-f', '--', '/usr/local/share/ca-certificates/dsh-update-smoke-AABB.crt'] },
        { executable: 'sudo', args: ['-n', 'update-ca-certificates'] },
      ],
    })
  })

  /** 即使 child 忽略 SIGTERM，系统命令仍必须在强杀期限内回收并拒绝。 */
  it('force-reaps a command that ignores graceful timeout termination', async () => {
    const startedAt = Date.now()
    await expect(runBoundedCommand(process.execPath, [
      '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
    ], {
      environment: process.env,
      timeoutMilliseconds: 250,
      terminationGraceMilliseconds: 25,
    })).rejects.toThrow('timed out')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })
})
