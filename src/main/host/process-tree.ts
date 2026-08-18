import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

/** 可替换的进程树清理依赖，便于在不触发真实 taskkill 的情况下测试。 */
export interface ProcessTreeTerminationOptions {
  readonly platform?: NodeJS.Platform
  readonly spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  readonly killProcess?: (pid: number, signal?: NodeJS.Signals | number) => void
  readonly useProcessGroup?: boolean
}

/** 在不依赖 shell 的情况下终止 Host 及其后代进程。 */
export async function terminateChildProcess(
  child: ChildProcess,
  timeoutMs = 2_000,
  options: ProcessTreeTerminationOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform
  const pid = child.pid
  const killProcess = options.killProcess ?? process.kill
  const useProcessGroup = options.useProcessGroup ?? platform !== 'win32'
  // Unix 的 leader 退出后进程组可能仍有插件后代，仍需检查并清理该组。
  if (hasExited(child) && (platform === 'win32' || !useProcessGroup)) return
  if (pid === undefined) {
    if (hasExited(child)) return
    await terminateLeader(child, timeoutMs)
    return
  }

  if (platform === 'win32') {
    await terminateWindowsTree(child, pid, timeoutMs, options.spawnProcess ?? spawn)
    return
  }

  const signalledGroup = useProcessGroup && signalProcessGroup(pid, 'SIGTERM', killProcess)
  if (!signalledGroup) child.kill('SIGTERM')
  const leaderExited = await waitForExit(child, timeoutMs)
  const groupGone = !useProcessGroup || await waitForProcessGroupGone(pid, timeoutMs, killProcess)
  if (leaderExited && groupGone) return

  const killedGroup = useProcessGroup && signalProcessGroup(pid, 'SIGKILL', killProcess)
  if (!killedGroup || !leaderExited) child.kill('SIGKILL')
  const finalLeaderExited = await waitForExit(child, timeoutMs)
  const finalGroupGone = !useProcessGroup || await waitForProcessGroupGone(pid, timeoutMs, killProcess)
  if (!finalLeaderExited || !finalGroupGone) throw new Error(`Host process tree ${pid} did not exit after termination`)
}

/** 终止 Windows child 进程树，参数始终作为 argv 传给 taskkill。 */
async function terminateWindowsTree(
  child: ChildProcess,
  pid: number,
  timeoutMs: number,
  spawnProcess: (command: string, args: string[], options: SpawnOptions) => ChildProcess
): Promise<void> {
  const terminator = spawnProcess('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore'
  })
  try {
    await waitForChildExit(terminator, timeoutMs)
  } catch {
    if (!hasExited(child)) child.kill('SIGKILL')
  }
  if (await waitForExit(child, timeoutMs)) return
  child.kill('SIGKILL')
  if (!await waitForExit(child, timeoutMs)) throw new Error(`Host process ${pid} did not exit after taskkill`)
}

/** 在没有可用 PID 时只清理 leader。 */
async function terminateLeader(child: ChildProcess, timeoutMs: number): Promise<void> {
  child.kill('SIGTERM')
  if (await waitForExit(child, timeoutMs)) return
  child.kill('SIGKILL')
  if (!await waitForExit(child, timeoutMs)) throw new Error('Host child did not exit after termination')
}

/** 对 detached Unix child process group 发送信号。 */
function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => void
): boolean {
  try {
    killProcess(-pid, signal)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return false
    if (code === 'ESRCH') return true
    throw error
  }
}

/** 判断进程组是否仍然存在，避免留下忽略 TERM 的插件后代。 */
async function waitForProcessGroupGone(
  pid: number,
  timeoutMs: number,
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => void
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      killProcess(-pid, 0)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return true
      if (code !== 'EPERM') throw error
    }
    if (Date.now() >= deadline) return false
    await delay(Math.min(25, Math.max(1, deadline - Date.now())))
  }
}

/** 判断 ChildProcess 是否已经结束。 */
function hasExited(child: ChildProcess): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined)
}

/** 在有限时间内等待 ChildProcess 退出并移除临时 listener。 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.off('exit', onExit)
      resolve(value)
    }
    const onExit = (): void => finish(true)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

/** 等待 taskkill 自身退出，拒绝时由调用方回退到 leader kill。 */
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.off('exit', onExit)
      child.off('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onExit = (): void => finish()
    const onError = (error: Error): void => finish(error)
    const timeout = setTimeout(() => finish(new Error('process tree terminator timed out')), timeoutMs)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

/** 等待一个短暂的进程组轮询间隔。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
