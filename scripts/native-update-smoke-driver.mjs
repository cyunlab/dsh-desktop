import { arch, platform } from 'node:process'

const TARGET_RUNTIME = Object.freeze({
  'windows-x86_64': Object.freeze({ platform: 'win32', arch: 'x64' }),
  'linux-x86_64': Object.freeze({ platform: 'linux', arch: 'x64' }),
  'darwin-aarch64': Object.freeze({ platform: 'darwin', arch: 'arm64' }),
  'darwin-x86_64': Object.freeze({ platform: 'darwin', arch: 'x64' })
})

/** 在接触安装包前确认真实 runner 与目标完全一致。 */
function assertNativeRunner(target) {
  const expected = TARGET_RUNTIME[target]
  if (!expected) throw new Error(`unsupported native update smoke target: ${target ?? ''}`)
  if (platform !== expected.platform || arch !== expected.arch) {
    throw new Error(`native runner mismatch for ${target}: observed ${platform}/${arch}`)
  }
}

/** 读取 driver CLI 的目标参数。 */
function targetArgument(args) {
  const index = args.indexOf('--target')
  return index >= 0 ? args[index + 1] : undefined
}

/** 明确拒绝在缺少长期生产 native automation 入口时生成 real-native evidence。 */
function main() {
  const target = targetArgument(process.argv.slice(2))
  assertNativeRunner(target)
  throw new Error([
    'real-native update automation is not yet available for released Desktop binaries',
    'the current previous Stable 2.0.17 has no updater and cannot consume the isolated candidate manifest',
    'a production-safe native automation seam must prove the explicit Restart path before this driver may emit evidence'
  ].join('; '))
}

main()
