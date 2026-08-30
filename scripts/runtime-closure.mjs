import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { arch as hostArch, platform as hostPlatform } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = path.resolve(import.meta.dirname, '..')
const desktopPackageManifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const PINNED_DSH_VERSION = desktopPackageManifest.dependencies?.['@deepseek-ai/dsh']
const RUNTIME_CLOSURE_VERSION = 9
const DSH_CLI_CONFIGURATION_FILES = [
  'config/agent-presets/code/agent.cordis.yml',
  'config/agent-presets/code/preset.yml',
  'config/agent-presets/cordis/agent.cordis.yml',
  'config/agent-presets/cordis/preset.yml',
  'config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md',
  'config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md',
  'config/agent-presets/minimal/agent.cordis.yml',
  'config/agent-presets/minimal/preset.yml',
  'config/agent-presets/standard/agent.cordis.yml',
  'config/agent-presets/standard/preset.yml'
]
const RUNTIME_ENTRY_PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-cmdline',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-web-app',
  '@cyunlab/dsh-desktop-capabilities',
  '@cyunlab/dsh-desktop-update-client'
]

/** 返回当前构建平台的运行时约束。 */
export function runtimeTarget(runtimePlatform = hostPlatform(), runtimeArch = hostArch()) {
  const target = {
    'win32-x64': { platform: 'win32', arch: 'x64', resourceName: 'windows-x86_64' },
    'darwin-arm64': { platform: 'darwin', arch: 'arm64', resourceName: 'macos-aarch64' },
    'darwin-x64': { platform: 'darwin', arch: 'x64', resourceName: 'macos-x86_64' },
    'linux-x64': { platform: 'linux', arch: 'x64', resourceName: 'linux-x86_64' }
  }[`${runtimePlatform}-${runtimeArch}`]
  if (!target) throw new Error(`Unsupported runtime closure target: ${runtimePlatform}-${runtimeArch}`)
  return Object.freeze(target)
}

