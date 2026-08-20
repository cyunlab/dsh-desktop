import { chmod, mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { execFile, spawn } from 'node:child_process'
import { arch as hostArch, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { terminateProcessTree, waitForListenerClosed } from './smoke-node-sidecar.mjs'

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

/** 使用平台可执行格式读取器验证文件架构。 */
async function verifyExecutableArchitecture(file, contract, label) {
  const architecture = contract.platformName === 'win'
    ? await readPeArchitecture(file)
    : contract.platformName === 'linux'
      ? await readElfArchitecture(file)
      : await readMachOArchitecture(file)
  if (architecture !== contract.architecture) throw new Error(`${label} architecture mismatch: expected ${contract.architecture}, found ${architecture}`)
}

/** 在安装包展开目录中验证真正随包交付的 Node、sidecar 和应用程序。 */
export async function verifyExtractedBundleContents(contentRoot, platformName, runtimeArch = hostArch()) {
  const contract = artifactContract(platformName, runtimeArch)
  const contents = await walkFiles(contentRoot)
  const normalized = file => file.replaceAll('\\', '/').toLowerCase()
  const nodeSuffix = `/node/${contract.resourceName}/${contract.executableName}`.toLowerCase()
  const sidecarSuffix = '/dist/sidecar/index.js'
  const nodeExecutable = contents.find(file => normalized(file).endsWith(nodeSuffix))
  const sidecarScript = contents.find(file => normalized(file).endsWith(sidecarSuffix))
  if (!nodeExecutable) throw new Error(`Bundled Node resource is missing from ${contract.label}`)
  if (!sidecarScript || (await stat(sidecarScript)).size === 0) throw new Error(`Bundled sidecar resource is missing or empty from ${contract.label}`)
  await verifyExecutableArchitecture(nodeExecutable, contract, 'Official Node')
  let application
  if (platformName === 'win') {
    application = contents.find(file => normalized(file).endsWith('.exe')
      && path.basename(file).toLowerCase().includes('deepseek')
      && !path.basename(file).toLowerCase().includes('setup'))
  } else if (platformName === 'mac') {
    application = contents.find(file => normalized(file).includes('.app/contents/macos/')
      && path.basename(file).toLowerCase().includes('deepseek'))
  } else {
    application = contents.find(file => normalized(file).includes('/usr/bin/')
      && path.basename(file).toLowerCase().includes('deepseek'))
  }
  if (!application) throw new Error(`Bundled Tauri application executable is missing from ${contract.label}`)
  await verifyExecutableArchitecture(application, contract, 'Tauri application')
}

/** 在真实安装包内容中定位随包交付的官方 Node 和 sidecar。 */
async function locateBundledRuntime(contentRoot, contract) {
  const contents = await walkFiles(contentRoot)
  const normalized = file => file.replaceAll('\\', '/').toLowerCase()
  const nodeSuffix = `/node/${contract.resourceName}/${contract.executableName}`.toLowerCase()
  const sidecarSuffix = '/dist/sidecar/index.js'
  const nodeExecutable = contents.find(file => normalized(file).endsWith(nodeSuffix))
  const sidecarScript = contents.find(file => normalized(file).endsWith(sidecarSuffix))
  if (!nodeExecutable || !sidecarScript) throw new Error(`Bundled runtime files cannot be located in ${contract.label}`)
  return { nodeExecutable, sidecarScript }
}

/** 等待官方 Node sidecar 输出指定生命周期消息，并保留最后一段错误输出。 */
function waitForSidecarMessage(child, lines, expected, timeoutMilliseconds = 90_000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finishReject(new Error(`Bundled sidecar did not report ${expected} within ${timeoutMilliseconds}ms`)), timeoutMilliseconds)
    const finishResolve = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const finishReject = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    lines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.type === expected) finishResolve(message)
      else if (message.type === 'startup-failed') finishReject(new Error(`Bundled Harness startup failed: ${message.error?.message ?? 'unknown error'}`))
    })
    child.once('error', finishReject)
    child.once('exit', code => {
      if (!settled) finishReject(new Error(`Bundled sidecar exited before ${expected} with code ${code ?? 'unknown'}`))
    })
  })
}

