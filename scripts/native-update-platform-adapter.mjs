import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import path from 'node:path'

import { verifyTauriUpdaterSignature } from './tauri-updater-signature.mjs'
import { readMachOArchitecture } from './verify-tauri-artifact.mjs'
import { withUpdateSmokeTlsGate } from './update-smoke-tls-gate.mjs'
import { createUpdateSmokeTlsSystemAdapter, runBoundedCommand } from './update-smoke-tls-system-adapter.mjs'
import {
  findDesktopProcessIds,
  findProcessTreePids,
  parseDesktopProcessRows,
  processEnvironmentContainsAppImage,
  processExists,
  sameInstallationLocation,
} from './native-update-processes.mjs'

export { parseDesktopProcessRows, processEnvironmentContainsAppImage, sameInstallationLocation }

const APP_IDENTIFIER = 'io.github.xlcyun.dsh-desktop'
const FIXED_ORIGIN = 'http://127.0.0.1:3080/'
const OUTPUT_BOUND = 128 * 1024
const UPDATE_LOG_BOUND = 16 * 1024 * 1024
const ARCHIVE_LISTING_BOUND = 32 * 1024 * 1024
const MAC_CLOSE_HELPER_SOURCE = path.resolve(import.meta.dirname, 'macos-close-window.swift')
const LINUX_X11_SESSION_SCRIPT = String.raw`set -uo pipefail
/usr/bin/openbox --sm-disable >/dev/null 2>&1 &
wm_pid=$!
app_pid=
cleanup() {
  status=$?
  trap - EXIT
  if [[ -n "$app_pid" ]]; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  kill "$wm_pid" 2>/dev/null || true
  wait "$wm_pid" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for _ in {1..100}; do
  if /usr/bin/wmctrl -m >/dev/null 2>&1; then
    "$1" &
    app_pid=$!
    wait "$app_pid"
    app_status=$?
    app_pid=
    exit "$app_status"
  fi
  /usr/bin/sleep 0.1
done
exit 1`
const TARGETS = Object.freeze({
  'windows-x86_64': Object.freeze({ platform: 'win32', arch: 'x64', runner: { os: 'windows', arch: 'x86_64' }, installKind: 'windows_nsis' }),
  'linux-x86_64': Object.freeze({ platform: 'linux', arch: 'x64', runner: { os: 'linux', arch: 'x86_64' }, installKind: 'linux_app_image' }),
  'darwin-aarch64': Object.freeze({ platform: 'darwin', arch: 'arm64', runner: { os: 'macos', arch: 'aarch64' }, installKind: 'macos_app' }),
  'darwin-x86_64': Object.freeze({ platform: 'darwin', arch: 'x64', runner: { os: 'macos', arch: 'x86_64' }, installKind: 'macos_app' }),
})

/** 计算完整字节的 lowercase SHA-256。 */
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 等待一小段时间，供有界平台轮询共用。 */
function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** 只选择真实 Desktop 与平台工具需要的公开 runner 环境，不继承 CI 凭证。 */
function selectCommandEnvironment(environment) {
  const names = [
    'PATH', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'PSModulePath', 'OS', 'HOME',
    'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA',
    'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
    'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
  ]
  return Object.fromEntries(names.flatMap(name => environment[name] === undefined ? [] : [[name, environment[name]]]))
}

/** 从目标平台与 launch environment 推导 Tauri app config/cache 的唯一 updater 边界。 */
export function platformStatePaths(target, environment) {
  let configRoot
  let cacheRoot
  let pathApi = path.posix
  if (target === 'windows-x86_64') {
    if (!environment.APPDATA || !environment.LOCALAPPDATA) throw new Error('Windows updater state roots are unavailable')
    configRoot = path.win32.join(environment.APPDATA, APP_IDENTIFIER)
    cacheRoot = path.win32.join(environment.LOCALAPPDATA, APP_IDENTIFIER)
    pathApi = path.win32
  } else if (target === 'linux-x86_64') {
    const configBase = environment.XDG_CONFIG_HOME ?? (environment.HOME && path.posix.join(environment.HOME, '.config'))
    const cacheBase = environment.XDG_CACHE_HOME ?? (environment.HOME && path.posix.join(environment.HOME, '.cache'))
    if (!configBase || !cacheBase) throw new Error('Linux updater state roots are unavailable')
    configRoot = path.posix.join(configBase, APP_IDENTIFIER)
    cacheRoot = path.posix.join(cacheBase, APP_IDENTIFIER)
  } else if (target?.startsWith('darwin-')) {
    if (!environment.HOME) throw new Error('macOS updater state roots are unavailable')
    configRoot = path.posix.join(environment.HOME, 'Library', 'Application Support', APP_IDENTIFIER)
    cacheRoot = path.posix.join(environment.HOME, 'Library', 'Caches', APP_IDENTIFIER)
  } else {
    throw new Error(`unsupported updater state target: ${target ?? ''}`)
  }
  return Object.freeze({
    configRoot,
    cacheRoot,
    logFile: pathApi.join(configRoot, 'logs', 'updater.jsonl'),
    stagedMetadata: pathApi.join(cacheRoot, 'desktop-update', 'staged.json'),
    stagedPackage: pathApi.join(cacheRoot, 'desktop-update', 'package.bin'),
  })
}

/** 验证 staged metadata 与完整下载包同时绑定本次候选。 */
export function verifyStagedCandidate(metadata, packageBytes, expected) {
  if (metadata?.version !== expected.version || metadata.signature !== expected.signature || metadata.target !== expected.target || metadata.install_kind !== expected.installKind) {
    throw new Error('staged candidate identity mismatch')
  }
  if (digest(packageBytes) !== expected.packageSha256) throw new Error('staged candidate package digest mismatch')
  return true
}

