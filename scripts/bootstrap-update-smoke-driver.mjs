import { spawn } from 'node:child_process'
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { probeBundledRuntime, verifyExtractedBundleContents } from './verify-tauri-artifact.mjs'

const FIXED_ORIGIN = 'http://127.0.0.1:3080/'
const OUTPUT_BOUND = 128 * 1024
const ARCHIVE_LISTING_BOUND = 32 * 1024 * 1024
const COMMAND_ENVIRONMENT_NAMES = Object.freeze([
  'PATH', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'PSModulePath', 'OS', 'HOME', 'USERPROFILE',
  'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC', 'ProgramFiles', 'ProgramFiles(x86)',
  'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'TEMP', 'TMP', 'TMPDIR', 'DISPLAY', 'XDG_CONFIG_HOME',
  'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'
])
const TARGETS = Object.freeze({
  'windows-x86_64': Object.freeze({ platform: 'win32', arch: 'x64', runner: { os: 'windows', arch: 'x86_64' } }),
  'linux-x86_64': Object.freeze({ platform: 'linux', arch: 'x64', runner: { os: 'linux', arch: 'x86_64' } }),
  'darwin-aarch64': Object.freeze({ platform: 'darwin', arch: 'arm64', runner: { os: 'macos', arch: 'aarch64' } }),
  'darwin-x86_64': Object.freeze({ platform: 'darwin', arch: 'x64', runner: { os: 'macos', arch: 'x86_64' } })
})

/** 为受信目标生成不经过 shell 的原生 fresh-install 命令计划。 */
export function buildBootstrapCommandPlan(options) {
  if (!TARGETS[options.target]) throw new Error(`unsupported bootstrap target: ${options.target}`)
  if (options.target === 'windows-x86_64') return Object.freeze({ install: { executable: options.packagePath, args: ['/S'], environment: {} }, discovery: { registryRoot: 'HKCU', locationRoot: options.installRoot } })
  if (options.target === 'linux-x86_64') {
    const replacementPath = path.join(options.installRoot, 'DeepSeek-Harness-Desktop.AppImage')
    return Object.freeze({ install: { executable: 'copy', args: [options.packagePath], environment: {} }, launch: { executable: 'dbus-run-session', args: ['--', 'xvfb-run', '-a', replacementPath], environment: { APPIMAGE_EXTRACT_AND_RUN: '1', NO_AT_BRIDGE: '1' } }, replacementPath })
  }
  return Object.freeze({
    install: { executable: 'tar', args: ['-xzf', options.packagePath, '-C', options.installRoot], environment: {} },
    trustChecks: options.signingConfigured ? [
      { executable: 'codesign', args: ['--verify', '--deep', '--strict'], appendApplication: true },
      { executable: 'spctl', args: ['--assess', '--type', 'execute'], appendApplication: true },
      { executable: 'xcrun', args: ['stapler', 'validate'], appendApplication: true }
    ] : []
  })
}

/** 为 `/Applications` 中保留原名的 app 生成 hosted runner 已验证的最小 LaunchServices 启动计划。 */
export function buildMacLaunchPlan(application) {
  return Object.freeze({
    executable: '/usr/bin/open',
    args: ['-a', application]
  })
}

/** 为 hosted runner 生成保留 bundle 原名且必须预先不存在的 `/Applications` 路径。 */
export function macApplicationsStagingPath() {
  return '/Applications/DeepSeek Harness Desktop.app'
}

/** 只把真实桌面启动所需的受信系统变量传入原生进程，拒绝继承 CI 凭证。 */
export function selectBootstrapCommandEnvironment(environment) {
  return Object.fromEntries(COMMAND_ENVIRONMENT_NAMES.flatMap(name => environment[name] === undefined ? [] : [[name, environment[name]]]))
}

/** hosted Windows 无交互 WebView 会话时使用已安装 runtime 探测，其他平台仍要求 Desktop 监督 Host。 */
export function requiresDesktopHostReadiness(target) {
  return target !== 'windows-x86_64'
}

