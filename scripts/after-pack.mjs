import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export default async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources')
  const unpacked = path.join(resources, 'app.asar.unpacked')
  await run(process.execPath, [
    path.resolve('scripts/verify-runtime-closure.mjs'),
    '--app-dir', unpacked,
    '--manifest', path.resolve('package.json')
  ], { DSH_CLOSURE_TARGET_PLATFORM: context.electronPlatformName })

  const probeData = await mkdtemp(path.join(tmpdir(), 'dsh-packaged-probe-'))
  try {
    const executable = packagedExecutable(context)
    const output = await run(executable, [
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
