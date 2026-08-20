import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { arch as hostArch, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(import.meta.dirname, '..')

/** 根据 CI 矩阵平台返回发布包、资源目录和架构约束。 */
function artifactContract(platformName, runtimeArch = hostArch()) {
  const contracts = {
    win: {
      directory: path.join('src-tauri', 'target', 'release', 'bundle', 'nsis'),
      extension: '.exe',
      label: 'Windows NSIS',
      resourceName: 'windows-x86_64',
      executableName: 'node.exe',
      architecture: 'x86_64'
    },
    mac: {
      directory: path.join('src-tauri', 'target', 'release', 'bundle', 'dmg'),
      extension: '.dmg',
      label: 'macOS DMG',
      resourceName: runtimeArch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64',
      executableName: 'node',
      architecture: runtimeArch === 'arm64' ? 'aarch64' : 'x86_64'
    },
    linux: {
      directory: path.join('src-tauri', 'target', 'release', 'bundle', 'appimage'),
      extension: '.AppImage',
      label: 'Linux AppImage',
      resourceName: 'linux-x86_64',
      executableName: 'node',
      architecture: 'x86_64'
    }
  }[platformName]
  if (!contracts) throw new Error(`Unknown Tauri artifact platform: ${platformName}`)
  return Object.freeze({ ...contracts, platformName })
}

/** 递归枚举目录中的全部普通文件。 */
async function walkFiles(directory) {
  const files = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

/** 读取文件开头的有限字节，避免把大型安装包全部载入内存。 */
async function readPrefix(file, length = 1024 * 1024) {
  const handle = await open(file, 'r')
  try {
    const information = await handle.stat()
    const buffer = Buffer.alloc(Math.min(length, information.size))
    await handle.read(buffer, 0, buffer.length, 0)
    return buffer
  } finally {
    await handle.close()
  }
}

/** 验证 PE 文件格式并返回机器架构字段。 */
export async function readPeArchitecture(file) {
  const header = await readPrefix(file)
  if (header.length < 64 || header.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error(`PE magic is missing: ${file}`)
  const peOffset = header.readUInt32LE(0x3c)
  if (peOffset + 6 > header.length || header.subarray(peOffset, peOffset + 4).toString('binary') !== 'PE\0\0') {
    throw new Error(`PE header is invalid: ${file}`)
  }
  const machine = header.readUInt16LE(peOffset + 4)
  if (machine === 0x8664) return 'x86_64'
  if (machine === 0xaa64) return 'aarch64'
  if (machine === 0x014c) return 'x86'
  return `unknown-0x${machine.toString(16)}`
}

/** 验证 ELF 文件格式并返回机器架构字段。 */
export async function readElfArchitecture(file) {
  const header = await readPrefix(file, 64)
  if (header.length < 20 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error(`ELF magic is missing: ${file}`)
  if (header[4] !== 2 || header[5] !== 1) throw new Error(`Expected a little-endian 64-bit ELF: ${file}`)
  const machine = header.readUInt16LE(18)
  if (machine === 0x3e) return 'x86_64'
  if (machine === 0xb7) return 'aarch64'
  return `unknown-0x${machine.toString(16)}`
}

/** 验证 64 位 Mach-O 文件格式并返回 CPU 架构。 */
export async function readMachOArchitecture(file) {
  const header = await readPrefix(file, 64)
  if (header.length < 8) throw new Error(`Mach-O header is truncated: ${file}`)
  const magic = header.readUInt32LE(0)
  if (magic !== 0xfeedfacf) throw new Error(`Expected a thin 64-bit Mach-O executable: ${file}`)
  const cpuType = header.readUInt32LE(4)
  if (cpuType === 0x01000007) return 'x86_64'
  if (cpuType === 0x0100000c) return 'aarch64'
  return `unknown-0x${cpuType.toString(16)}`
}

/** 验证安装包自身的容器格式，不以扩展名代替内容校验。 */
async function verifyContainerFormat(artifact, contract) {
  if (contract.platformName === 'win') {
    const header = await readPrefix(artifact)
    await readPeArchitecture(artifact)
    if (!header.includes(Buffer.from('Nullsoft')) && !header.includes(Buffer.from('NSIS'))) throw new Error(`NSIS marker is missing: ${artifact}`)
    return
  }
  if (contract.platformName === 'linux') {
    const header = await readPrefix(artifact, 16)
    if (await readElfArchitecture(artifact) !== 'x86_64') throw new Error(`AppImage runtime is not x86_64: ${artifact}`)
    if (header[8] !== 0x41 || header[9] !== 0x49 || header[10] !== 0x02) throw new Error(`AppImage type-2 marker is missing: ${artifact}`)
    return
  }
  const information = await stat(artifact)
  if (information.size < 512) throw new Error(`DMG is truncated: ${artifact}`)
  const handle = await open(artifact, 'r')
  try {
    const trailer = Buffer.alloc(512)
    await handle.read(trailer, 0, trailer.length, information.size - trailer.length)
    if (trailer.subarray(0, 4).toString('ascii') !== 'koly') throw new Error(`DMG UDIF trailer is missing: ${artifact}`)
  } finally {
    await handle.close()
  }
}

/** 检查 Tauri 资源映射和构建前资源文件。 */
async function verifyStagedResources(root, contract) {
  const configuration = JSON.parse(await readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const resources = configuration.bundle?.resources ?? {}
  if (resources['../resources/node/**/*'] !== 'node') throw new Error('Tauri Node resource mapping is missing')
  if (resources['../dist/**/*'] !== 'dist') throw new Error('Tauri sidecar resource mapping is missing')
  const nodeExecutable = path.join(root, 'resources', 'node', contract.resourceName, contract.executableName)
  const sidecarScript = path.join(root, 'dist', 'sidecar', 'index.js')
  for (const required of [nodeExecutable, sidecarScript]) {
    if (!(await stat(required)).isFile() || (await stat(required)).size === 0) throw new Error(`Required staged resource is missing or empty: ${required}`)
  }
  const nodeArchitecture = contract.platformName === 'win'
    ? await readPeArchitecture(nodeExecutable)
    : contract.platformName === 'linux'
      ? await readElfArchitecture(nodeExecutable)
      : await readMachOArchitecture(nodeExecutable)
  if (nodeArchitecture !== contract.architecture) throw new Error(`Official Node architecture mismatch: expected ${contract.architecture}, found ${nodeArchitecture}`)
  const application = path.join(root, 'src-tauri', 'target', 'release', contract.platformName === 'win' ? 'deepseek-harness-desktop.exe' : 'deepseek-harness-desktop')
  if (await stat(application).then(information => information.isFile()).catch(() => false)) {
    const applicationArchitecture = contract.platformName === 'win'
      ? await readPeArchitecture(application)
      : contract.platformName === 'linux'
        ? await readElfArchitecture(application)
        : await readMachOArchitecture(application)
    if (applicationArchitecture !== contract.architecture) throw new Error(`Tauri application architecture mismatch: expected ${contract.architecture}, found ${applicationArchitecture}`)
  }
}

/** 在可可靠展开的 DMG/AppImage 中再次确认打包资源存在。 */
async function verifyInspectableContainer(artifact, contract) {
  if (contract.platformName === 'win') return
  const inspectionRoot = await mkdtemp(path.join(tmpdir(), 'dsh-bundle-inspection-'))
  try {
    let contentRoot
    if (contract.platformName === 'linux') {
      await chmod(artifact, 0o755)
      await execFileAsync(artifact, ['--appimage-extract'], { cwd: inspectionRoot })
      contentRoot = path.join(inspectionRoot, 'squashfs-root')
    } else {
      contentRoot = path.join(inspectionRoot, 'mounted')
      await mkdir(contentRoot)
      await execFileAsync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', contentRoot, artifact])
    }
    try {
      const contents = await walkFiles(contentRoot)
      const nodeSuffix = path.join('node', contract.resourceName, contract.executableName).toLowerCase()
      const sidecarSuffix = path.join('dist', 'sidecar', 'index.js').toLowerCase()
      if (!contents.some(file => file.toLowerCase().endsWith(nodeSuffix))) throw new Error(`Bundled Node resource is missing from ${contract.label}`)
      if (!contents.some(file => file.toLowerCase().endsWith(sidecarSuffix))) throw new Error(`Bundled sidecar resource is missing from ${contract.label}`)
    } finally {
      if (contract.platformName === 'mac') await execFileAsync('hdiutil', ['detach', contentRoot])
    }
  } finally {
    await rm(inspectionRoot, { recursive: true, force: true })
  }
}

/** 验证整个 bundle 树、唯一产物、真实格式、架构和必需资源。 */
export async function verifyTauriArtifact(platformName, options = {}) {
  const root = options.projectRoot ?? projectRoot
  const contract = artifactContract(platformName, options.runtimeArch ?? hostArch())
  const bundleRoot = path.join(root, 'src-tauri', 'target', 'release', 'bundle')
  const allBundleFiles = await walkFiles(bundleRoot)
  const forbidden = allBundleFiles.filter(file => file.toLowerCase().endsWith('.msi'))
  if (forbidden.length > 0) throw new Error(`MSI output is forbidden; found: ${forbidden.join(', ')}`)
  const artifactDirectory = path.join(root, contract.directory)
  const artifacts = (await readdir(artifactDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(contract.extension))
    .map(entry => path.join(artifactDirectory, entry.name))
  if (artifacts.length !== 1) throw new Error(`Expected exactly one ${contract.label} artifact, found ${artifacts.length}`)
  const artifact = artifacts[0]
  if ((await stat(artifact)).size === 0) throw new Error(`Tauri artifact is empty: ${artifact}`)
  await verifyContainerFormat(artifact, contract)
  await verifyStagedResources(root, contract)
  if (options.inspectContainer !== false) await verifyInspectableContainer(artifact, contract)
  console.log(`Verified ${contract.label} artifact, architecture, and bundled resources: ${artifact}`)
  return artifact
}

/** 直接执行产物验收脚本。 */
async function main() {
  const platformName = process.argv[2]
  if (!platformName) throw new Error('Artifact platform is required')
  await verifyTauriArtifact(platformName)
}

/** 判断验收脚本是否由 Node 直接执行。 */
function isDirectEntry() {
  return process.argv[1] !== undefined
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isDirectEntry()) await main()