/** 返回需要随应用发布的原生运行时文件清单。 */
export function requiredRuntimeAssets(target) {
  const assets = [
    ...DSH_CLI_CONFIGURATION_FILES.map(relative => file('@deepseek-ai/dsh', relative, 'published CLI configuration')),
    file('@deepseek-ai/dsh-base', 'cordis.patch.yml', 'Harness bundle configuration'),
    file('@deepseek-ai/dsh-web-app', 'cordis.patch.yml', 'Harness bundle configuration'),
    file('@cyunlab/dsh-desktop-capabilities', 'lib/index.js', 'Desktop capability bridge'),
    file('@cyunlab/dsh-desktop-capabilities', 'lib/types/index.d.ts', 'Desktop capability types'),
    file('@cyunlab/dsh-desktop-update-client', 'cordis.patch.yml', 'Desktop composition patch'),
    file('@cyunlab/dsh-desktop-update-client', 'lib/index.js', 'Desktop client Host entry'),
    file('@cyunlab/dsh-desktop-update-client', 'lib/client.js', 'Desktop client bundle'),
    file('@deepseek-ai/dsh-web-frontend', 'dist/index.html', 'Harness frontend'),
    directory('@deepseek-ai/dsh-web-frontend', 'dist/assets', 'Harness frontend'),
    file('@deepseek-ai/dsh-workflow-worker-thread', 'lib/worker.cjs', 'workflow worker'),
    file('@deepseek-ai/dsh-code-runtime-worker-thread', 'lib/worker.cjs', 'code runtime worker'),
    file('node-pty', target.platform === 'linux' ? 'build/Release/pty.node' : `prebuilds/${target.platform}-${target.arch}/pty.node`, 'native addon'),
    file(`@koromix/koffi-${target.platform}-${target.arch}`, `${target.platform}_${target.arch}/koffi.node`, 'native addon'),
    file(`@vscode/ripgrep-${target.platform}-${target.arch}`, target.platform === 'win32' ? 'bin/rg.exe' : 'bin/rg', 'native executable', true)
  ]

  if (target.platform === 'darwin') {
    assets.push(
      file('node-pty', `prebuilds/darwin-${target.arch}/spawn-helper`, 'native helper', true),
      file(`node-addon-require-builtin-darwin-${target.arch}`, 'prebuilt/darwin-' + target.arch + '-napi-v9.node', 'native addon'),
      file(`@img/sharp-darwin-${target.arch}`, `lib/sharp-darwin-${target.arch}-0.35.3.node`, 'native addon'),
      file(`@img/sharp-libvips-darwin-${target.arch}`, 'lib/libvips-cpp.8.18.3.dylib', 'native runtime')
    )
  } else if (target.platform === 'linux') {
    assets.push(
      file(`node-addon-require-builtin-linux-${target.arch}-gnu`, `prebuilt/linux-${target.arch}-gnu-napi-v9.node`, 'native addon'),
      file(`@deepseek-ai/node-addon-landlock-run-linux-${target.arch}`, 'bin/landlock-run', 'native helper', true),
      file(`@img/sharp-linux-${target.arch}`, `lib/sharp-linux-${target.arch}-0.35.3.node`, 'native addon'),
      file(`@img/sharp-libvips-linux-${target.arch}`, 'lib/libvips-cpp.so.8.18.3', 'native runtime')
    )
  } else {
    assets.push(
      file('@deepseek-ai/dsh-host-directory-picker-native', 'lib/worker.cjs', 'Win32 directory picker worker'),
      file('@deepseek-ai/dsh-sandbox-windows-acl', 'lib/runner.js', 'Win32 ACL runner'),
      file('node-pty', `prebuilds/win32-${target.arch}/conpty.node`, 'native addon'),
      file('node-pty', `prebuilds/win32-${target.arch}/conpty_console_list.node`, 'native addon'),
      file('node-pty', 'build/Release/conpty/conpty.dll', 'native runtime'),
      file('node-pty', 'build/Release/conpty/OpenConsole.exe', 'native helper', true),
      file(`node-addon-require-builtin-win32-${target.arch}-msvc`, `prebuilt/win32-${target.arch}-msvc-napi-v9.node`, 'native addon'),
      file(`@img/sharp-win32-${target.arch}`, `lib/sharp-win32-${target.arch}-0.35.3.node`, 'native addon'),
      file(`@img/sharp-win32-${target.arch}`, 'lib/libvips-42.dll', 'native runtime'),
      file(`@img/sharp-win32-${target.arch}`, 'lib/libvips-cpp-8.18.3.dll', 'native runtime')
    )
  }
  return assets
}

/** 创建单个文件资产描述。 */
function file(packageName, relative, category, executable = false) {
  return { path: packagePath(packageName, relative), kind: 'file', category, executable }
}

/** 创建非空目录资产描述。 */
function directory(packageName, relative, category) {
  return { path: packagePath(packageName, relative), kind: 'non-empty-directory', category, executable: false }
}

/** 返回需要按实际安装内容解析的原生资产命名规则。 */
function dynamicRuntimeAssetRules(target) {
  const sharpPackage = `@img/sharp-${target.platform}-${target.arch}`
  const sharpName = `sharp-${target.platform}-${target.arch}-`
  const sharpAssetPattern = new RegExp(`^${sharpName}[0-9]+\\.[0-9]+\\.[0-9]+\\.node$`)
  const rules = [
    {
      packageName: sharpPackage,
      relativeDirectory: 'lib',
      assetMatches: asset => asset.path.startsWith(path.join(packagePath(sharpPackage), 'lib', sharpName)) && asset.path.endsWith('.node'),
      matches: name => sharpAssetPattern.test(name)
    }
  ]
  if (target.platform === 'linux') {
    rules.push({
      packageName: `@img/sharp-libvips-linux-${target.arch}`,
      relativeDirectory: 'lib',
      fallback: 'lib/libvips-cpp.so.8.18.3',
      matches: name => /^libvips-cpp\.so\.[0-9]+(?:\.[0-9]+)+$/.test(name)
    })
  } else if (target.platform === 'darwin') {
    rules.push({
      packageName: `@img/sharp-libvips-darwin-${target.arch}`,
      relativeDirectory: 'lib',
      fallback: 'lib/libvips-cpp.8.18.3.dylib',
      matches: name => /^libvips-cpp\.[0-9]+(?:\.[0-9]+)+\.dylib$/.test(name)
    })
  } else {
    rules.push(
      {
        packageName: sharpPackage,
        relativeDirectory: 'lib',
        fallback: 'lib/libvips-42.dll',
        matches: name => /^libvips-[0-9]+\.dll$/.test(name)
      },
      {
        packageName: sharpPackage,
        relativeDirectory: 'lib',
        fallback: 'lib/libvips-cpp-8.18.3.dll',
        matches: name => /^libvips-cpp-[0-9]+(?:\.[0-9]+)+\.dll$/.test(name)
      }
    )
  }
  return rules
}

