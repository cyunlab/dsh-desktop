import { access, chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { requiredRuntimeAssets, shouldRunPackagedProbe, targetFromAfterPackContext } from './runtime-assets.mjs'

export default async function afterPack(context) {
  return runAfterPack(context)
}

export async function runAfterPack(context, dependencies = {}) {
  const runCommand = dependencies.runCommand ?? runCommandWithTimeout
  const host = dependencies.host ?? { platform: process.platform, arch: process.arch }
  const log = dependencies.log ?? console.log
  const prepareAssets = dependencies.prepareAssets ?? (async (root, selectedTarget) => {
    await waitForPath(path.join(root, 'node_modules'))
    await ensureExecutableModes(root, selectedTarget)
  })
  const target = targetFromAfterPackContext(context)
  const resources = target.platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  const unpacked = path.join(resources, 'app.asar.unpacked')
  await prepareAssets(unpacked, target)
  const verifierArgs = [
    path.resolve('scripts/verify-runtime-closure.mjs'),
    '--app-dir', unpacked,
    '--manifest', path.resolve('package.json'),
    '--target-platform', target.platform,
    '--target-arch', target.arch
  ]
  await retry(() => runCommand(process.execPath, verifierArgs, {}), 5_000)

  if (!shouldRunPackagedProbe(target, host)) {
    log(`afterPack: static closure verified for ${target.platform}-${target.arch}; packaged Host probe skipped because runner is ${host.platform}-${host.arch}.`)
    return
  }

  const probeData = await mkdtemp(path.join(tmpdir(), 'dsh-packaged-probe-'))
  try {
    const executable = packagedExecutable(context)
    const output = await runCommand(executable, [
      '--headless',
      '--no-sandbox',
      `--user-data-dir=${path.join(probeData, 'User Data')}`
    ], { DSH_PACKAGED_HOST_PROBE: '1' }, 60_000)
    if (!output.includes('"probe":"packaged-host-ready"')) {
      throw new Error(`packaged Host probe did not report readiness:\n${output}`)
    }
  } finally {
    await rm(probeData, { recursive: true, force: true })
  }
}

async function ensureExecutableModes(root, target) {
  if (target.platform === 'win32') return
  for (const asset of requiredRuntimeAssets(target).filter(asset => asset.executable)) {
    try { await chmod(path.join(root, asset.path), 0o755) } catch { /* verifier reports missing assets */ }
  }
}

async function waitForPath(target, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try { await access(target); return } catch {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for packaged resources: ${target}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

async function retry(operation, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try { return await operation() } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

function packagedExecutable(context) {
  const executableName = context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'darwin') {
    return path.join(context.appOutDir, `${executableName}.app`, 'Contents', 'MacOS', 'deepseek-harness-desktop')
  }
  if (context.electronPlatformName === 'win32') return path.join(context.appOutDir, 'deepseek-harness-desktop.exe')
  return path.join(context.appOutDir, 'deepseek-harness-desktop')
}

export function runCommandWithTimeout(command, args, extraEnv, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    let output = ''
    let timedOut = false
    let exited = false
    let exitCode = null
    let exitSignal = null
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const exitPromise = new Promise(exitResolve => child.once('exit', (code, signal) => {
      exited = true
      exitCode = code
      exitSignal = signal
      exitResolve()
    }))
    const timeout = setTimeout(async () => {
      timedOut = true
      try {
        await terminateProcessTree(child, exitPromise, () => exited)
        reject(new Error(`timed out after ${timeoutMs} ms and terminated process tree: ${command}\n${output}`))
      } catch (error) {
        reject(new Error(`timed out after ${timeoutMs} ms; process tree termination failed: ${command}: ${error instanceof Error ? error.message : String(error)}\n${output}`))
      }
    }, timeoutMs)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    void exitPromise.then(() => {
      clearTimeout(timeout)
      if (timedOut) return
      if (exitCode === 0) resolve(output)
      else reject(new Error(`${command} exited with ${exitCode ?? exitSignal}:\n${output}`))
    })
  })
}

async function terminateProcessTree(child, exitPromise, hasExited) {
  if (hasExited() || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      await runTerminationCommand('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { timeoutMs: 2_000 })
    } catch (error) {
      if (!hasExited()) throw error
    }
    if (!await waitForExit(exitPromise, hasExited, 3_000)) throw new Error(`taskkill completed but PID ${child.pid} did not exit`)
    return
  }

  signalProcessGroup(child.pid, 'SIGTERM')
  await delay(1_000)
  const survivors = await processGroupPids(child.pid)
  if (survivors.length > 0 && !signalProcessGroup(child.pid, 'SIGKILL')) {
    for (const pid of survivors) {
      try { process.kill(pid, 'SIGKILL') } catch (error) {
        if (error?.code !== 'ESRCH') throw error
      }
    }
  }
  if (!await waitForProcessGroupAbsent(child.pid, 3_000)) {
    throw new Error(`process group ${child.pid} still exists after SIGKILL`)
  }
  if (!hasExited() && !await waitForExit(exitPromise, hasExited, 500)) {
    throw new Error(`leader PID ${child.pid} did not report exit after its process group disappeared`)
  }
}

function signalProcessGroup(pid, signal) {
  try { process.kill(-pid, signal); return true } catch (error) {
    if (error?.code === 'EPERM') return false
    if (error?.code !== 'ESRCH') throw error
    return true
  }
}

async function waitForProcessGroupAbsent(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while ((await processGroupPids(pid)).length > 0) {
    if (Date.now() >= deadline) return false
    await delay(25)
  }
  return true
}

async function processGroupPids(group) {
  const output = await captureCommand('ps', ['-eo', 'pid=,pgid='])
  return output.split(/\r?\n/).flatMap(line => {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number)
    return Number.isInteger(pid) && pgid === group ? [pid] : []
  })
}

function captureCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    let timedOut = false
    let settled = false
    child.stdout.on('data', chunk => { output += chunk })
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 500)
    const secondary = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${command} did not exit after SIGKILL`))
    }, 1_000)
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(secondary)
      reject(error)
    })
    child.once('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(secondary)
      if (timedOut) reject(new Error(`${command} timed out`))
      else if (code === 0) resolve(output)
      else reject(new Error(`${command} exited with ${code}`))
    })
  })
}

async function waitForExit(exitPromise, hasExited, timeoutMs) {
  if (hasExited()) return true
  return Promise.race([
    exitPromise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs))
  ])
}

export function runTerminationCommand(command, args, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn
  const timeoutMs = options.timeoutMs ?? 2_000
  return new Promise((resolve, reject) => {
    const terminator = spawnProcess(command, args, { windowsHide: true, stdio: 'ignore' })
    let timedOut = false
    let settled = false
    const timeout = setTimeout(() => {
      timedOut = true
      terminator.kill('SIGKILL')
    }, timeoutMs)
    const secondary = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${command} timed out and did not exit after SIGKILL`))
    }, timeoutMs + 1_000)
    terminator.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(secondary)
      reject(error)
    })
    terminator.once('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(secondary)
      if (timedOut) reject(new Error(`${command} timed out after ${timeoutMs} ms and was killed`))
      else if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code}`))
    })
  })
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
