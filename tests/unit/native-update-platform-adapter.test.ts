import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  linuxX11LaunchPlan,
  nativeCloseCommandPlan,
  nativeUpdaterFailureSummary,
  parseDesktopProcessRows,
  platformStatePaths,
  processEnvironmentContainsAppImage,
  requiresDesktopHostReadiness,
  sameInstallationLocation,
  selectLinuxDesktopWindow,
  verifyStagedCandidate,
  waitForLinuxDesktopReadiness,
} from '../../scripts/native-update-platform-adapter.mjs'

describe('native update platform adapter pure contracts', () => {
  /** staging 必须同时绑定候选版本、literal signature、Tauri target、安装类型与下载字节。 */
  it('accepts only the exact staged candidate identity', () => {
    const packageBytes = Buffer.from('candidate package')
    const expected = {
      version: '2.1.6', signature: 'literal signature', target: 'linux-x86_64',
      installKind: 'linux_app_image', packageSha256: createHash('sha256').update(packageBytes).digest('hex'),
    }
    expect(verifyStagedCandidate({
      version: '2.1.6', signature: 'literal signature', target: 'linux-x86_64', install_kind: 'linux_app_image',
    }, packageBytes, expected)).toBe(true)
    expect(() => verifyStagedCandidate({ ...expected, install_kind: 'macos_app' }, packageBytes, expected)).toThrow('identity mismatch')
    expect(() => verifyStagedCandidate({ version: '2.1.6', signature: 'literal signature', target: 'linux-x86_64', install_kind: 'linux_app_image' }, Buffer.from('tampered'), expected)).toThrow('digest mismatch')
  })

  /** 每个平台只读取 Tauri identifier 对应的 config/cache staging 边界。 */
  it('derives exact per-platform updater state paths', () => {
    expect(platformStatePaths('linux-x86_64', {
      HOME: '/home/runner', XDG_CONFIG_HOME: '/state/config', XDG_CACHE_HOME: '/state/cache',
    })).toEqual({
      configRoot: '/state/config/io.github.xlcyun.dsh-desktop',
      cacheRoot: '/state/cache/io.github.xlcyun.dsh-desktop',
      logFile: '/state/config/io.github.xlcyun.dsh-desktop/logs/updater.jsonl',
      stagedMetadata: '/state/cache/io.github.xlcyun.dsh-desktop/desktop-update/staged.json',
      stagedPackage: '/state/cache/io.github.xlcyun.dsh-desktop/desktop-update/package.bin',
    })
    expect(platformStatePaths('darwin-aarch64', { HOME: '/Users/runner' }).cacheRoot).toBe('/Users/runner/Library/Caches/io.github.xlcyun.dsh-desktop')
    expect(platformStatePaths('windows-x86_64', { APPDATA: 'C:\\Users\\runner\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\runner\\AppData\\Local' }).stagedMetadata)
      .toBe(path.win32.join('C:\\Users\\runner\\AppData\\Local', 'io.github.xlcyun.dsh-desktop', 'desktop-update', 'staged.json'))
  })

  /** 正常退出只操作精确窗口；macOS helper 不能退化成 application Quit。 */
  it('builds no-shell native close plans', () => {
    expect(nativeCloseCommandPlan('windows-x86_64', { applicationPid: 123 })).toMatchObject({ executable: 'powershell.exe' })
    expect(nativeCloseCommandPlan('linux-x86_64', { windowId: '0x04600007', display: ':99' })).toEqual({
      executable: 'wmctrl', args: ['-i', '-c', '0x04600007'], environment: { DISPLAY: ':99' },
    })
    expect(nativeCloseCommandPlan('darwin-aarch64', { applicationPid: 456, closeHelper: '/private/tmp/smoke/macos-close-window' })).toEqual({
      executable: '/private/tmp/smoke/macos-close-window', args: ['456'], environment: {},
    })
  })

  /** Linux 必须在 EWMH window manager ready 后通过位置参数启动 exact AppImage。 */
  it('builds a managed X11 session around the exact AppImage path', () => {
    const installationPath = '/tmp/install/DeepSeek-Harness-Desktop.AppImage'
    const plan = linuxX11LaunchPlan(installationPath)
    expect(plan).toMatchObject({ executable: 'dbus-run-session', display: ':99' })
    expect(plan.args.slice(-2)).toEqual(['dsh-native-update-x11', installationPath])
    const sessionScript = plan.args.at(-3)
    expect(sessionScript).toContain('/usr/bin/openbox')
    expect(sessionScript).toContain('/usr/bin/wmctrl')
    expect(sessionScript).toContain('"$1"')
  })

  /** Linux 必须先等待固定 Host ready，再要求依赖页面加载的 X11 主窗口出现。 */
  it('waits for fixed Host readiness before observing the Linux X11 window', async () => {
    const events: string[] = []
    let hostReady = false
    const windowId = await waitForLinuxDesktopReadiness(
      async () => {
        events.push('host')
        hostReady = true
      },
      async () => {
        events.push('window')
        if (!hostReady) throw new Error('window was checked before fixed Host readiness')
        return '0x04600007'
      },
    )
    expect(events).toEqual(['host', 'window'])
    expect(windowId).toBe('0x04600007')
  })

  /** Linux X11 的主窗口可以属于 WebView 子进程，也兼容隔离显示器上唯一的无 PID 窗口。 */
  it('selects the unique Linux Desktop window from the process tree', () => {
    const rows = [
      '0x04600007  0 456 runner DeepSeek Harness Desktop',
      '0x04800009  0 999 runner unrelated',
    ].join('\n')
    expect(selectLinuxDesktopWindow(rows, [123, 456])).toBe('0x04600007')
    expect(selectLinuxDesktopWindow('0x04600007  0 0 runner DeepSeek Harness Desktop', [123])).toBe('0x04600007')
    expect(selectLinuxDesktopWindow(rows, [123])).toBeUndefined()
  })

  /** 多个进程树窗口或多个无 PID 窗口必须失败关闭，不能猜测主窗口。 */
  it('rejects ambiguous Linux Desktop windows', () => {
    expect(() => selectLinuxDesktopWindow([
      '0x04600007  0 456 runner first',
      '0x04800009  0 456 runner second',
    ].join('\n'), [123, 456])).toThrow('ambiguous')
    expect(selectLinuxDesktopWindow([
      '0x04600007  0 0 runner first',
      '0x04800009  0 0 runner second',
    ].join('\n'), [123])).toBeUndefined()
  })

  /** hosted Windows 没有交互 WebView 会话，只跳过 Host readiness，其他原生边界保持不变。 */
  it('requires Desktop Host readiness only where the hosted runner can provide a WebView session', () => {
    expect(requiresDesktopHostReadiness('windows-x86_64')).toBe(false)
    expect(requiresDesktopHostReadiness('linux-x86_64')).toBe(true)
    expect(requiresDesktopHostReadiness('darwin-aarch64')).toBe(true)
  })

  /** 脱敏日志必须让 OSS 4xx 永久失败快速可诊断，同时不泄露原始记录。 */
  it('summarizes permanent updater HTTP failures', () => {
    const log = Buffer.from([
      JSON.stringify({ event: 'update-transition', version: '2.1.8' }),
      JSON.stringify({ event: 'update-failed', failure_stage: 'download', http_status: 403, ignored: '/Users/secret' }),
    ].join('\n'))
    expect(nativeUpdaterFailureSummary(log)).toEqual({
      message: 'native updater failed during download stage (HTTP 403)',
      permanent: true,
    })
    expect(nativeUpdaterFailureSummary(Buffer.from('{"event":"update-failed","failure_stage":"check","http_status":503}'))).toEqual({
      message: 'native updater failed during check stage (HTTP 503)',
      permanent: false,
    })
  })

  /** Desktop 进程枚举必须绑定 exact executable，不能把相似路径或旧 PID 当成本次启动。 */
  it('parses only exact installed Desktop process rows', () => {
    expect(parseDesktopProcessRows([
      ' 101 /Applications/DeepSeek Harness Desktop.app/Contents/MacOS/deepseek-harness-desktop',
      ' 202 /Applications/DeepSeek Harness Desktop.app/Contents/MacOS/deepseek-harness-desktop --flag',
      ' 303 /tmp/DeepSeek Harness Desktop.app/Contents/MacOS/deepseek-harness-desktop',
    ].join('\n'), '/Applications/DeepSeek Harness Desktop.app/Contents/MacOS/deepseek-harness-desktop')).toEqual([101, 202])
  })

  /** AppImage 进程身份必须来自 exact APPIMAGE 环境项，不能接受前缀碰撞。 */
  it('binds Linux processes to the exact AppImage path', () => {
    const environment = Buffer.from('HOME=/home/runner\0APPIMAGE=/work/DeepSeek.AppImage\0')
    expect(processEnvironmentContainsAppImage(environment, '/work/DeepSeek.AppImage')).toBe(true)
    expect(processEnvironmentContainsAppImage(environment, '/work/DeepSeek.AppImage.old')).toBe(false)
  })

  /** 更新后的安装根与主程序必须与 baseline 完全相同。 */
  it('requires in-place replacement at the same installation location', () => {
    const baseline = { root: 'C:\\Users\\runner\\AppData\\Local\\DeepSeek', executable: 'C:\\Users\\runner\\AppData\\Local\\DeepSeek\\desktop.exe' }
    expect(sameInstallationLocation('windows-x86_64', baseline, { ...baseline })).toBe(true)
    expect(sameInstallationLocation('windows-x86_64', baseline, { ...baseline, root: 'C:\\Users\\runner\\AppData\\Local\\DeepSeek-2' })).toBe(false)
  })
})