/** 查找依赖包目录中符合命名规则的普通文件。 */
async function findPackageAssets(root, packageName, relativeDirectory, matches) {
  const directory = path.join(root, packagePath(packageName, relativeDirectory))
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && matches(entry.name))
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 将 sharp/libvips 的动态版本文件名绑定到真实闭包资产。 */
async function resolveRuntimeAssets(root, target) {
  const assets = requiredRuntimeAssets(target)
  const failures = []
  for (const rule of dynamicRuntimeAssetRules(target)) {
    const packageRoot = packagePath(rule.packageName)
    const fallbackPath = rule.fallback ? path.join(packageRoot, rule.fallback) : undefined
    const assetIndex = assets.findIndex(asset => rule.assetMatches?.(asset) ?? asset.path === fallbackPath)
    if (assetIndex < 0) continue
    const matches = await findPackageAssets(root, rule.packageName, rule.relativeDirectory, rule.matches)
    if (matches.length === 1) {
      assets[assetIndex] = { ...assets[assetIndex], path: path.join(packageRoot, rule.relativeDirectory, matches[0]) }
    } else if (matches.length > 1) {
      failures.push(`${path.join(packageRoot, rule.relativeDirectory)} (${rule.fallback ?? 'dynamic native asset'} has multiple matching native assets: ${matches.join(', ')})`)
    }
  }
  return { assets, failures }
}

/** 返回生产依赖树内的标准包路径。 */
function packagePath(packageName, relative = '') {
  return path.join(packageName.split('/').reduce((current, segment) => path.join(current, segment), ''), relative)
}

/** 判断路径是否存在且为普通文件。 */
async function isFile(target) {
  try { return (await stat(target)).isFile() } catch { return false }
}

/** 判断路径是否存在且为目录。 */
async function isDirectory(target) {
  try { return (await stat(target)).isDirectory() } catch { return false }
}

/** 判断目录是否位于指定根目录内。 */
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** 计算构建输入指纹，确保依赖锁文件变化时不会复用旧闭包。 */
export async function runtimeInputHash(root, target) {
  const hash = createHash('sha256')
  for (const fileName of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    hash.update(fileName)
    hash.update(await readFile(path.join(root, fileName)))
  }
  await hashDirectory(hash, path.join(root, 'packages'))
  hash.update(JSON.stringify(target))
  hash.update(String(RUNTIME_CLOSURE_VERSION))
  return hash.digest('hex')
}

/** 按相对路径稳定哈希私有 workspace 源与生成输出。 */
async function hashDirectory(hash, root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === 'node_modules') continue
    const target = path.join(directory, entry.name)
    const relative = path.relative(root, target)
    hash.update(relative)
    if (entry.isDirectory()) await hashDirectory(hash, root, target)
    else if (entry.isFile()) hash.update(await readFile(target))
  }
}

/** 返回从当前 pnpm 脚本启动 pnpm 的无 shell 命令。 */
function pnpmInvocation(environment = process.env) {
  const pnpmEntry = environment.npm_execpath
  if (pnpmEntry) return { executable: process.execPath, prefix: [pnpmEntry] }
  return { executable: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', prefix: [] }
}

/** 运行生产依赖安装并保留其真实退出状态。 */
function runPnpm(args, cwd, environment = process.env) {
  const invocation = pnpmInvocation(environment)
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, [...invocation.prefix, ...args], {
      cwd,
      env: environment,
      stdio: 'inherit',
      windowsHide: true
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`pnpm ${args.join(' ')} exited with ${code ?? signal ?? 'unknown'}`))
    })
  })
}