/** 在解压前校验 macOS tar member、唯一 app 根和 symlink 目标均留在 archive 内。 */
export function verifyMacArchiveListing(namesOutput, verboseOutput) {
  const names = namesOutput.split(/\r?\n/).filter(Boolean)
  if (names.length === 0) throw new Error('macOS archive is empty')
  for (const name of names) {
    const normalized = path.posix.normalize(name)
    if (path.posix.isAbsolute(name) || normalized === '..' || normalized.startsWith('../')) throw new Error('macOS archive contains an unsafe path')
  }
  const applications = new Set(names.map(name => name.replace(/^\.\//, '').split('/')[0]).filter(name => name.endsWith('.app')))
  const application = [...applications][0]
  if (applications.size !== 1 || names.some(name => ![application, `${application}/`].includes(name.replace(/^\.\//, '')) && !name.replace(/^\.\//, '').startsWith(`${application}/`))) throw new Error('macOS archive must contain exactly one application root')
  for (const line of verboseOutput.split(/\r?\n/).filter(line => line.startsWith('l') && line.includes(' -> '))) {
    const [left, target] = line.split(' -> ')
    const member = names.find(name => left.endsWith(name))
    if (!member || path.posix.isAbsolute(target) || path.posix.normalize(path.posix.join(path.posix.dirname(member), target)).startsWith('../')) throw new Error('macOS archive contains an escaping symlink')
  }
  return true
}

/** 解码 Tauri 配置对 minisign 文本增加的外层 base64。 */
function decodeTauriText(value, label) {
  const input = String(value ?? '').trim()
  if (!input) throw new Error(`invalid ${label}`)
  const decoded = Buffer.from(input, 'base64').toString('utf8')
  if (Buffer.from(decoded).toString('base64').replace(/=+$/, '') !== input.replace(/=+$/, '')) throw new Error(`invalid ${label}`)
  return decoded
}

/** 解析 minisign 公钥 packet、key id 与 Ed25519 key。 */
function parsePublicKey(encoded) {
  const lines = decodeTauriText(encoded, 'updater public key').trim().split(/\r?\n/)
  const packet = Buffer.from(lines[1] ?? '', 'base64')
  if (lines.length !== 2 || packet.length !== 42 || !['Ed', 'ED'].includes(packet.subarray(0, 2).toString('ascii'))) throw new Error('invalid updater public key')
  return { id: packet.subarray(2, 10), key: packet.subarray(10) }
}

/** 解析 Tauri `.sig` 的 minisign signature 与可信注释。 */
function parseSignature(encoded) {
  const lines = decodeTauriText(encoded, 'updater signature').trim().split(/\r?\n/)
  const packet = Buffer.from(lines[1] ?? '', 'base64')
  const global = Buffer.from(lines[3] ?? '', 'base64')
  if (lines.length !== 4 || !lines[2].startsWith('trusted comment: ') || packet.length !== 74 || global.length !== 64 || !['Ed', 'ED'].includes(packet.subarray(0, 2).toString('ascii'))) throw new Error('invalid updater signature')
  return { algorithm: packet.subarray(0, 2).toString('ascii'), id: packet.subarray(2, 10), packet, signature: packet.subarray(10), comment: lines[2].slice(17), global }
}

/** 使用 Node 内置 Ed25519 对真实候选包验证 Tauri minisign 签名。 */
export async function verifyTauriUpdaterSignature(packageBytes, encodedSignature, encodedPublicKey) {
  const publicKey = parsePublicKey(encodedPublicKey)
  const signature = parseSignature(encodedSignature)
  if (!publicKey.id.equals(signature.id)) throw new Error('invalid updater signature key id')
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey.key]), format: 'der', type: 'spki' })
  const message = signature.algorithm === 'ED' ? createHash('blake2b512').update(packageBytes).digest() : packageBytes
  if (!verifySignature(null, message, key, signature.signature)) throw new Error('invalid updater package signature')
  if (!verifySignature(null, Buffer.concat([signature.signature, Buffer.from(signature.comment)]), key, signature.global)) throw new Error('invalid updater global signature')
  return true
}

/** 无 shell 执行有界命令并收集诊断，允许为受信的大型结构化输出显式提高上限。 */
export function runCommand(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const outputBound = options.outputBound ?? OUTPUT_BOUND
    if (!Number.isSafeInteger(outputBound) || outputBound <= 0) throw new Error('command output bound must be a positive safe integer')
    const child = spawn(executable, args, { cwd: options.cwd, env: { ...options.environment }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const output = []
    let bytes = 0
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { bytes += chunk.length; if (bytes <= outputBound) output.push(chunk); else child.kill() })
    child.once('error', reject)
    child.once('exit', code => code === 0 && bytes <= outputBound ? resolve(Buffer.concat(output).toString('utf8')) : reject(new Error(`${path.basename(executable)} failed (${code}): ${Buffer.concat(output).toString('utf8').slice(0, 2048)}`)))
  })
}

/** 启动真实 Desktop 主进程并保留有界诊断，不使用 shell 或测试 hook。 */
export function launchApplication(executable, args, environment) {
  const child = spawn(executable, args, { env: environment, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  let bytes = 0
  let exitStatus
  let exitCode
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    const remaining = OUTPUT_BOUND - bytes
    if (remaining > 0) output.push(chunk.subarray(0, remaining))
    bytes += chunk.length
  })
  child.once('error', error => { exitStatus = `spawn error: ${error.code ?? error.message}` })
  child.once('exit', (code, signal) => { exitCode = code; exitStatus = `process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})` })
  child.unref()
  return {
    pid: child.pid,
    exitCode: () => exitCode,
    exitStatus: () => exitStatus,
    diagnostics: () => [Buffer.concat(output).toString('utf8').trim().slice(0, OUTPUT_BOUND), bytes > OUTPUT_BOUND ? '[diagnostics truncated]' : '', exitStatus ?? ''].filter(Boolean).join('\n')
  }
}

/** 读取固定 loopback Host 的有界 HTTP 响应，供 readiness 与清理轮询共用。 */
export function requestLoopbackHttp(url = FIXED_ORIGIN, timeoutMilliseconds = 5_000, maximumBytes = OUTPUT_BOUND) {
  const endpoint = new URL(url)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) throw new Error('loopback HTTP probe requires an uncredentialed 127.0.0.1 URL')
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) throw new Error('loopback HTTP timeout must be a positive safe integer')
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error('loopback HTTP byte bound must be a positive safe integer')
  return new Promise((resolve, reject) => {
    const request = httpRequest(endpoint, { method: 'GET', agent: false, headers: { connection: 'close' } }, response => {
      const chunks = []
      let bytes = 0
      response.on('data', chunk => {
        bytes += chunk.length
        if (bytes > maximumBytes) response.destroy(new Error('loopback HTTP response exceeds byte bound'))
        else chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        contentType: Array.isArray(response.headers['content-type']) ? response.headers['content-type'].join(', ') : response.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    request.setTimeout(timeoutMilliseconds, () => request.destroy(new Error('loopback HTTP request timed out')))
    request.once('error', reject)
    request.end()
  })
}

/** 在超时内要求固定 Host origin 返回非空 HTML。 */
async function waitForHostReady(launch, allowSuccessfulLauncherExit = false) {
  const deadline = Date.now() + 4 * 60 * 1000
  while (Date.now() < deadline) {
    if (launch.exitStatus() && !(allowSuccessfulLauncherExit && launch.exitCode() === 0)) throw new Error(`Desktop process exited before fixed Host readiness: ${launch.diagnostics()}`)
    try {
      const response = await requestLoopbackHttp()
      if (response.statusCode >= 200 && response.statusCode < 300 && /text\/html/i.test(response.contentType) && response.body.trim()) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  const diagnostics = launch.diagnostics()
  throw new Error(`fixed Host origin did not become ready${diagnostics ? `: ${diagnostics}` : ''}`)
}

/** 在 LaunchServices 启动后按精确主程序路径定位唯一 macOS app PID。 */
async function waitForMacApplicationProcess(executable, environment, launch) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (launch.exitStatus() && launch.exitCode() !== 0) throw new Error(`LaunchServices exited before the macOS application appeared: ${launch.diagnostics()}`)
    const rows = await runCommand('ps', ['-axo', 'pid=,command='], { environment, outputBound: 4 * 1024 * 1024 })
    const matches = rows.split(/\r?\n/).map(line => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(match => match?.[2] === executable || match?.[2].startsWith(`${executable} `))
    if (matches.length === 1) return Number(matches[0][1])
    if (matches.length > 1) throw new Error('macOS application process is ambiguous')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('macOS application process was not observed after LaunchServices launch')
}

/** 从 lsof 或 PowerShell 的单列输出解析唯一固定 Host listener PID。 */
export function parseListenerProcessId(output) {
  const pids = [...new Set(String(output).split(/\r?\n/).map(line => /^p?(\d+)$/.exec(line.trim())?.[1]).filter(Boolean).map(Number))]
  if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] <= 0) throw new Error('fixed Host listener PID is missing or ambiguous')
  return pids[0]
}

/** 用平台原生端口工具绑定本次固定 Host 的唯一 listener PID。 */
async function findFixedHostListenerProcess(target, environment) {
  if (target === 'windows-x86_64') {
    const script = "$pids=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 3080 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique); [Console]::Out.Write(($pids -join \"`n\"))"
    return parseListenerProcessId(await runCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { environment }))
  }
  const executable = target.startsWith('darwin-') ? '/usr/sbin/lsof' : 'lsof'
  return parseListenerProcessId(await runCommand(executable, ['-nP', '-a', '-iTCP@127.0.0.1:3080', '-sTCP:LISTEN', '-Fp'], { environment }))
}

/** 在启动或 runtime probe 前证明固定 Host 端口没有其他进程占用。 */
function requireHostPortFree() {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: 3080 })
    socket.setTimeout(1_000)
    socket.once('connect', () => { socket.destroy(); reject(new Error('fixed Host port is already occupied')) })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('fixed Host port availability probe timed out')) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(new Error(`fixed Host port probe failed: ${error.code ?? error.message}`)))
  })
}

