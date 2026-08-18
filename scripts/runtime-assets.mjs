import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const ARCH_BY_ELECTRON_BUILDER = new Map([
  [0, 'ia32'],
  [1, 'x64'],
  [2, 'armv7l'],
  [3, 'arm64'],
  [4, 'universal']
])

export function targetFromAfterPackContext(context) {
  const arch = typeof context.arch === 'number' ? ARCH_BY_ELECTRON_BUILDER.get(context.arch) : context.arch
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`unsupported electron-builder architecture: ${context.arch}`)
  const platform = context.electronPlatformName
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error(`unsupported electron-builder platform: ${platform}`)
  return { platform, arch }
}

export function shouldRunPackagedProbe(target, host = { platform: process.platform, arch: process.arch }) {
  return target.platform === host.platform && target.arch === host.arch
}

/** 按目标平台列出打包后必须存在的动态运行时资源。 */
export function requiredRuntimeAssets(target) {
  const { platform, arch } = target
  const assets = [
    directFile('dist/host-process/index.js', 'Host child entry'),
    file('@deepseek-ai/dsh-base', 'cordis.patch.yml', 'bundle YAML'),
    file('@deepseek-ai/dsh-web-app', 'cordis.patch.yml', 'bundle YAML'),
    file('@deepseek-ai/dsh-web-frontend', 'dist/index.html', 'Web frontend'),
    directory('@deepseek-ai/dsh-web-frontend', 'dist/assets', 'Web frontend'),
    file('@deepseek-ai/dsh-workflow-worker-thread', 'lib/worker.cjs', 'workflow worker'),
    file('@deepseek-ai/dsh-code-runtime-worker-thread', 'lib/worker.cjs', 'code runtime worker'),
    file('node-pty', platform === 'linux' ? 'build/Release/pty.node' : `prebuilds/${platform}-${arch}/pty.node`, 'native addon'),
    file(`@koromix/koffi-${platform}-${arch}`, `${platform}_${arch}/koffi.node`, 'runtime-resolved carrier'),
    file(`@vscode/ripgrep-${platform}-${arch}`, platform === 'win32' ? 'bin/rg.exe' : 'bin/rg', 'runtime-resolved carrier', true)
  ]

  if (platform === 'darwin') {
    assets.push(
      file('node-pty', `prebuilds/darwin-${arch}/spawn-helper`, 'native helper', true),
      file(`node-addon-require-builtin-darwin-${arch}`, `prebuilt/darwin-${arch}-napi-v9.node`, 'native addon'),
      file(`@img/sharp-darwin-${arch}`, `lib/sharp-darwin-${arch}-0.35.3.node`, 'native addon'),
      file(`@img/sharp-libvips-darwin-${arch}`, 'lib/libvips-cpp.8.18.3.dylib', 'native runtime')
    )
  } else if (platform === 'linux') {
    assets.push(
      file(`node-addon-require-builtin-linux-${arch}-gnu`, `prebuilt/linux-${arch}-gnu-napi-v9.node`, 'native addon'),
      file(`@deepseek-ai/node-addon-landlock-run-linux-${arch}`, 'bin/landlock-run', 'native helper', true),
      file(`@img/sharp-linux-${arch}`, `lib/sharp-linux-${arch}-0.35.3.node`, 'native addon'),
      file(`@img/sharp-libvips-linux-${arch}`, 'lib/libvips-cpp.so.8.18.3', 'native runtime')
    )
  } else {
    assets.push(
      file('@deepseek-ai/dsh-host-directory-picker-native', 'lib/worker.cjs', 'Win32 directory picker worker'),
      file('@deepseek-ai/dsh-sandbox-windows-acl', 'lib/runner.js', 'Win32 ACL runner'),
      file('node-pty', `prebuilds/win32-${arch}/conpty.node`, 'native addon'),
      file('node-pty', `prebuilds/win32-${arch}/conpty_console_list.node`, 'native addon'),
      file(`node-addon-require-builtin-win32-${arch}-msvc`, `prebuilt/win32-${arch}-msvc-napi-v9.node`, 'native addon'),
      file(`@img/sharp-win32-${arch}`, `lib/sharp-win32-${arch}-0.35.3.node`, 'native addon')
    )
  }
  return assets
}

export async function verifyRequiredRuntimeAssets(root, target) {
  const failures = []
  for (const asset of requiredRuntimeAssets(target)) {
    const targetPath = path.join(root, asset.path)
    try {
      const metadata = await stat(targetPath)
      if (asset.kind === 'non-empty-directory') {
        if (!metadata.isDirectory() || (await readdir(targetPath)).length === 0) failures.push(asset.path)
      } else if (!metadata.isFile()) {
        failures.push(asset.path)
      } else if (asset.executable && target.platform !== 'win32' && (metadata.mode & 0o111) === 0) {
        failures.push(`${asset.path} (not executable)`)
      }
    } catch {
      failures.push(asset.path)
    }
  }
  return failures
}

function file(packageName, relative, category, executable = false) {
  return { path: packagePath(packageName, relative), kind: 'file', category, executable }
}

function directFile(relative, category, executable = false) {
  return { path: relative, kind: 'file', category, executable }
}

function directory(packageName, relative, category) {
  return { path: packagePath(packageName, relative), kind: 'non-empty-directory', category, executable: false }
}

function packagePath(packageName, relative) {
  return path.posix.join('node_modules', packageName, relative)
}