/** 用安装包内的官方 Node 启动真实 Harness，验证打包闭包不是静态假绿。 */
export async function probeBundledRuntime(contentRoot, platformName, runtimeArch = hostArch()) {
  const contract = artifactContract(platformName, runtimeArch)
  const { nodeExecutable, sidecarScript } = await locateBundledRuntime(contentRoot, contract)
  const workDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-runtime-probe-'))
  const environment = { ...process.env, DSH_HOME: path.join(workDirectory, 'harness-home') }
  delete environment.DSH_NODE_PATH
  for (const name of Object.keys(environment)) {
    if (name.startsWith('DSH_TEST_')) delete environment[name]
  }
  const child = spawn(nodeExecutable, [sidecarScript], {
    cwd: workDirectory,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: platformName !== 'win',
    windowsHide: true
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  let stderr = ''
  let origin
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000) })
  try {
    const ready = await waitForSidecarMessage(child, lines, 'ready')
    origin = ready.origin
    if (typeof origin !== 'string') throw new Error('Bundled sidecar ready message did not include an origin')
    const response = await fetch(origin)
    if (!response.ok) throw new Error(`Bundled Harness probe returned HTTP ${response.status}`)
    if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Bundled Harness probe did not return HTML')
    child.stdin.write('{"type":"stop"}\n')
    await waitForSidecarMessage(child, lines, 'stopped', 20_000)
    await waitForChildExit(child, 20_000)
    await waitForListenerClosed(origin)
    console.log(`Verified packaged official Node + Harness runtime: ${contract.label}`)
  } catch (error) {
    const detail = stderr.trim()
    try { await terminateProcessTree(child) } catch (cleanupError) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nCleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
    }
    if (origin) {
      try { await waitForListenerClosed(origin) } catch {}
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ''}`)
  } finally {
    lines.close()
    await rm(workDirectory, { recursive: true, force: true })
  }
}

/** 等待 child process 确认退出，防止产物验收留下 Harness。 */
function waitForChildExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Bundled sidecar did not exit within ${timeoutMilliseconds}ms`)), timeoutMilliseconds)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

/** 查找 GitHub Windows runner 或本机 PATH 中可用的 7-Zip。 */
async function locateSevenZip(environment = process.env) {
  const candidates = [
    environment.ProgramFiles && path.join(environment.ProgramFiles, '7-Zip', '7z.exe'),
    environment['ProgramFiles(x86)'] && path.join(environment['ProgramFiles(x86)'], '7-Zip', '7z.exe'),
    environment.ChocolateyInstall && path.join(environment.ChocolateyInstall, 'bin', '7z.exe'),
    '7z.exe',
    '7z'
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && await stat(candidate).then(value => value.isFile()).catch(() => false)) return candidate
    if (!path.isAbsolute(candidate)) {
      try {
        await execFileAsync(candidate, ['i'], { windowsHide: true })
        return candidate
      } catch {}
    }
  }
  throw new Error('7-Zip is required to inspect the Windows NSIS installer contents')
}

/** 展开或挂载真实安装包并验证其中实际交付的文件。 */
async function verifyInspectableContainer(artifact, contract) {
  const inspectionRoot = await mkdtemp(path.join(tmpdir(), 'dsh-bundle-inspection-'))
  try {
    let contentRoot
    if (contract.platformName === 'win') {
      contentRoot = path.join(inspectionRoot, 'extracted')
      await mkdir(contentRoot)
      const sevenZip = await locateSevenZip()
      await execFileAsync(sevenZip, ['x', '-y', `-o${contentRoot}`, artifact], { windowsHide: true })
    } else if (contract.platformName === 'linux') {
      await chmod(artifact, 0o755)
      await execFileAsync(artifact, ['--appimage-extract'], { cwd: inspectionRoot })
      contentRoot = path.join(inspectionRoot, 'squashfs-root')
    } else {
      contentRoot = path.join(inspectionRoot, 'mounted')
      await mkdir(contentRoot)
      await execFileAsync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', contentRoot, artifact])
    }
    try {
      await verifyExtractedBundleContents(contentRoot, contract.platformName, contract.architecture === 'aarch64' ? 'arm64' : 'x64')
      await probeBundledRuntime(contentRoot, contract.platformName, contract.architecture === 'aarch64' ? 'arm64' : 'x64')
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
  if (options.containerInspector) await options.containerInspector(artifact, contract)
  else await verifyInspectableContainer(artifact, contract)
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