/** 校验运行时 updater configuration identity 严格属于本次 Desktop 启动。 */
export function verifyConfigurationIdentityEvent(event, expectations) {
  if (event?.event !== 'updater-configuration-identity' || event.correlation_id !== 'updater-configuration') throw new Error('invalid updater configuration identity event')
  if (event.endpoint !== expectations.endpoint || event.public_key_sha256 !== expectations.publicKeySha256 || event.platform !== expectations.platform) throw new Error('updater configuration identity mismatch')
  if (event.app_version !== expectations.appVersion) throw new Error('updater configuration app version mismatch')
  if (!Number.isSafeInteger(event.process_id) || event.process_id <= 0 || (expectations.processId && event.process_id !== expectations.processId)) throw new Error('updater configuration process mismatch')
  const recordedAt = Date.parse(event.recorded_at)
  if (!Number.isFinite(recordedAt) || recordedAt < expectations.launchedAt - 5_000 || recordedAt > Date.now() + 5_000) throw new Error('updater configuration timestamp is outside this launch')
  return true
}

/** 返回隔离 app config 中稳定的 updater 诊断日志路径。 */
function configurationLogPath(target, isolatedHome, launchEnvironment) {
  if (target === 'windows-x86_64') return path.join(launchEnvironment.APPDATA, 'io.github.xlcyun.dsh-desktop', 'logs', 'updater.jsonl')
  if (target === 'linux-x86_64') return path.join(launchEnvironment.XDG_CONFIG_HOME, 'io.github.xlcyun.dsh-desktop', 'logs', 'updater.jsonl')
  return path.join(launchEnvironment.HOME, 'Library', 'Application Support', 'io.github.xlcyun.dsh-desktop', 'logs', 'updater.jsonl')
}