/** 为真实原生关闭/退出生成不经过 shell 的精确命令。 */
export function nativeCloseCommandPlan(target, launch) {
  if (target === 'windows-x86_64') {
    if (!Number.isSafeInteger(launch.applicationPid) || launch.applicationPid <= 0) throw new Error('native close requires the Desktop application PID')
    return {
      executable: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${launch.applicationPid} -ErrorAction Stop; if (-not $p.CloseMainWindow()) { throw 'Desktop main window did not accept close' }`],
      environment: {},
    }
  }
  if (target === 'linux-x86_64') {
    if (!/^0x[0-9a-f]+$/i.test(launch.windowId ?? '') || !/^:\d+$/.test(launch.display ?? '') || !path.isAbsolute(launch.xauthority ?? '') || launch.xauthority.includes('\0')) throw new Error('Linux native close requires an exact X11 window, display, and authority file')
    return { executable: 'wmctrl', args: ['-i', '-c', launch.windowId], environment: { DISPLAY: launch.display, XAUTHORITY: launch.xauthority } }
  }
  if (target?.startsWith('darwin-')) {
    if (!Number.isSafeInteger(launch.applicationPid) || launch.applicationPid <= 0) throw new Error('native close requires the Desktop application PID')
    if (!path.isAbsolute(launch.closeHelper ?? '')) throw new Error('native close requires the compiled macOS window helper')
    return {
      executable: launch.closeHelper,
      args: [String(launch.applicationPid)],
      environment: {},
    }
  }
  throw new Error(`unsupported native close target: ${target ?? ''}`)
}

/** 在固定 Xvfb 内先启动 EWMH window manager，再以位置参数启动 exact AppImage。 */
export function linuxX11LaunchPlan(installationPath) {
  if (!path.isAbsolute(installationPath) || installationPath.includes('\0')) throw new Error('Linux X11 launch requires an absolute AppImage path')
  const xauthority = path.join(path.dirname(installationPath), '.Xauthority')
  return {
    executable: 'dbus-run-session',
    args: [
      '--', 'xvfb-run', '-n', '99', '-f', xauthority, '-s', '-screen 0 1280x1024x24',
      '/usr/bin/bash', '-c', LINUX_X11_SESSION_SCRIPT, 'dsh-native-update-x11', installationPath,
    ],
    display: ':99',
    xauthority,
  }
}

/** 从脱敏更新日志提取最新失败阶段，并识别无需等待自动重试的永久 HTTP 失败。 */
export function nativeUpdaterFailureSummary(logBody) {
  if (!Buffer.isBuffer(logBody) || logBody.length > UPDATE_LOG_BOUND) throw new Error('native updater log exceeds byte bound')
  const records = logBody.toString('utf8').trim().split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  const failure = records.findLast(record => record?.event === 'update-failed')
  if (!failure) return undefined
  const stage = ['check', 'download'].includes(failure.failure_stage) ? failure.failure_stage : 'unknown'
  const status = Number.isInteger(failure.http_status) && failure.http_status >= 100 && failure.http_status <= 599 ? failure.http_status : undefined
  return Object.freeze({
    message: `native updater failed during ${stage} stage${status ? ` (HTTP ${status})` : ''}`,
    permanent: status !== undefined && status >= 400 && status < 500 && ![408, 429].includes(status),
  })
}

/** 递归列出普通文件，忽略 macOS bundle framework symlink。 */
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

/** 从实际安装树证明官方 Node、published CLI closure、Desktop 包与编译信任根。 */
async function inspectInstalledRuntimeTree(root, executable, endpoint, publicKey) {
  const canonicalRoot = await realpath(root)
  const canonicalExecutable = await realpath(executable)
  if (canonicalExecutable !== canonicalRoot && !canonicalExecutable.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error('Desktop executable escapes installed tree')
  const files = await walkFiles(canonicalRoot)
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const nodeExecutable = files.find(file => path.basename(file) === nodeName && file.includes(`${path.sep}node${path.sep}`))
  const closure = files.find(file => file.endsWith(path.join('@deepseek-ai', 'dsh', 'package.json')))
  if (!nodeExecutable || !(await stat(nodeExecutable)).isFile()) throw new Error('Official Node is missing from installed Desktop')
  if (!closure) throw new Error('published CLI Runtime closure is missing from installed Desktop')
  const nodeModules = closure.slice(0, -path.join('@deepseek-ai', 'dsh', 'package.json').length)
  const required = [
    ['Desktop capability package', '@cyunlab/dsh-desktop-capabilities/lib/index.js'],
    ['Desktop update-client package', '@cyunlab/dsh-desktop-update-client/lib/client.js'],
    ['composition patch', '@cyunlab/dsh-desktop-update-client/cordis.patch.yml'],
  ]
  for (const [label, relative] of required) if (!(await stat(path.join(nodeModules, ...relative.split('/'))).catch(() => null))?.isFile()) throw new Error(`${label} is missing from installed Desktop`)
  const executableBytes = await readFile(canonicalExecutable)
  if (!executableBytes.includes(Buffer.from(endpoint)) || !executableBytes.includes(Buffer.from(publicKey))) throw new Error('installed Desktop does not contain the trusted updater configuration')
  return Object.freeze({
    official_node: true,
    cli_runtime_closure: true,
    desktop_capabilities_package: true,
    desktop_update_client_package: true,
    composition_patch: true,
    trusted_updater_configuration: true,
  })
}

/** 校验 macOS tar member、唯一 app 根和 symlink 目标均留在 archive 内。 */
function verifyMacArchiveListing(namesOutput, verboseOutput) {
  const names = namesOutput.split(/\r?\n/).filter(Boolean)
  if (names.length === 0) throw new Error('macOS updater archive is empty')
  for (const name of names) {
    const normalized = path.posix.normalize(name)
    if (path.posix.isAbsolute(name) || normalized === '..' || normalized.startsWith('../')) throw new Error('macOS updater archive contains an unsafe path')
  }
  const applications = new Set(names.map(name => name.replace(/^\.\//, '').split('/')[0]).filter(name => name.endsWith('.app')))
  const application = [...applications][0]
  if (applications.size !== 1 || names.some(name => ![application, `${application}/`].includes(name.replace(/^\.\//, '')) && !name.replace(/^\.\//, '').startsWith(`${application}/`))) throw new Error('macOS updater archive must contain exactly one application root')
  for (const line of verboseOutput.split(/\r?\n/).filter(line => line.startsWith('l') && line.includes(' -> '))) {
    const [left, target] = line.split(' -> ')
    const member = names.find(name => left.endsWith(name))
    if (!member || path.posix.isAbsolute(target) || path.posix.normalize(path.posix.join(path.posix.dirname(member), target)).startsWith('../')) throw new Error('macOS updater archive contains an escaping symlink')
  }
}

/** 按 Windows 路径语义校验 NSIS 当前用户安装记录。 */
function verifyWindowsInstallationRecord(record, version, installLocation, userRoot) {
  const relative = path.win32.relative(userRoot.toLowerCase(), installLocation.toLowerCase())
  const underUserRoot = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative))
  if (record.DisplayVersion !== version || Number(record.WindowsInstaller ?? 0) !== 0 || !underUserRoot) throw new Error('Windows installation is not the expected non-MSI current-user NSIS release')
}

/** 解析注册表可选引号包裹的绝对 Windows 安装路径。 */
function normalizeWindowsRegistryPath(value) {
  const input = String(value ?? '').trim()
  const unquoted = input.startsWith('"') && input.endsWith('"') ? input.slice(1, -1) : input
  if (!unquoted || unquoted.includes('"') || !path.win32.isAbsolute(unquoted)) throw new Error('invalid absolute Windows registry install path')
  return path.win32.normalize(unquoted)
}

/** 从 HKCU uninstall registry 定位唯一 Desktop 当前用户 NSIS 安装。 */
async function inspectWindows(version, environment, command) {
  const script = "$ErrorActionPreference='Stop'; $cu=@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object {$_.DisplayName -eq 'DeepSeek Harness Desktop'}); $lm=@(Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -eq 'DeepSeek Harness Desktop'}); if ($cu.Count -ne 1 -or $lm.Count -ne 0) { throw 'expected exactly one HKCU and no HKLM uninstall record' }; [Console]::Out.Write(($cu[0] | Select-Object InstallLocation,DisplayVersion,WindowsInstaller | ConvertTo-Json -Compress))"
  const record = JSON.parse(await command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { environment }))
  const installLocation = normalizeWindowsRegistryPath(record.InstallLocation)
  const [canonicalInstallLocation, canonicalUserRoot] = await Promise.all([realpath(installLocation), realpath(environment.LOCALAPPDATA)])
  verifyWindowsInstallationRecord(record, version, canonicalInstallLocation, canonicalUserRoot)
  const entries = await readdir(canonicalInstallLocation)
  const executables = entries.filter(name => name.toLowerCase().endsWith('.exe') && name.toLowerCase().includes('deepseek'))
  const uninstallers = entries.filter(name => name.toLowerCase().endsWith('.exe') && name.toLowerCase().includes('uninstall'))
  if (executables.length !== 1 || uninstallers.length !== 1) throw new Error('Windows Desktop executable or uninstaller is missing or ambiguous')
  return { root: canonicalInstallLocation, runtimeRoot: canonicalInstallLocation, executable: path.join(canonicalInstallLocation, executables[0]), uninstaller: path.join(canonicalInstallLocation, uninstallers[0]), version }
}

/** 从 macOS bundle 的 Info.plist 获取真实主程序与版本，并按配置验证签名材料。 */
async function inspectMac(application, version, expectedArchitecture, signingConfigured, environment, command) {
  const plist = path.join(application, 'Contents', 'Info.plist')
  const executableName = (await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { environment })).trim()
  const installedVersion = (await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { environment })).trim()
  if (installedVersion !== version) throw new Error(`installed macOS version does not match ${version}`)
  if (signingConfigured) {
    await command('codesign', ['--verify', '--deep', '--strict', application], { environment })
    await command('spctl', ['--assess', '--type', 'execute', application], { environment })
    await command('xcrun', ['stapler', 'validate', application], { environment })
  }
  const canonical = await realpath(application)
  const executable = await realpath(path.join(canonical, 'Contents', 'MacOS', executableName))
  const architecture = await readMachOArchitecture(executable)
  if (architecture !== expectedArchitecture) throw new Error(`installed macOS architecture does not match ${expectedArchitecture}`)
  return { root: canonical, runtimeRoot: canonical, executable, application: canonical, version }
}

/** 编译仓库自有的 exact-PID macOS 原生窗口关闭 helper，不修改 runner TCC。 */
async function compileMacCloseHelper(temporaryRoot, environment, command) {
  const executable = path.join(temporaryRoot, 'macos-close-window')
  await command('xcrun', [
    'swiftc', '-parse-as-library', '-O', '-framework', 'AppKit', '-framework', 'ApplicationServices',
    MAC_CLOSE_HELPER_SOURCE, '-o', executable,
  ], { environment, timeoutMilliseconds: 3 * 60 * 1000, outputBound: 4 * 1024 * 1024 })
  await chmod(executable, 0o700)
  await command(executable, ['--probe-trust'], { environment, timeoutMilliseconds: 10_000 })
  return executable
}

/** 把已由 manifest/签名绑定的 AppImage 展开到唯一目录并定位真实 Desktop 主程序。 */
async function inspectLinuxAppImage(installationPath, version, temporaryRoot, environment, command) {
  const extraction = await mkdtemp(path.join(temporaryRoot, 'appimage-inspect-'))
  await command(installationPath, ['--appimage-extract'], { cwd: extraction, environment, outputBound: 4 * 1024 * 1024 })
  const root = path.join(extraction, 'squashfs-root')
  const applications = (await walkFiles(path.join(root, 'usr', 'bin'))).filter(file => path.basename(file).toLowerCase().includes('deepseek'))
  if (applications.length !== 1) throw new Error('AppImage Desktop executable is missing or ambiguous')
  return { root, runtimeRoot: root, executable: applications[0], installPath: installationPath, version, extraction }
}

/** 读取固定 loopback Host 的有界 HTTP 响应。 */
function requestLoopbackHttp(timeoutMilliseconds = 3_000) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(FIXED_ORIGIN, { method: 'GET', agent: false, headers: { connection: 'close' } }, response => {
      const chunks = []
      let bytes = 0
      response.on('data', chunk => {
        bytes += chunk.length
        if (bytes > OUTPUT_BOUND) response.destroy(new Error('fixed Host response exceeds byte bound'))
        else chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => resolve({ statusCode: response.statusCode ?? 0, contentType: response.headers['content-type'] ?? '', body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.setTimeout(timeoutMilliseconds, () => request.destroy(new Error('fixed Host request timed out')))
    request.once('error', reject)
    request.end()
  })
}

/** 启动前确认固定 Host 端口没有其他 runner 进程。 */
function requireHostPortFree() {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: 3080 })
    socket.setTimeout(1_000)
    socket.once('connect', () => { socket.destroy(); reject(new Error('fixed Host port is already occupied')) })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('fixed Host port availability probe timed out')) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(new Error(`fixed Host port probe failed: ${error.code ?? error.message}`)))
  })
}

/** 启动真实 Desktop 或平台 launcher，并保留有界退出状态与诊断。 */
function launchApplication(executable, args, environment) {
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
  /** 返回 launcher 当前退出码；未退出时保持 undefined。 */
  function readExitCode() { return exitCode }
  /** 返回 launcher 当前退出诊断；运行中保持 undefined。 */
  function readExitStatus() { return exitStatus }
  /** 合并有界 stdout、stderr 与退出状态用于失败诊断。 */
  function diagnostics() {
    return [Buffer.concat(output).toString('utf8').trim().slice(0, OUTPUT_BOUND), bytes > OUTPUT_BOUND ? '[diagnostics truncated]' : '', exitStatus ?? ''].filter(Boolean).join('\n')
  }
  return {
    pid: child.pid,
    child,
    exitCode: readExitCode,
    exitStatus: readExitStatus,
    diagnostics,
  }
}

/** 校验 runtime configuration identity 严格属于本次 Desktop 启动。 */
function verifyConfigurationIdentityEvent(event, expected) {
  if (event?.event !== 'updater-configuration-identity' || event.correlation_id !== 'updater-configuration') throw new Error('invalid updater configuration identity event')
  if (event.endpoint !== expected.endpoint || event.public_key_sha256 !== expected.publicKeySha256 || event.platform !== expected.platform || event.app_version !== expected.version) throw new Error('updater configuration identity mismatch')
  if (!Number.isSafeInteger(event.process_id) || event.process_id <= 0) throw new Error('updater configuration process mismatch')
  const recordedAt = Date.parse(event.recorded_at)
  if (!Number.isFinite(recordedAt) || recordedAt < expected.launchedAt - 5_000 || recordedAt > Date.now() + 5_000) throw new Error('updater configuration timestamp is outside this launch')
}

/** 证明配置日志 PID 是 exact 安装来源当前唯一的 Desktop 主程序。 */
async function verifyDesktopProcess(target, pid, installation, environment, command) {
  const pids = await findDesktopProcessIds(target, installation, environment, command)
  if (pids.length !== 1 || pids[0] !== pid) throw new Error('updater configuration PID is not the unique installed Desktop process')
}

/** 从有界 JSONL 日志中解析与本次启动配置严格匹配的身份记录。 */
export function matchingConfigurationIdentityEvents(logBody, expected) {
  if (!Buffer.isBuffer(logBody) || logBody.length > UPDATE_LOG_BOUND) throw new Error('updater configuration log exceeds byte bound')
  return logBody.toString('utf8').trim().split(/\r?\n/).reverse().flatMap(line => {
    try {
      const event = JSON.parse(line)
      verifyConfigurationIdentityEvent(event, expected)
      return [event]
    } catch {
      return []
    }
  })
}

/** 从有界 JSONL 日志等待本次 app version 与 PID 的真实配置身份。 */
async function waitForConfigurationIdentity(logFile, expected, installation, target, environment, command) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const body = await readFile(logFile).catch(() => null)
    if (body) {
      for (const event of matchingConfigurationIdentityEvents(body, expected)) {
        try {
          await verifyDesktopProcess(target, event.process_id, installation, environment, command)
          return event
        } catch {}
      }
    }
    await delay(500)
  }
  throw new Error(`matching updater configuration identity was not observed for ${expected.version}`)
}

/** 等待固定 Host 返回非空 HTML，证明真实 bundled CLI Runtime 已 ready。 */
async function waitForHostReady(launch) {
  const deadline = Date.now() + 4 * 60 * 1000
  while (Date.now() < deadline) {
    if (launch.exitStatus() && !(launch.launcherMayExit && launch.exitCode() === 0)) throw new Error(`Desktop exited before fixed Host readiness: ${launch.diagnostics()}`)
    try {
      const response = await requestLoopbackHttp()
      if (response.statusCode >= 200 && response.statusCode < 300 && /text\/html/i.test(String(response.contentType)) && response.body.trim()) return
    } catch {}
    await delay(1_000)
  }
  throw new Error(`fixed Host origin did not become ready: ${launch.diagnostics()}`)
}

/** 用平台原生端口工具绑定固定 Host 的唯一 listener PID。 */
async function findFixedHostListenerProcess(target, environment, command) {
  let output
  if (target === 'windows-x86_64') {
    const script = "$pids=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 3080 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique); [Console]::Out.Write(($pids -join \"`n\"))"
    output = await command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { environment })
  } else {
    const executable = target.startsWith('darwin-') ? '/usr/sbin/lsof' : 'lsof'
    output = await command(executable, ['-nP', '-a', '-iTCP@127.0.0.1:3080', '-sTCP:LISTEN', '-Fp'], { environment })
  }
  const pids = [...new Set(String(output).split(/\r?\n/).map(line => /^p?(\d+)$/.exec(line.trim())?.[1]).filter(Boolean).map(Number))]
  if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] <= 0) throw new Error('fixed Host listener PID is missing or ambiguous')
  return pids[0]
}

