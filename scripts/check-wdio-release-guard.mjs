import { spawnSync } from 'node:child_process'

/** 验证发布构建会明确拒绝仅供桌面 E2E 使用的 WDIO feature。 */
function checkReleaseGuard() {
  const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const result = spawnSync(cargo, [
    'check',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--release',
    '--features',
    'wdio'
  ], { encoding: 'utf8', windowsHide: true })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (result.error) throw result.error
  if (result.status === 0 || !output.includes('the wdio feature is test-only')) {
    throw new Error('Release build did not reject the WDIO test feature')
  }
  console.log('Verified that release builds reject the WDIO test feature.')
}

checkReleaseGuard()