/** 过滤 pnpm 管理文件和二进制链接目录，避免将构建机路径带入安装包。 */
function shouldCopyPath(source, sourceRoot) {
  const relative = path.relative(sourceRoot, source)
  return !relative.split(path.sep).some(segment => segment === '.bin' || segment === '.pnpm' || segment === '.modules.yaml' || segment.startsWith('.pnpm-'))
}

/** 将 hoisted 生产依赖树物化为不依赖 pnpm store 的普通目录。 */
async function materializeNodeModules(source, destination, workerLimit = 8) {
  await mkdir(destination, { recursive: true })
  const entries = (await readdir(source, { withFileTypes: true }))
    .filter(entry => !['.bin', '.pnpm', '.modules.yaml'].includes(entry.name) && !entry.name.startsWith('.pnpm-'))
  let cursor = 0
  const worker = async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++]
      await cp(path.join(source, entry.name), path.join(destination, entry.name), {
        recursive: true,
        dereference: true,
        filter: sourcePath => shouldCopyPath(sourcePath, source)
      })
    }
  }
  const results = await Promise.allSettled(Array.from({ length: Math.min(workerLimit, entries.length) }, () => worker()))
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'runtime closure copy failed')
}

/** 物化并验证一次可移植依赖树，失败时由调用方决定是否以保守模式重试。 */
async function materializeVerifiedNodeModules(source, destination, target, workerLimit) {
  await rm(destination, { recursive: true, force: true })
  await materializeNodeModules(source, destination, workerLimit)
  await pruneTargetIncompatibleRuntimeAssets(destination, target)
  await ensureExecutableModes(destination, target)
  await verifyRuntimeClosure(destination, target)
}

/** 删除同一 Koffi 包内不属于目标 ABI 的原生变体，避免打包器扫描不可用动态库。 */
export async function pruneTargetIncompatibleRuntimeAssets(root, target) {
  const packageRoot = path.join(root, packagePath(`@koromix/koffi-${target.platform}-${target.arch}`))
  if (!await isDirectory(packageRoot)) return
  const requiredVariant = `${target.platform}_${target.arch}`
  const nativeVariant = /^(?:darwin|linux|musl|win32)_(?:arm64|x64)$/
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && nativeVariant.test(entry.name) && entry.name !== requiredVariant) {
      await rm(path.join(packageRoot, entry.name), { recursive: true, force: true })
    }
  }
}

/** 为 POSIX 平台补齐依赖包中被归档过程剥离的可执行位。 */
async function ensureExecutableModes(root, target) {
  if (target.platform === 'win32') return
  const { assets } = await resolveRuntimeAssets(root, target)
  for (const asset of assets.filter(item => item.executable)) {
    const targetPath = path.join(root, asset.path)
    if (await isFile(targetPath)) await chmod(targetPath, 0o755)
  }
}