/** 从 wmctrl 快照中只解析后续绑定所需的窗口 ID 与 PID。 */
export function parseLinuxDesktopWindows(output) {
  return String(output).split(/\r?\n/).flatMap(line => {
    const match = /^(0x[0-9a-f]+)\s+\S+\s+(\d+)\s+/i.exec(line)
    return match ? [{ windowId: match[1], pid: Number(match[2]) }] : []
  })
}

/** 从 wmctrl 快照中只选择属于 Desktop 进程树的唯一窗口。 */
export function selectLinuxDesktopWindow(output, processPids) {
  const allowedPids = new Set(processPids)
  const windows = parseLinuxDesktopWindows(output)
  const matches = windows.filter(window => allowedPids.has(window.pid))
  if (matches.length === 1) return matches[0].windowId
  if (matches.length > 1) throw new Error('Linux Desktop X11 window is ambiguous')
  if (windows.length === 1 && windows[0].pid === 0) return windows[0].windowId
  return undefined
}

/** 等待 Linux X11 中属于真实 Desktop 进程树的唯一主窗口。 */
async function waitForLinuxWindow(pid, environment, command) {
  const deadline = Date.now() + 60_000
  let lastOutput = ''
  let lastProcessPids = []
  while (Date.now() < deadline) {
    const [output, processPids] = await Promise.all([
      command('wmctrl', ['-lp'], { environment }).catch(() => ''),
      findProcessTreePids('linux-x86_64', pid, environment, command),
    ])
    lastOutput = output
    lastProcessPids = processPids
    const windowId = selectLinuxDesktopWindow(output, processPids)
    if (windowId) return windowId
    await delay(500)
  }
  const snapshot = {
    root_pid: pid,
    process_tree_pids: lastProcessPids.slice(0, 64),
    windows: parseLinuxDesktopWindows(lastOutput).slice(0, 64),
  }
  throw new Error(`Linux Desktop X11 window was not observed: ${JSON.stringify(snapshot)}`)
}