/** 要求日志中的 PID 确实指向仍在运行的真实 Desktop 主程序。 */
async function verifyDesktopProcess(event, launchedPid, executable, target) {
  if (target !== 'linux-x86_64') {
    if (event.process_id !== launchedPid) throw new Error('updater configuration process does not match launched Desktop')
    return
  }
  const processExecutable = await realpath(`/proc/${event.process_id}/exe`).catch(() => '')
  if (!processExecutable || !path.basename(processExecutable).toLowerCase().includes('deepseek')) throw new Error('updater configuration PID is not the real Desktop process')
  if (!path.basename(executable).toLowerCase().includes('deepseek')) throw new Error('inspected AppImage executable is not Desktop')
}

/** 从有界 JSONL 日志等候并验证本次启动的 runtime configuration identity。 */
async function waitForConfigurationIdentity(logFile, expectations, launchedPid, executable, target) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const body = await readFile(logFile).catch(() => null)
    if (body) {
      if (body.length > OUTPUT_BOUND) throw new Error('updater configuration log exceeds byte bound')
      for (const line of body.toString('utf8').trim().split(/\r?\n/).reverse()) {
        let event
        try { event = JSON.parse(line) } catch { continue }
        try {
          verifyConfigurationIdentityEvent(event, expectations)
          await verifyDesktopProcess(event, launchedPid, executable, target)
          return event
        } catch {}
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('matching updater configuration identity was not observed')
}

/** 递归列出安装包内普通文件，并忽略 bundle 自身的框架 symlink。 */
async function walkFiles(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) files.push(...await walkFiles(candidate))
    else if (entry.isFile()) files.push(candidate)
  }
  return files
}

