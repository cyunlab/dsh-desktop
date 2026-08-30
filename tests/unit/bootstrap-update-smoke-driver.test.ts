import { describe, expect, it } from 'vitest'

import { buildBootstrapCommandPlan, runCommand, verifyConfigurationIdentityEvent, verifyMacArchiveListing, verifyTauriUpdaterSignature, verifyWindowsInstallationRecord } from '../../scripts/bootstrap-update-smoke-driver.mjs'

describe('native bootstrap driver command-plan seam', () => {
  /** 大型 archive listing 可使用显式有限上限，普通命令仍受默认诊断上限保护。 */
  it('admits a multi-megabyte archive listing only under an explicit bounded allowance', async () => {
    const bytes = 4 * 1024 * 1024
    const command = [process.execPath, ['-e', `process.stdout.write('x'.repeat(${bytes}))`]] as const
    await expect(runCommand(command[0], command[1], { environment: process.env })).rejects.toThrow('failed')
    await expect(runCommand(command[0], command[1], { environment: process.env, outputBound: 5 * 1024 * 1024 })).resolves.toHaveLength(bytes)
  })

  /** Windows fresh install 使用 NSIS 静默安装并限定当前用户注册表与用户目录。 */
  it('plans a current-user silent NSIS install without MSI assumptions', () => {
    const plan = buildBootstrapCommandPlan({
      target: 'windows-x86_64', packagePath: 'C:\\artifacts\\candidate.exe', installRoot: 'C:\\Users\\runner\\AppData\\Local'
    })
    expect(plan.install).toEqual({ executable: 'C:\\artifacts\\candidate.exe', args: ['/S'], environment: {} })
    expect(plan.discovery).toMatchObject({ registryRoot: 'HKCU', locationRoot: 'C:\\Users\\runner\\AppData\\Local' })
    expect(JSON.stringify(plan)).not.toMatch(/\.msi/i)
  })

  /** Windows 当前用户安装路径按大小写不敏感语义比较，并拒绝相邻目录或 MSI 记录。 */
  it('validates canonical Windows install records with case-insensitive containment', () => {
    const record = { DisplayVersion: '2.1.5', WindowsInstaller: 0 }
    expect(verifyWindowsInstallationRecord(record, '2.1.5', 'C:\\Users\\RunnerAdmin\\AppData\\Local\\DeepSeek Harness Desktop', 'c:\\users\\runneradmin\\appdata\\local')).toBe(true)
    expect(() => verifyWindowsInstallationRecord(record, '2.1.5', 'C:\\Users\\RunnerAdmin\\AppData\\Local-Evil\\Desktop', 'C:\\Users\\RunnerAdmin\\AppData\\Local')).toThrow('under_user_root=false')
    expect(() => verifyWindowsInstallationRecord({ ...record, WindowsInstaller: 1 }, '2.1.5', 'C:\\Users\\RunnerAdmin\\AppData\\Local\\Desktop', 'C:\\Users\\RunnerAdmin\\AppData\\Local')).toThrow('windows_installer=1')
  })

  /** Linux fresh install 直接执行 exact AppImage，并保留原路径写入与执行资格。 */
  it('plans the exact executable AppImage under xvfb', () => {
    const plan = buildBootstrapCommandPlan({ target: 'linux-x86_64', packagePath: '/tmp/candidate.AppImage', installRoot: '/tmp/install' })
    expect(plan.install.args).toEqual(['/tmp/candidate.AppImage'])
    expect(plan.launch).toEqual({ executable: 'dbus-run-session', args: ['--', 'xvfb-run', '-a', '/tmp/install/DeepSeek-Harness-Desktop.AppImage'], environment: { APPIMAGE_EXTRACT_AND_RUN: '1', NO_AT_BRIDGE: '1' } })
    expect(plan.replacementPath).toBe('/tmp/install/DeepSeek-Harness-Desktop.AppImage')
  })

  /** macOS fresh install 解压 updater archive 并按配置执行三项系统信任检查。 */
  it('plans app archive extraction and optional Apple trust checks', () => {
    const plan = buildBootstrapCommandPlan({ target: 'darwin-aarch64', packagePath: '/tmp/candidate.app.tar.gz', installRoot: '/tmp/install', signingConfigured: true })
    expect(plan.install).toEqual({ executable: 'tar', args: ['-xzf', '/tmp/candidate.app.tar.gz', '-C', '/tmp/install'], environment: {} })
    expect(plan.trustChecks).toEqual([
      { executable: 'codesign', args: ['--verify', '--deep', '--strict'], appendApplication: true },
      { executable: 'spctl', args: ['--assess', '--type', 'execute'], appendApplication: true },
      { executable: 'xcrun', args: ['stapler', 'validate'], appendApplication: true }
    ])
  })

  /** 不支持的平台或 runner 架构不能生成可执行计划。 */
  it('rejects unsupported targets', () => {
    expect(() => buildBootstrapCommandPlan({ target: 'linux-aarch64', packagePath: '/tmp/a', installRoot: '/tmp/i' })).toThrow('unsupported bootstrap target')
  })

  /** macOS archive listing 不得在解压前包含路径逃逸或逃逸 symlink。 */
  it('rejects unsafe macOS archive members before extraction', () => {
    expect(() => verifyMacArchiveListing('Desktop.app/Contents/MacOS/Desktop\n', 'drwxr-xr-x  0 a b 0 Jan 1 Desktop.app/\n-rwxr-xr-x  0 a b 1 Jan 1 Desktop.app/Contents/MacOS/Desktop\n')).not.toThrow()
    expect(() => verifyMacArchiveListing('../escape\n', '-rw-r--r-- 0 a b 1 Jan 1 ../escape\n')).toThrow('unsafe')
    expect(() => verifyMacArchiveListing('Desktop.app/link\n', 'lrwxr-xr-x 0 a b 0 Jan 1 Desktop.app/link -> ../../escape\n')).toThrow('symlink')
  })
})

