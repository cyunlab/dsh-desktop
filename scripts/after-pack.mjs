import { access, chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { requiredRuntimeAssets, shouldRunPackagedProbe, targetFromAfterPackContext } from './runtime-assets.mjs'

export default async function afterPack(context) {
  return runAfterPack(context)
}

export async function runAfterPack(context, dependencies = {}) {
  const runCommand = dependencies.runCommand ?? run
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

function run(command, args, extraEnv, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`timed out after ${timeoutMs} ms: ${command}`))
    }, timeoutMs)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => {
      clearTimeout(timeout)
      if (code === 0) resolve(output)
      else reject(new Error(`${command} exited with ${code}:\n${output}`))
    })
  })
}