/** 查找依赖包清单，兼容 hoisted 目录和包内嵌套依赖。 */
async function findPackageManifest(name, fromDirectory, root) {
  const segments = name.split('/')
  let cursor = fromDirectory
  while (isWithin(root, cursor)) {
    const candidate = path.join(cursor, 'node_modules', ...segments, 'package.json')
    if (await isFile(candidate)) return candidate
    const directCandidate = path.join(cursor, ...segments, 'package.json')
    if (await isFile(directCandidate)) return directCandidate
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const rootCandidate = path.join(root, ...segments, 'package.json')
  return await isFile(rootCandidate) ? rootCandidate : undefined
}

/** 按发布包的 package.json#bin.dsh 契约解析 CLI 入口，拒绝缺失和越界的深层入口。 */
export async function resolveDshCliEntry(root) {
  const canonicalRoot = await realpath(root)
  const manifestPath = await findPackageManifest('@deepseek-ai/dsh', canonicalRoot, canonicalRoot)
  if (!manifestPath) throw new Error('@deepseek-ai/dsh/package.json is missing from the runtime closure')
  const packageDirectory = path.dirname(manifestPath)
  const canonicalPackageDirectory = await realpath(packageDirectory)
  if (!isWithin(canonicalRoot, canonicalPackageDirectory)) {
    throw new Error('@deepseek-ai/dsh package resolves outside the runtime closure')
  }
  if ((await lstat(manifestPath)).isSymbolicLink()) {
    throw new Error('@deepseek-ai/dsh/package.json must not be a symbolic link')
  }
  const canonicalManifestPath = await realpath(manifestPath)
  if (!isWithin(canonicalPackageDirectory, canonicalManifestPath)) {
    throw new Error('@deepseek-ai/dsh/package.json resolves outside its package')
  }
  const manifest = JSON.parse(await readFile(canonicalManifestPath, 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || typeof PINNED_DSH_VERSION !== 'string' || manifest.version !== PINNED_DSH_VERSION) {
    throw new Error(`@deepseek-ai/dsh runtime version mismatch: expected ${PINNED_DSH_VERSION ?? 'an exact package pin'}, found ${manifest.version ?? 'unknown'}`)
  }
  const declaredEntry = manifest.bin?.dsh
  if (typeof declaredEntry !== 'string' || declaredEntry.trim() === '') {
    throw new Error('@deepseek-ai/dsh package.json#bin.dsh is missing or invalid')
  }
  const entry = path.resolve(canonicalPackageDirectory, declaredEntry)
  if (!isWithin(canonicalPackageDirectory, entry)) {
    throw new Error(`@deepseek-ai/dsh package.json#bin.dsh escapes its package: ${declaredEntry}`)
  }
  if (!await isFile(entry)) throw new Error(`@deepseek-ai/dsh CLI entry is missing: ${declaredEntry}`)
  if ((await lstat(entry)).isSymbolicLink()) {
    throw new Error(`@deepseek-ai/dsh CLI entry must not be a symbolic link: ${declaredEntry}`)
  }
  const canonicalEntry = await realpath(entry)
  if (!isWithin(canonicalPackageDirectory, canonicalEntry)) {
    throw new Error(`@deepseek-ai/dsh CLI entry resolves outside its package: ${declaredEntry}`)
  }
  return canonicalEntry
}

/** 构造只能从指定便携依赖树解析入口的官方 Node + dsh CLI 命令。 */
export async function packagedDshCliCommand(options) {
  const nodeExecutable = path.resolve(options.nodeExecutable)
  const nodeModulesRoot = path.resolve(options.nodeModulesRoot)
  const cliEntry = await resolveDshCliEntry(nodeModulesRoot)
  const environment = { ...(options.environment ?? process.env) }
  const inheritedPathName = Object.keys(environment).find(name => name.toLowerCase() === 'path')
  const existingPath = inheritedPathName ? environment[inheritedPathName] ?? '' : ''
  for (const name of Object.keys(environment)) {
    if (['path', 'node_path'].includes(name.toLowerCase())) delete environment[name]
  }
  environment.PATH = [path.dirname(nodeExecutable), existingPath].filter(Boolean).join(path.delimiter)
  return Object.freeze({
    executable: nodeExecutable,
    args: Object.freeze([cliEntry, ...(options.args ?? ['--version'])]),
    environment: Object.freeze(environment)
  })
}

/** 用显式提供的打包 Node 执行一次发布 CLI 探测，绝不回退到系统 Node。 */
export async function probePackagedDshCli(options) {
  const command = await packagedDshCliCommand(options)
  if (!await isFile(command.executable)) throw new Error(`Packaged official Node executable is missing: ${command.executable}`)
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: options.cwd,
      env: command.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-32_000) })
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-32_000) })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(Object.freeze({ code, signal, stdout, stderr, command }))
      else reject(new Error(`Packaged dsh CLI probe exited with ${code ?? signal ?? 'unknown'}${stderr.trim() ? `:\n${stderr.trim()}` : ''}`))
    })
  })
}