/** 定位实际安装目录中的主程序、资源目录和 runtime closure。 */
async function inspectInstalledTree(root, executable, endpoint, publicKey) {
  const canonicalRoot = await realpath(root)
  const canonicalExecutable = await realpath(executable)
  if (canonicalExecutable !== canonicalRoot && !canonicalExecutable.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error('application executable escapes installed tree')
  const files = await walkFiles(canonicalRoot)
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const nodeExecutable = files.find(file => path.basename(file) === nodeName && file.includes(`${path.sep}node${path.sep}`))
  const closure = files.find(file => file.endsWith(path.join('@deepseek-ai', 'dsh', 'package.json')))
  if (!nodeExecutable || !(await stat(nodeExecutable)).isFile()) throw new Error('Official Node is missing from installed application')
  if (!closure) throw new Error('published CLI Runtime closure is missing from installed application')
  const nodeModules = closure.slice(0, -path.join('@deepseek-ai', 'dsh', 'package.json').length)
  const required = [['Desktop capability package', '@cyunlab/dsh-desktop-capabilities/lib/index.js'], ['Desktop update-client package', '@cyunlab/dsh-desktop-update-client/lib/client.js'], ['composition patch', '@cyunlab/dsh-desktop-update-client/cordis.patch.yml']]
  for (const [label, relative] of required) if (!(await stat(path.join(nodeModules, ...relative.split('/'))).catch(() => null))?.isFile()) throw new Error(`${label} is missing from installed application`)
  const executableBytes = await readFile(canonicalExecutable)
  if (!executableBytes.includes(Buffer.from(endpoint))) throw new Error('expected updater endpoint is not embedded in installed application')
  if (!executableBytes.includes(Buffer.from(publicKey))) throw new Error('expected updater public key is not embedded in installed application')
  return { official_node: true, cli_runtime_closure: true, desktop_capabilities_package: true, desktop_update_client_package: true, composition_patch: true, updater_endpoint_enabled: true, updater_public_key_enabled: true }
}

/** 从 macOS bundle 的 Info.plist 获取主程序名与安装版本。 */
async function inspectMac(installRoot, version, signingConfigured, checks, environment) {
  const applications = (await readdir(installRoot)).filter(name => name.endsWith('.app'))
  if (applications.length !== 1) throw new Error('macOS updater archive must contain exactly one application')
  const app = path.join(installRoot, applications[0])
  const plist = path.join(app, 'Contents', 'Info.plist')
  const executable = (await runCommand('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { environment })).trim()
  const installedVersion = (await runCommand('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { environment })).trim()
  if (installedVersion !== version) throw new Error('installed macOS version does not match candidate')
  if (signingConfigured) for (const check of checks) await runCommand(check.executable, [...check.args, app], { environment })
  const canonicalApp = await realpath(app)
  return { root: canonicalApp, executable: await realpath(path.join(canonicalApp, 'Contents', 'MacOS', executable)), codeSigning: signingConfigured ? 'verified' : 'not-configured', notarization: signingConfigured ? 'verified' : 'not-configured' }
}

/** 把已验证 app 原样复制到 hosted macOS 可由 LaunchServices 启动的唯一位置。 */
async function stageMacApplication(application, executable, destination, environment) {
  if ((await lstat(destination).catch(() => null)) !== null) throw new Error('bootstrap macOS staging destination already exists')
  const relativeExecutable = path.relative(application, executable)
  if (!relativeExecutable || relativeExecutable === '..' || relativeExecutable.startsWith(`..${path.sep}`) || path.isAbsolute(relativeExecutable)) throw new Error('macOS executable escapes application before staging')
  try {
    await runCommand('sudo', ['/usr/bin/ditto', application, destination], { environment })
    const stagedExecutable = await realpath(path.join(destination, relativeExecutable))
    return { root: await realpath(destination), executable: stagedExecutable }
  } catch (error) {
    await cleanupStagedMacApplication(destination, environment).catch(() => {})
    throw error
  }
}

/** 精确删除本 job 创建的唯一 `/Applications` bootstrap app。 */
async function cleanupStagedMacApplication(application, environment) {
  if (!application) return
  if (application !== macApplicationsStagingPath()) throw new Error('refusing to clean an untrusted macOS staging path')
  if ((await lstat(application).catch(() => null)) === null) return
  await runCommand('sudo', ['/bin/rm', '-R', '--', application], { environment })
  if ((await lstat(application).catch(() => null)) !== null) throw new Error('bootstrap macOS staging cleanup failed')
}

/** 按 Windows 路径语义校验 NSIS 当前用户安装记录与版本。 */
export function verifyWindowsInstallationRecord(record, version, installLocation, userRoot) {
  const relative = path.win32.relative(userRoot.toLowerCase(), installLocation.toLowerCase())
  const underUserRoot = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative))
  const windowsInstaller = Number(record.WindowsInstaller ?? 0)
  if (record.DisplayVersion !== version || windowsInstaller !== 0 || !underUserRoot) {
    throw new Error(`installation is not the expected non-MSI current-user NSIS version and location (display_version=${String(record.DisplayVersion)}, windows_installer=${windowsInstaller}, under_user_root=${underUserRoot})`)
  }
  return true
}

/** 解析注册表中可选成对引号包裹的绝对 Windows 安装路径。 */
export function normalizeWindowsRegistryPath(value) {
  const input = String(value ?? '').trim()
  const unquoted = input.startsWith('"') && input.endsWith('"') ? input.slice(1, -1) : input
  if (!unquoted || unquoted.includes('"') || !path.win32.isAbsolute(unquoted)) throw new Error('invalid absolute Windows registry install path')
  return path.win32.normalize(unquoted)
}

/** 从 HKCU uninstall registry 定位 NSIS 当前用户安装及版本。 */
async function inspectWindows(version, userRoot, environment) {
  const script = "$ErrorActionPreference='Stop'; $cu=@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object {$_.DisplayName -eq 'DeepSeek Harness Desktop'}); $lm=@(Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -eq 'DeepSeek Harness Desktop'}); if ($cu.Count -ne 1 -or $lm.Count -ne 0) { throw 'expected exactly one HKCU and no HKLM uninstall record' }; [Console]::Out.Write(($cu[0] | Select-Object InstallLocation,DisplayVersion,WindowsInstaller | ConvertTo-Json -Compress))"
  const record = JSON.parse(await runCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { environment }))
  const installLocation = normalizeWindowsRegistryPath(record.InstallLocation)
  const [canonicalInstallLocation, canonicalUserRoot] = await Promise.all([realpath(installLocation), realpath(userRoot)])
  verifyWindowsInstallationRecord(record, version, canonicalInstallLocation, canonicalUserRoot)
  const executables = (await readdir(installLocation)).filter(name => name.toLowerCase().endsWith('.exe') && name.toLowerCase().includes('deepseek'))
  if (executables.length !== 1) throw new Error('installed Windows application executable is ambiguous')
  const uninstallers = (await readdir(installLocation)).filter(name => name.toLowerCase().endsWith('.exe') && name.toLowerCase().includes('uninstall'))
  if (uninstallers.length !== 1) throw new Error('current-user NSIS uninstaller is missing or ambiguous')
  return { root: canonicalInstallLocation, executable: path.join(canonicalInstallLocation, executables[0]), uninstaller: path.join(canonicalInstallLocation, uninstallers[0]) }
}

/** 静默卸载 bootstrap Windows 应用并确认 HKCU 注册记录消失。 */
async function uninstallWindows(installation, environment) {
  if (!installation) return
  await runCommand(installation.uninstaller, ['/S'], { environment })
  const script = "$items=@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -eq 'DeepSeek Harness Desktop'}); [Console]::Out.Write($items.Count)"
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if ((await runCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { environment })).trim() === '0') return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('Windows bootstrap uninstall record did not disappear')
}

/** 把主流程错误与 finally 清理错误合并，避免后者覆盖真正失败原因。 */
export function combineBootstrapFailure(primaryError, cleanupErrors) {
  const errors = cleanupErrors.filter(Boolean)
  if (!primaryError && errors.length === 0) return undefined
  if (!primaryError && errors.length === 1) return errors[0]
  const primary = primaryError ? `bootstrap failed: ${primaryError.message}` : 'bootstrap cleanup failed'
  const cleanup = errors.length > 0 ? `; cleanup also failed: ${errors.map(error => error.message).join('; ')}` : ''
  return new Error(`${primary}${cleanup}`, { cause: primaryError ?? errors[0] })
}

/** 尽力终止真实 Desktop 进程树并要求固定 listener 消失。 */
async function cleanupProcess(pid, environment) {
  if (!pid) return
  const windows = process.platform === 'win32'
  /** 同时向隔离进程组和主进程发信号，兼容 LaunchServices 与 wrapper 进程树。 */
  const signalPosixTree = signal => {
    try { process.kill(-pid, signal) } catch {}
    try { process.kill(pid, signal) } catch {}
  }
  try { if (windows) await runCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { environment }); else signalPosixTree('SIGTERM') } catch {}
  const deadline = Date.now() + 30_000
  const forceAt = Date.now() + 5_000
  let forced = windows
  while (Date.now() < deadline) {
    try { await requestLoopbackHttp(FIXED_ORIGIN, 1_000) } catch { return }
    if (!forced && Date.now() >= forceAt) {
      signalPosixTree('SIGKILL')
      forced = true
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('Desktop cleanup left the fixed Host listener alive')
}

/** 解析固定成对 driver 参数并拒绝未知形状。 */
function parseArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid bootstrap driver argument: ${name ?? ''}`)
    values[name.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value
  }
  return values
}

/** 执行真实四平台 fresh-install 并仅在所有检查成功后返回单个观察。 */
export async function runNativeBootstrapDriver(options, environment = process.env) {
  const contract = TARGETS[options.target]
  if (!contract || process.platform !== contract.platform || process.arch !== contract.arch) throw new Error('hosted runner does not match bootstrap target')
  for (const name of ['candidatePackage', 'candidateSignature', 'candidateManifest', 'candidateManifestUrl', 'candidatePackageUrl', 'expectedCandidateVersion', 'expectedManifestSha256', 'expectedPackageSha256', 'expectedSignatureSha256', 'expectedUpdaterEndpoint', 'expectedUpdaterPublicKey', 'expectedUpdaterPublicKeySha256']) if (!options[name]) throw new Error(`bootstrap driver option is required: ${name}`)
  if (options.freshInstallOnly !== 'true') throw new Error('bootstrap driver only supports fresh install')
  if (!['true', 'false'].includes(options.signingConfigured)) throw new Error('bootstrap driver signing policy must be true or false')
  const startedAt = new Date().toISOString()
  const [packageBytes, signatureText, manifestBytes] = await Promise.all([readFile(options.candidatePackage), readFile(options.candidateSignature, 'utf8'), readFile(options.candidateManifest)])
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  if (digest(options.expectedUpdaterPublicKey) !== options.expectedUpdaterPublicKeySha256) throw new Error('updater public key digest does not match producer identity')
  if (digest(packageBytes) !== options.expectedPackageSha256 || digest(signatureText) !== options.expectedSignatureSha256 || digest(manifestBytes) !== options.expectedManifestSha256) throw new Error('candidate bytes do not match producer identity')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const entry = manifest.platforms?.[options.target]
  if (manifest.version !== options.expectedCandidateVersion || entry?.url !== options.candidatePackageUrl || entry?.signature !== signatureText || !new URL(options.candidateManifestUrl).pathname.includes(options.expectedManifestSha256)) throw new Error('candidate manifest identity does not match driver target')
  if (!path.basename(new URL(entry.url).pathname).startsWith(options.expectedPackageSha256.slice(0, 12))) throw new Error('candidate package URL is not content addressed')
  await verifyTauriUpdaterSignature(packageBytes, signatureText, options.expectedUpdaterPublicKey)
  const temporary = await mkdtemp(path.join(tmpdir(), 'dsh-bootstrap-native-'))
  const commandEnvironment = selectBootstrapCommandEnvironment(environment)
  let pid
  let applicationPid
  let listenerPid
  let launchedAt
  let windowsInstallation
  let stagedMacApplication
  let primaryError
  try {
    const installRoot = path.join(temporary, 'install')
    const isolatedHome = path.join(temporary, 'home')
    await Promise.all([mkdir(installRoot), mkdir(isolatedHome)])
    const plan = buildBootstrapCommandPlan({ target: options.target, packagePath: path.resolve(options.candidatePackage), installRoot, signingConfigured: options.signingConfigured === 'true' })
    let installed
    let platform
    let launchEnvironment
    let launchExecutable
    let launchArguments = []
    let verificationRoot
    if (options.target === 'windows-x86_64') {
      await runCommand(plan.install.executable, plan.install.args, { environment: commandEnvironment })
      installed = await inspectWindows(options.expectedCandidateVersion, environment.LOCALAPPDATA, commandEnvironment)
      windowsInstallation = installed
      platform = { package_kind: 'nsis-exe', install_scope: 'current-user', authenticode: 'not-required', code_signing: 'not-applicable', notarization: 'not-applicable', install_registry_root: 'HKCU', install_location_class: 'user-profile', msi_present: false }
      launchEnvironment = { ...commandEnvironment }
      launchExecutable = installed.executable
      verificationRoot = installed.root
    } else if (options.target === 'linux-x86_64') {
      await copyFile(options.candidatePackage, plan.replacementPath)
      await chmod(plan.replacementPath, 0o700)
      if (digest(await readFile(plan.replacementPath)) !== options.expectedPackageSha256 || !(await lstat(plan.replacementPath)).isFile()) throw new Error('AppImage replacement identity is not eligible')
      const extracted = path.join(temporary, 'extracted')
      await mkdir(extracted)
      await runCommand(plan.replacementPath, ['--appimage-extract'], { cwd: extracted, environment: commandEnvironment })
      const root = path.join(extracted, 'squashfs-root')
      const applications = (await walkFiles(path.join(root, 'usr', 'bin'))).filter(file => path.basename(file).toLowerCase().includes('deepseek'))
      if (applications.length !== 1) throw new Error('AppImage application executable is ambiguous')
      installed = { root, executable: applications[0] }
      platform = { package_kind: 'appimage', install_scope: 'user', authenticode: 'not-applicable', code_signing: 'not-applicable', notarization: 'not-applicable', replacement_eligible: true, executable_bit: true }
      launchEnvironment = { ...commandEnvironment, ...plan.launch.environment, HOME: isolatedHome, XDG_CONFIG_HOME: path.join(isolatedHome, '.config'), XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share') }
      launchEnvironment.XDG_RUNTIME_DIR = path.join(isolatedHome, '.runtime')
      launchExecutable = plan.launch.executable
      launchArguments = plan.launch.args
      verificationRoot = installed.root
    } else {
      const [names, verbose] = await Promise.all([
        runCommand('tar', ['-tzf', options.candidatePackage], { environment: commandEnvironment, outputBound: ARCHIVE_LISTING_BOUND }),
        runCommand('tar', ['-tvzf', options.candidatePackage], { environment: commandEnvironment, outputBound: ARCHIVE_LISTING_BOUND })
      ])
      verifyMacArchiveListing(names, verbose)
      await runCommand(plan.install.executable, plan.install.args, { environment: commandEnvironment })
      const mac = await inspectMac(installRoot, options.expectedCandidateVersion, options.signingConfigured === 'true', plan.trustChecks, commandEnvironment)
      if (environment.DSH_BOOTSTRAP_MACOS_APPLICATIONS_STAGING !== 'true') throw new Error('hosted macOS bootstrap staging was not explicitly enabled')
      const stagingPath = macApplicationsStagingPath()
      installed = await stageMacApplication(mac.root, mac.executable, stagingPath, commandEnvironment)
      stagedMacApplication = stagingPath
      platform = { package_kind: 'app-tar-gz', install_scope: 'user', authenticode: 'not-applicable', signing_credentials_configured: options.signingConfigured === 'true', code_signing: mac.codeSigning, notarization: mac.notarization }
      launchEnvironment = { ...commandEnvironment }
      const macLaunch = buildMacLaunchPlan(installed.root)
      launchExecutable = macLaunch.executable
      launchArguments = macLaunch.args
      verificationRoot = installRoot
    }
    await Promise.all(['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'].map(name => launchEnvironment[name] && mkdir(launchEnvironment[name], { recursive: true })))
    if (launchEnvironment.XDG_RUNTIME_DIR) await chmod(launchEnvironment.XDG_RUNTIME_DIR, 0o700)
    const observations = await inspectInstalledTree(installed.root, installed.executable, options.expectedUpdaterEndpoint, options.expectedUpdaterPublicKey)
    await requireHostPortFree()
    const platformName = options.target === 'windows-x86_64' ? 'win' : options.target === 'linux-x86_64' ? 'linux' : 'mac'
    await verifyExtractedBundleContents(verificationRoot, platformName, contract.arch)
    await probeBundledRuntime(verificationRoot, platformName, contract.arch, () => {})
    await requireHostPortFree()
    launchedAt = Date.now()
    const launch = launchApplication(launchExecutable, launchArguments, launchEnvironment)
    pid = launch.pid
    applicationPid = options.target.startsWith('darwin-') ? await waitForMacApplicationProcess(installed.executable, commandEnvironment, launch) : pid
    const configurationIdentity = await waitForConfigurationIdentity(configurationLogPath(options.target, isolatedHome, launchEnvironment), {
      endpoint: options.expectedUpdaterEndpoint,
      publicKeySha256: options.expectedUpdaterPublicKeySha256,
      appVersion: options.expectedCandidateVersion,
      platform: `${contract.platform === 'win32' ? 'windows' : contract.platform === 'darwin' ? 'macos' : 'linux'}-${contract.arch === 'arm64' ? 'aarch64' : 'x86_64'}`,
      processId: options.target === 'linux-x86_64' ? undefined : applicationPid,
      launchedAt
    }, applicationPid, installed.executable, options.target)
    applicationPid = configurationIdentity.process_id
    if (requiresDesktopHostReadiness(options.target)) {
      await waitForHostReady(launch, options.target.startsWith('darwin-'))
      listenerPid = await findFixedHostListenerProcess(options.target, commandEnvironment)
    }
    await Promise.all([...new Set([listenerPid, applicationPid, pid])].map(processId => cleanupProcess(processId, commandEnvironment)))
    pid = undefined
    applicationPid = undefined
    listenerPid = undefined
    return {
      runner: contract.runner, started_at: startedAt, completed_at: new Date().toISOString(), installation: { mode: 'fresh-install', installed_version: configurationIdentity.app_version, launched: true }, platform,
      observations: { ...observations, updater_signature_verified: true, immutable_object_identity_verified: true },
      observation_sources: { configuration_identity: 'runtime-jsonl', signature_identity: 'node-ed25519-minisign', package_identity: 'immutable-manifest-sha256', installation_identity: 'native-platform', host_readiness: 'fixed-origin-http', runtime_closure: 'installed-filesystem' }
    }
  } catch (error) {
    primaryError = error
  } finally {
    const cleanupResults = await Promise.allSettled([
      ...[...new Set([listenerPid, applicationPid, pid].filter(Boolean))].map(processId => cleanupProcess(processId, commandEnvironment)),
      uninstallWindows(windowsInstallation, commandEnvironment),
      cleanupStagedMacApplication(stagedMacApplication, commandEnvironment)
    ])
    const cleanupErrors = cleanupResults.filter(result => result.status === 'rejected').map(result => result.reason)
    try { await rm(temporary, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
    const failure = combineBootstrapFailure(primaryError, cleanupErrors)
    if (failure) throw failure
  }
}

/** 执行 driver CLI，并把唯一有界 JSON observation 写到 stdout。 */
async function main() {
  const body = Buffer.from(JSON.stringify(await runNativeBootstrapDriver(parseArguments(process.argv.slice(2)))))
  if (body.length > OUTPUT_BOUND) throw new Error('bootstrap observation exceeded output bound')
  process.stdout.write(body)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
