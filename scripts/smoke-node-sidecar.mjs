import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getNodeTarget } from './ensure-node-sidecar.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 从命令行读取可选的资源根目录和 sidecar 入口。 */
function readOptions(argumentsList) {
  const options = {
    resourceRoot: path.join(root, 'resources'),
    sidecar: path.join(root, 'dist', 'sidecar', 'index.js')
  }
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--resource-root') options.resourceRoot = path.resolve(argumentsList[++index] ?? '')
    else if (argument === '--sidecar') options.sidecar = path.resolve(argumentsList[++index] ?? '')
    else throw new Error(`Unknown smoke option: ${argument}`)
  }
  return options
}

/** 在限定时间内等待 sidecar 生命周期消息或进程错误。 */
function waitForReady(child, lines, timeoutMilliseconds = 60_000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finishReject(new Error(`Node sidecar did not become ready within ${timeoutMilliseconds}ms`)), timeoutMilliseconds)
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
      console.log(`[sidecar] ${line}`)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.type === 'ready') finishResolve(message)
      if (message.type === 'startup-failed') finishReject(new Error(`Harness startup failed: ${message.error?.message ?? 'unknown error'}`))
    })
    child.once('error', finishReject)
    child.once('exit', code => {
      if (!settled) finishReject(new Error(`Node sidecar exited before ready with code ${code ?? 'unknown'}`))
    })
  })
}

/** 等待 sidecar 发出 stopped 消息并退出，防止 smoke 留下 Harness 进程。 */
function stopSidecar(child, lines, timeoutMilliseconds = 15_000) {
  return new Promise((resolve, reject) => {
    let stopped = false
    let exited = false
    let settled = false
    const timer = setTimeout(() => finishReject(new Error(`Node sidecar did not stop within ${timeoutMilliseconds}ms`)), timeoutMilliseconds)
    const finishResolve = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const finishReject = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const maybeResolve = () => {
      if (stopped && exited) finishResolve()
    }
    lines.on('line', line => {
      console.log(`[sidecar] ${line}`)
      try {
        if (JSON.parse(line).type === 'stopped') stopped = true
      } catch {}
      maybeResolve()
    })
    child.once('error', finishReject)
    child.once('exit', code => {
      exited = true
      if (code !== 0 && code !== null) finishReject(new Error(`Node sidecar exited while stopping with code ${code}`))
      else maybeResolve()
    })
  })
}

/** 终止仍未退出的 sidecar，兼容 Windows 和 POSIX 的子进程 API。 */
function forceTerminate(child) {
  if (!child.killed) child.kill()
}

/** 用随项目下载的官方 Node 启动真实 Harness，并验证 loopback Web 响应。 */
async function runSmoke(options) {
  const target = getNodeTarget(platform(), arch())
  const nodePath = path.join(options.resourceRoot, 'node', target.resourceName, target.relativeExecutable)
  const workDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-node-smoke-'))
  const environment = { ...process.env }
  delete environment.DSH_NODE_PATH
  environment.DSH_HOME = path.join(workDirectory, 'harness-home')
  const child = spawn(nodePath, [options.sidecar], {
    cwd: workDirectory,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk}`.slice(-8_000)
  })
  try {
    const ready = await waitForReady(child, lines)
    if (typeof ready.origin !== 'string') throw new Error('Node sidecar ready message did not include an origin')
    const response = await fetch(ready.origin)
    if (!response.ok) throw new Error(`Harness smoke request returned HTTP ${response.status}`)
    if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Harness smoke response was not HTML')
    child.stdin.write('{"type":"stop"}\n')
    await stopSidecar(child, lines)
    console.log(`Official Node + Harness smoke passed for ${target.resourceName}`)
  } catch (error) {
    forceTerminate(child)
    const detail = stderr.trim()
    throw new Error((error instanceof Error ? error.message : String(error)) + (detail ? '\n' + detail : ''))
  } finally {
    lines.close()
    await rm(workDirectory, { recursive: true, force: true })
  }
}

/** 直接执行 smoke 脚本并将失败交给 CI。 */
async function main() {
  await runSmoke(readOptions(process.argv.slice(2)))
}

await main()