/** 将 Cordis patch 中的动态插件名称转换为包名。 */
function packageNameFromSpecifier(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

/** 读取 patch 文件中的动态插件包名。 */
async function configuredPackages(packageDirectory) {
  const names = []
  for (const fileName of ['cordis.patch.yml', 'cordis.patch.yaml']) {
    const target = path.join(packageDirectory, fileName)
    if (!await isFile(target)) continue
    const contents = await readFile(target, 'utf8')
    for (const match of contents.matchAll(/^\s*(?:-\s*)?name:\s*['"]?(@?[^'"\s#]+)['"]?\s*(?:#.*)?$/gm)) {
      names.push(packageNameFromSpecifier(match[1]))
    }
  }
  return names
}

/** 检查闭包内所有必需依赖和动态插件是否均可解析。 */
async function verifyDependencyGraph(root) {
  const failures = []
  const visited = new Set()
  const queue = RUNTIME_ENTRY_PACKAGES.map(name => ({ name, fromDirectory: root, chain: [] }))
  while (queue.length > 0) {
    const current = queue.shift()
    const manifestPath = await findPackageManifest(current.name, current.fromDirectory, root)
    if (!manifestPath) {
      failures.push(`${[...current.chain, current.name].join(' -> ')} (missing entry package)`)
      continue
    }
    const canonical = await realpath(manifestPath)
    if (visited.has(canonical)) continue
    visited.add(canonical)
    const manifest = JSON.parse(await readFile(canonical, 'utf8'))
    const packageDirectory = path.dirname(canonical)
    const required = { ...manifest.dependencies }
    for (const [name] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional !== true) required[name] = true
    }
    for (const name of Object.keys(required).sort()) {
      const dependency = await findPackageManifest(name, packageDirectory, root)
      if (!dependency) failures.push(`${[...current.chain, manifest.name ?? current.name, name].join(' -> ')} (missing required package)`)
      else queue.push({ name, fromDirectory: packageDirectory, chain: [...current.chain, manifest.name ?? current.name] })
    }
    for (const name of Object.keys(manifest.optionalDependencies ?? {}).sort()) {
      const dependency = await findPackageManifest(name, packageDirectory, root)
      if (dependency) queue.push({ name, fromDirectory: packageDirectory, chain: [...current.chain, manifest.name ?? current.name] })
    }
    for (const name of await configuredPackages(packageDirectory)) {
      const dependency = await findPackageManifest(name, packageDirectory, root)
      if (!dependency) failures.push(`${manifest.name ?? current.name}/cordis.patch -> ${name} (missing dynamic package)`)
      else queue.push({ name, fromDirectory: packageDirectory, chain: [...current.chain, manifest.name ?? current.name] })
    }
  }
  return { failures, visitedCount: visited.size }
}

/** 拒绝残留 symlink，保证 NSIS/DMG/AppImage 不依赖构建机路径。 */
async function verifyNoSymlinks(root) {
  const failures = []
  /** 递归检查目录树中的符号链接。 */
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.name === '.pnpm' || entry.name.startsWith('.pnpm-')) continue
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) failures.push(target)
      else if (entry.isDirectory()) await visit(target)
    }
  }
  await visit(root)
  return failures
}

/** 验证闭包内的依赖图、原生资产和可移植目录属性。 */
export async function verifyRuntimeClosure(root, target) {
  const failures = []
  if (!await isDirectory(root)) failures.push(`${root} (runtime node_modules directory is missing)`)
  else {
    const graph = await verifyDependencyGraph(root)
    failures.push(...graph.failures)
    try { await resolveDshCliEntry(root) } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
    failures.push(...(await verifyNoSymlinks(root)).map(filePath => `${filePath} (symlink is not portable)`))
    const resolved = await resolveRuntimeAssets(root, target)
    failures.push(...resolved.failures)
    for (const asset of resolved.assets) {
      const targetPath = path.join(root, asset.path)
      try {
        const metadata = await stat(targetPath)
        if (asset.kind === 'non-empty-directory') {
          if (!metadata.isDirectory() || (await readdir(targetPath)).length === 0) failures.push(`${asset.path} (missing or empty ${asset.category})`)
        } else if (!metadata.isFile()) failures.push(`${asset.path} (missing ${asset.category})`)
        else if (asset.executable && target.platform !== 'win32' && (metadata.mode & 0o111) === 0) failures.push(`${asset.path} (not executable)`)
      } catch {
        failures.push(`${asset.path} (missing ${asset.category})`)
      }
    }
  }
  if (failures.length > 0) throw new Error(`Runtime closure is incomplete:\n${failures.sort().map(failure => `  ${failure}`).join('\n')}`)
  return true
}