describe('native bootstrap runtime configuration observation seam', () => {
  /** 启动日志必须精确绑定 endpoint、公钥摘要、平台、PID 与本次启动时间窗。 */
  it('admits only the configuration identity emitted by this Desktop launch', () => {
    const launchedAt = Date.now() - 1_000
    const event = { event: 'updater-configuration-identity', app_version: '2.1.0', correlation_id: 'updater-configuration', endpoint: 'https://updates.cyunlab.com/dsh-desktop/channels/stable/latest.json', public_key_sha256: 'a'.repeat(64), platform: 'linux-x86_64', process_id: 1234, recorded_at: new Date().toISOString() }
    const expectations = { endpoint: event.endpoint, publicKeySha256: 'a'.repeat(64), appVersion: '2.1.0', platform: 'linux-x86_64', processId: 1234, launchedAt }
    expect(verifyConfigurationIdentityEvent(event, expectations)).toBe(true)
    expect(() => verifyConfigurationIdentityEvent({ ...event, process_id: 99 }, expectations)).toThrow('process')
    expect(() => verifyConfigurationIdentityEvent({ ...event, app_version: '9.9.9' }, expectations)).toThrow('version')
  })
})

describe('native bootstrap driver signature observation seam', () => {
  /** 已知由 minisign 产生的真实签名经 Tauri 外层 base64 后仍必须验证成功。 */
  it('verifies a real upstream minisign fixture and rejects tampered package bytes', async () => {
    const publicKey = Buffer.from('untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3').toString('base64')
    const signature = Buffer.from('untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==').toString('base64')
    await expect(verifyTauriUpdaterSignature(Buffer.from('test'), signature, publicKey)).resolves.toBe(true)
    await expect(verifyTauriUpdaterSignature(Buffer.from('tampered'), signature, publicKey)).rejects.toThrow('signature')
  })

  /** 损坏的 updater 签名必须 fail closed。 */
  it('rejects malformed Tauri minisign material', async () => {
    await expect(verifyTauriUpdaterSignature(Buffer.from('package'), 'not-base64', 'not-base64')).rejects.toThrow('invalid')
  })
})
