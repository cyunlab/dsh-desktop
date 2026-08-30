import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  nativeCloseCommandPlan,
  platformStatePaths,
  verifyStagedCandidate,
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

  /** 正常退出使用原生窗口关闭；macOS 使用正常应用 Quit，由生产 ExitRequested 收口。 */
  it('builds no-shell native close plans', () => {
    expect(nativeCloseCommandPlan('windows-x86_64', { applicationPid: 123 })).toMatchObject({ executable: 'powershell.exe' })
    expect(nativeCloseCommandPlan('linux-x86_64', { windowId: '0x04600007', display: ':99' })).toEqual({
      executable: 'wmctrl', args: ['-i', '-c', '0x04600007'], environment: { DISPLAY: ':99' },
    })
    expect(nativeCloseCommandPlan('darwin-aarch64', { applicationPid: 456 })).toEqual({
      executable: '/usr/bin/osascript', args: ['-e', 'tell application id "io.github.xlcyun.dsh-desktop" to quit'], environment: {},
    })
  })
})