/** 读取或创建缓存中的 hoisted 生产依赖树。 */
async function ensureRuntimeCache(root, target, hash) {
  const cacheRoot = path.join(root, 'node_modules', '.dsh-runtime-closure', `${target.platform}-${target.arch}`)
  const markerPath = path.join(cacheRoot, 'closure.json')
  const cacheNodeModules = path.join(cacheRoot, 'node_modules')
  let marker
  try { marker = JSON.parse(await readFile(markerPath, 'utf8')) } catch {}
  if (marker?.hash === hash) {
    try {
      await verifyRuntimeClosure(cacheNodeModules, target)
      return cacheNodeModules
    } catch {}
  }

  await rm(cacheRoot, { recursive: true, force: true })
  await mkdir(cacheRoot, { recursive: true })
  for (const fileName of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await cp(path.join(root, fileName), path.join(cacheRoot, fileName))
  }
  const workspaceSource = path.join(root, 'packages')
  await cp(workspaceSource, path.join(cacheRoot, 'packages'), {
    recursive: true,
    filter: source => !path.relative(workspaceSource, source).split(path.sep).includes('node_modules')
  })
  await runPnpm([
    'install',
    '--prod',
    '--frozen-lockfile',
    '--config.node-linker=hoisted',
    '--dir',
    cacheRoot
  ], root)
  await materializePrivateWorkspacePackages(cacheRoot, cacheNodeModules)
  await pruneTargetIncompatibleRuntimeAssets(cacheNodeModules, target)
  await verifyRuntimeClosure(cacheNodeModules, target)
  await writeFile(markerPath, JSON.stringify({ hash, target, version: RUNTIME_CLOSURE_VERSION }) + '\n', 'utf8')
  return cacheNodeModules
}

/** 将 pnpm workspace 链接替换为闭包内部的普通目录，避免安装包依赖构建路径。 */
async function materializePrivateWorkspacePackages(cacheRoot, cacheNodeModules) {
  const packageFiles = {
    'desktop-capabilities': ['package.json', 'lib'],
    'desktop-update-client': ['package.json', 'cordis.patch.yml', 'lib']
  }
  for (const [directoryName, entries] of Object.entries(packageFiles)) {
    const source = path.join(cacheRoot, 'packages', directoryName)
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
    const destination = path.join(cacheNodeModules, packagePath(manifest.name))
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    for (const entry of entries) {
      await cp(path.join(source, entry), path.join(destination, entry), { recursive: true, dereference: true })
    }
  }
}

/** 将缓存闭包原子复制到 Tauri 会打包的 dist/node_modules 目录。 */
export async function prepareRuntimeClosure(options = {}) {
  const root = options.projectRoot ?? projectRoot
  const outputRoot = options.outputRoot ?? path.join(root, 'dist')
  const target = options.target ?? runtimeTarget()
  const hash = await runtimeInputHash(root, target)
  const source = await ensureRuntimeCache(root, target, hash)
  const temporary = path.join(outputRoot, `.runtime-node-modules-${process.pid}-${randomUUID()}`)
  const destination = path.join(outputRoot, 'node_modules')
  try {
    try {
      await materializeVerifiedNodeModules(source, temporary, target, 8)
    } catch (firstError) {
      const reason = (firstError instanceof Error ? firstError.message : String(firstError)).split('\n', 1)[0]
      console.warn(`Parallel runtime closure copy was incomplete; retrying serially: ${reason}`)
      await materializeVerifiedNodeModules(source, temporary, target, 1)
    }
    await rm(destination, { recursive: true, force: true })
    await mkdir(outputRoot, { recursive: true })
    await renameDirectory(temporary, destination)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return destination
}

/** 以跨平台方式完成闭包目录替换，避免 rename 在 Windows 上覆盖已有目录失败。 */
async function renameDirectory(source, destination) {
  try {
    await rename(source, destination)
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    await rename(source, destination).catch(() => { throw error })
  }
}

/** 判断脚本是否由 Node 直接执行。 */
function isDirectEntry() {
  return process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isDirectEntry()) {
  await prepareRuntimeClosure()
}