/** 先等待固定 Host ready，再观察依赖页面加载的 Linux X11 主窗口。 */
export async function waitForLinuxDesktopReadiness(waitForHost, waitForWindow) {
  await waitForHost()
  return await waitForWindow()
}

/** hosted Windows 无交互 WebView 会话时跳过 Host readiness，仍保留真实 Desktop updater 与安装验证。 */
export function requiresDesktopHostReadiness(target) {
  return target !== 'windows-x86_64'
}

/** 强制清理失败路径上的 Desktop 进程树，不用于生成正常退出证据。 */
async function cleanupLaunch(target, launch, environment, command) {
  if (!launch?.applicationPid && !launch?.pid) return
  const pids = [...new Set([launch.listenerPid, launch.applicationPid, launch.pid].filter(Boolean))]
  if (target === 'windows-x86_64') {
    for (const pid of pids) await command('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { environment }).catch(() => {})
  } else {
    for (const pid of pids) {
      try { process.kill(-pid, 'SIGTERM') } catch {}
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
    await delay(1_000)
    for (const pid of pids) {
      try { process.kill(-pid, 'SIGKILL') } catch {}
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  }
}

/** 静默卸载当前 Windows NSIS，并确认 HKCU record 消失。 */
async function uninstallWindows(installation, environment, command) {
  if (!installation?.uninstaller || !(await lstat(installation.uninstaller).catch(() => null))) return
  await command(installation.uninstaller, ['/S'], { environment })
  const script = "$items=@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -eq 'DeepSeek Harness Desktop'}); [Console]::Out.Write($items.Count)"
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if ((await command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { environment })).trim() === '0') return
    await delay(500)
  }
  throw new Error('Windows NSIS uninstall record did not disappear')
}

/** 在创建任何应用状态前要求 hosted runner 没有旧安装或旧状态。 */
async function requireAbsent(paths) {
  for (const candidate of paths) if (await lstat(candidate).catch(() => null)) throw new Error(`native update smoke runner is not clean: ${path.basename(candidate)}`)
}

/** 创建四平台 previous-Stable→candidate 正常退出升级的真实系统适配器。 */
export function createNativeUpdatePlatformAdapter(target, environment = process.env, dependencies = {}) {
  const contract = TARGETS[target]
  if (!contract) throw new Error(`unsupported native update target: ${target ?? ''}`)
  const command = dependencies.runCommand ?? runBoundedCommand
  const commandEnvironment = selectCommandEnvironment(environment)
  const tlsSystemAdapter = dependencies.tlsSystemAdapter ?? createUpdateSmokeTlsSystemAdapter(environment)
  const platform = target === 'windows-x86_64'
    ? { package_kind: 'nsis-exe', install_scope: 'current-user', authenticode: 'not-required', code_signing: 'not-applicable', notarization: 'not-applicable', install_registry_root: 'HKCU', install_location_class: 'user-profile', msi_present: false }
    : target === 'linux-x86_64'
      ? { package_kind: 'appimage', install_scope: 'user', authenticode: 'not-applicable', code_signing: 'not-applicable', notarization: 'not-applicable', replacement_path_same: true, executable_bit: true, digest_changed: true }
      : { package_kind: 'app-tar-gz', install_scope: 'user', authenticode: 'not-applicable', signing_credentials_configured: false, code_signing: 'not-configured', notarization: 'not-configured' }
  let temporary
  let statePaths
  let baselineInstallation
  let currentInstallation
  let baselineDigest
  let macCloseHelper
  const launches = []

  /** 检查下载资产、签名、公钥和 candidate manifest 的 byte-exact pairing。 */
  async function verifyInputs(options) {
    const [baselineBytes, baselineSignature, candidateBytes, candidateSignature] = await Promise.all([
      readFile(options.baselineArtifact), readFile(options.baselineSignature, 'utf8'), readFile(options.candidatePackage), readFile(options.candidateSignature, 'utf8'),
    ])
    if (digest(options.updaterPublicKey) !== options.updaterPublicKeySha256) throw new Error('updater public key digest mismatch')
    if (digest(candidateBytes) !== options.candidatePackageSha256) throw new Error('candidate package digest mismatch')
    await Promise.all([
      verifyTauriUpdaterSignature(baselineBytes, baselineSignature, options.updaterPublicKey),
      verifyTauriUpdaterSignature(candidateBytes, candidateSignature, options.updaterPublicKey),
    ])
    const manifest = JSON.parse(options.candidateManifest.toString('utf8'))
    const entry = manifest.platforms?.[target]
    if (manifest.version !== options.candidateVersion || entry?.signature !== candidateSignature) throw new Error('candidate manifest identity mismatch')
    const immutableDigest = /^([0-9a-f]{64})-/.exec(path.posix.basename(new URL(entry.url).pathname))?.[1]
    if (immutableDigest !== options.candidatePackageSha256) throw new Error('candidate manifest package identity mismatch')
    return { baselineBytes, candidateBytes, candidateSignature }
  }

  /** 安装并检查 exact previous Stable 原生产物。 */
  async function installBaseline(options) {
    const inputs = await verifyInputs(options)
    temporary = await mkdtemp(path.join(tmpdir(), 'dsh-native-update-'))
    const isolatedHome = path.join(temporary, 'home')
    await mkdir(isolatedHome)
    let launchEnvironment = { ...commandEnvironment }
    if (target === 'linux-x86_64') {
      launchEnvironment = {
        ...launchEnvironment,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
        XDG_CACHE_HOME: path.join(isolatedHome, '.cache'),
        XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share'),
        XDG_RUNTIME_DIR: path.join(isolatedHome, '.runtime'),
        APPIMAGE_EXTRACT_AND_RUN: '1',
        NO_AT_BRIDGE: '1',
      }
      await Promise.all(['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'].map(name => mkdir(launchEnvironment[name], { recursive: true })))
      await chmod(launchEnvironment.XDG_RUNTIME_DIR, 0o700)
    }
    statePaths = platformStatePaths(target, launchEnvironment)
    if (target !== 'linux-x86_64') await requireAbsent([statePaths.configRoot, statePaths.cacheRoot])
    if (target === 'windows-x86_64') {
      await command(options.baselineArtifact, ['/S'], { environment: commandEnvironment })
      const deadline = Date.now() + 60_000
      let lastError
      while (!baselineInstallation && Date.now() < deadline) {
        try { baselineInstallation = await inspectWindows(options.baselineVersion, commandEnvironment, command) } catch (error) { lastError = error; await delay(500) }
      }
      if (!baselineInstallation) throw new Error(`Windows baseline installation did not become ready: ${lastError?.message ?? 'unknown'}`)
    } else if (target === 'linux-x86_64') {
      const installRoot = path.join(temporary, 'install')
      await mkdir(installRoot)
      const installPath = path.join(installRoot, 'DeepSeek-Harness-Desktop.AppImage')
      await copyFile(options.baselineArtifact, installPath)
      await chmod(installPath, 0o700)
      baselineInstallation = await inspectLinuxAppImage(installPath, options.baselineVersion, temporary, commandEnvironment, command)
      baselineInstallation.launchEnvironment = launchEnvironment
    } else {
      const installRoot = path.join(temporary, 'install')
      await mkdir(installRoot)
      const [names, verbose] = await Promise.all([
        command('tar', ['-tzf', options.baselineArtifact], { environment: commandEnvironment, outputBound: ARCHIVE_LISTING_BOUND }),
        command('tar', ['-tvzf', options.baselineArtifact], { environment: commandEnvironment, outputBound: ARCHIVE_LISTING_BOUND }),
      ])
      verifyMacArchiveListing(names, verbose)
      await command('tar', ['-xzf', options.baselineArtifact, '-C', installRoot], { environment: commandEnvironment })
      const apps = (await readdir(installRoot)).filter(name => name.endsWith('.app'))
      if (apps.length !== 1) throw new Error('macOS baseline archive application is ambiguous')
      const expectedArchitecture = contract.arch === 'arm64' ? 'aarch64' : 'x86_64'
      baselineInstallation = await inspectMac(path.join(installRoot, apps[0]), options.baselineVersion, expectedArchitecture, options.signingConfigured === 'true', commandEnvironment, command)
      macCloseHelper = await compileMacCloseHelper(temporary, commandEnvironment, command)
      baselineInstallation.closeHelper = macCloseHelper
      baselineInstallation.launchEnvironment = launchEnvironment
      if (options.signingConfigured === 'true') Object.assign(platform, { signing_credentials_configured: true, code_signing: 'verified', notarization: 'verified' })
    }
    baselineInstallation.launchEnvironment ??= launchEnvironment
    baselineInstallation.statePaths = statePaths
    baselineDigest = digest(inputs.baselineBytes)
    currentInstallation = baselineInstallation
    return baselineInstallation
  }

  /** 按平台启动已安装 Desktop，不使用测试构建或 runtime hook。 */
  async function launch(installation) {
    await requireHostPortFree()
    const preexistingPids = await findDesktopProcessIds(target, installation, commandEnvironment, command)
    if (preexistingPids.length > 0) throw new Error(`Desktop was already running before the explicit launch: ${preexistingPids.join(',')}`)
    let executable = installation.executable
    let args = []
    let launchEnvironment = { ...installation.launchEnvironment }
    let launcherMayExit = false
    let display
    let xauthority
    if (target === 'linux-x86_64') {
      const plan = linuxX11LaunchPlan(installation.installPath)
      display = plan.display
      xauthority = plan.xauthority
      executable = plan.executable
      args = plan.args
      launchEnvironment.DISPLAY = display
      launchEnvironment.XAUTHORITY = xauthority
    } else if (target.startsWith('darwin-')) {
      executable = '/usr/bin/open'
      args = ['-n', '-a', installation.application]
      launcherMayExit = true
    }
    const launchedAt = Date.now()
    const result = { ...launchApplication(executable, args, launchEnvironment), installation, launchedAt, launcherMayExit, display, xauthority, closeHelper: installation.closeHelper }
    launches.push(result)
    return result
  }

  /** 等待配置身份、真实 PID、X11 窗口与固定 Host Ready。 */
  async function waitForReady(launchResult, version, options) {
    const platformName = `${contract.platform === 'win32' ? 'windows' : contract.platform === 'darwin' ? 'macos' : 'linux'}-${contract.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
    const event = await waitForConfigurationIdentity(statePaths.logFile, {
      endpoint: options.updaterEndpoint,
      publicKeySha256: options.updaterPublicKeySha256,
      platform: platformName,
      version,
      launchedAt: launchResult.launchedAt,
    }, launchResult.installation, target, commandEnvironment, command)
    launchResult.applicationPid = event.process_id
    if (launches.some(previous => previous !== launchResult && previous.applicationPid === event.process_id)) throw new Error('explicit updated launch reused a previous Desktop PID')
    if (target === 'linux-x86_64') {
      launchResult.windowId = await waitForLinuxDesktopReadiness(
        () => waitForHostReady(launchResult),
        () => waitForLinuxWindow(event.process_id, { ...commandEnvironment, DISPLAY: launchResult.display, XAUTHORITY: launchResult.xauthority }, command),
      )
    } else if (requiresDesktopHostReadiness(target)) {
      await waitForHostReady(launchResult)
    }
    if (requiresDesktopHostReadiness(target)) {
      launchResult.listenerPid = await findFixedHostListenerProcess(target, commandEnvironment, command)
      launchResult.listenerTreePids = await findProcessTreePids(target, launchResult.listenerPid, commandEnvironment, command)
    }
    if (version === options.candidateVersion) {
      const deadline = Date.now() + 30_000
      while (await lstat(statePaths.stagedMetadata).catch(() => null)) {
        if (Date.now() >= deadline) throw new Error('updated Desktop did not reconcile deferred staging state')
        await delay(250)
      }
    }
  }

  /** 等待真实自动检查/下载完成，并验证 staging metadata、签名和 package bytes。 */
  async function waitForStaged(_installation, options) {
    const candidateSignature = await readFile(options.candidateSignature, 'utf8')
    const deadline = Date.now() + 8 * 60 * 1000
    let latestFailure
    while (Date.now() < deadline) {
      const [metadataBody, packageBytes, logBody] = await Promise.all([
        readFile(statePaths.stagedMetadata).catch(() => null),
        readFile(statePaths.stagedPackage).catch(() => null),
        readFile(statePaths.logFile).catch(() => null),
      ])
      if (logBody) {
        const failure = nativeUpdaterFailureSummary(logBody)
        latestFailure = failure?.message ?? latestFailure
        if (failure?.permanent) throw new Error(failure.message)
      }
      if (metadataBody && packageBytes && logBody) {
        if (metadataBody.length > OUTPUT_BOUND) throw new Error('native updater state exceeds byte bound')
        const records = logBody.toString('utf8').trim().split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
        const transitions = records.filter(record => record.event === 'update-transition' && record.version === options.candidateVersion)
        if (transitions.length >= 3 && transitions.some(record => record.http_status === 200)) {
          verifyStagedCandidate(JSON.parse(metadataBody.toString('utf8')), packageBytes, {
            version: options.candidateVersion,
            signature: candidateSignature,
            target,
            installKind: contract.installKind,
            packageSha256: options.candidatePackageSha256,
          })
          return
        }
      }
      await delay(1_000)
    }
    throw new Error(latestFailure ?? 'candidate did not reach verified staged state')
  }

  /** 发出真实 Windows close、Linux X11 close 或 macOS 唯一主窗口 AXPress。 */
  async function requestNormalClose(launchResult) {
    const plan = nativeCloseCommandPlan(target, launchResult)
    await command(plan.executable, plan.args, { environment: { ...commandEnvironment, ...plan.environment } })
  }

  /** 确认应用 PID、Host listener 与 staging 均完成正常退出安装。 */
  async function waitForNormalClose(launchResult) {
    const deadline = Date.now() + 4 * 60 * 1000
    while (Date.now() < deadline) {
      const desktopPids = await findDesktopProcessIds(target, launchResult.installation, commandEnvironment, command)
      const hostTreeAlive = (await Promise.all((launchResult.listenerTreePids ?? [launchResult.listenerPid]).map(pid => processExists(target, pid, commandEnvironment, command)))).some(Boolean)
      let hostAlive = false
      try { await requestLoopbackHttp(1_000); hostAlive = true } catch {}
      const synchronousInstallCompleted = target === 'windows-x86_64' || !(await lstat(statePaths.stagedMetadata).catch(() => null))
      if (desktopPids.length === 0 && !hostTreeAlive && !hostAlive && synchronousInstallCompleted) return
      await delay(500)
    }
    throw new Error(`Desktop or Host did not finish normal-close installation: ${launchResult.diagnostics()}`)
  }

  /** 从同一安装位置轮询并验证候选版本已经原地替换。 */
  async function inspectUpdatedInstallation(_baseline, options) {
    const deadline = Date.now() + 4 * 60 * 1000
    let lastError
    while (Date.now() < deadline) {
      try {
        if (target === 'windows-x86_64') {
          currentInstallation = await inspectWindows(options.candidateVersion, commandEnvironment, command)
          if (!sameInstallationLocation(target, baselineInstallation, currentInstallation)) throw new Error('Windows update did not replace the baseline installation in place')
        }
        else if (target === 'linux-x86_64') {
          const packageBytes = await readFile(baselineInstallation.installPath)
          if (digest(packageBytes) !== options.candidatePackageSha256 || digest(packageBytes) === baselineDigest) throw new Error('AppImage replacement digest mismatch')
          currentInstallation = await inspectLinuxAppImage(baselineInstallation.installPath, options.candidateVersion, temporary, commandEnvironment, command)
        } else {
          const expectedArchitecture = contract.arch === 'arm64' ? 'aarch64' : 'x86_64'
          currentInstallation = await inspectMac(baselineInstallation.application, options.candidateVersion, expectedArchitecture, options.signingConfigured === 'true', commandEnvironment, command)
        }
        if (!sameInstallationLocation(target, baselineInstallation, currentInstallation)) throw new Error('update did not replace the baseline installation in place')
        currentInstallation.launchEnvironment = baselineInstallation.launchEnvironment
        currentInstallation.closeHelper = macCloseHelper
        currentInstallation.statePaths = statePaths
        return currentInstallation
      } catch (error) {
        lastError = error
        await delay(1_000)
      }
    }
    throw new Error(`updated installation did not reach candidate identity: ${lastError?.message ?? 'unknown'}`)
  }

  /** 正常关闭安装必须保持退出状态，直到 harness 主动重新启动。 */
  async function assertNotRelaunched(_previousLaunch) {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const desktopPids = await findDesktopProcessIds(target, currentInstallation, commandEnvironment, command)
      if (desktopPids.length > 0) throw new Error(`normal-close update relaunched Desktop process ${desktopPids.join(',')}`)
      try { await requestLoopbackHttp(500); throw new Error('normal-close update relaunched the fixed Host') } catch (error) { if (error.message === 'normal-close update relaunched the fixed Host') throw error }
      await delay(500)
    }
  }

  /** 清理本次 runner 创建的进程、NSIS 安装、app state 与临时目录。 */
  async function cleanup() {
    const errors = []
    if (currentInstallation) {
      const orphanPids = await findDesktopProcessIds(target, currentInstallation, commandEnvironment, command).catch(error => { errors.push(error); return [] })
      for (const applicationPid of orphanPids) await cleanupLaunch(target, { applicationPid }, commandEnvironment, command).catch(error => errors.push(error))
    }
    for (const launchResult of launches.reverse()) await cleanupLaunch(target, launchResult, commandEnvironment, command).catch(error => errors.push(error))
    if (target === 'windows-x86_64') await uninstallWindows(currentInstallation ?? baselineInstallation, commandEnvironment, command).catch(error => errors.push(error))
    for (const root of [statePaths?.configRoot, statePaths?.cacheRoot, temporary].filter(Boolean)) await rm(root, { recursive: true, force: true }).catch(error => errors.push(error))
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'native update platform cleanup failed')
  }

  /** 从已安装树读取两版都必须成立的 Runtime closure observation。 */
  function inspectInstalledRuntime(installation, options) {
    return inspectInstalledRuntimeTree(installation.runtimeRoot, installation.executable, options.updaterEndpoint, options.updaterPublicKey)
  }

  /** 在 runner-only TLS gate 内执行唯一真实更新生命周期。 */
  function withTlsGate(config, action) {
    return withUpdateSmokeTlsGate(config, action, tlsSystemAdapter)
  }

  return {
    runner: contract.runner,
    platform,
    /** 验证当前 hosted runner 与 evidence target 完全一致。 */
    assertRunner(assertedTarget) {
      if (assertedTarget !== target || process.platform !== contract.platform || process.arch !== contract.arch) throw new Error('hosted runner does not match native update target')
    },
    installBaseline,
    inspectInstalledRuntime,
    withTlsGate,
    launch,
    waitForReady,
    waitForStaged,
    requestNormalClose,
    waitForNormalClose,
    inspectUpdatedInstallation,
    assertNotRelaunched,
    cleanup,
  }
}
