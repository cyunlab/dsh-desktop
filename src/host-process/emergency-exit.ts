import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

/** parent IPC 消失后用于兜底终止 child 进程树的最小系统接口。 */
export interface HostProcessEmergencySystem {
  readonly platform?: NodeJS.Platform
  readonly pid?: number
  readonly spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  readonly killProcess?: (pid: number, signal?: NodeJS.Signals | number) => void
  exit(code?: number): never
}

/** 在 Harness dispose 超时后，不依赖 main 模块强制结束自身及其后代。 */
export async function emergencyExitHostProcess(system: HostProcessEmergencySystem, timeoutMs = 2_000): Promise<never> {
  const platform = system.platform ?? process.platform
  const pid = system.pid ?? process.pid
  const deadline = Date.now() + Math.max(0, timeoutMs)
  try {
    if (platform === 'win32') {
      const terminator = (system.spawnProcess ?? spawn)('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore'
      })
      try {
        await waitForExit(terminator, Math.max(0, deadline - Date.now()))
      } catch {
        if (!hasExited(terminator)) terminator.kill('SIGKILL')
      }
    } else {
      const killProcess = system.killProcess ?? process.kill
      signalProcessGroup(pid, 'SIGTERM', killProcess)
      signalProcessGroup(pid, 'SIGKILL', killProcess)
    }
  } catch {
    // 紧急路径仍必须交给 process.exit，不能因 taskkill/kill 自身失败而悬挂。
  }
  return system.exit(1)
}

/** 对当前 child 的 detached Unix process group发送信号。 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals, killProcess: (pid: number, signal?: NodeJS.Signals | number) => void): void {
  try { killProcess(-pid, signal) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
  }
}

/** 判断兜底 taskkill 进程是否已经结束。 */
function hasExited(child: ChildProcess): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined)
}

/** 在兜底截止时间内等待 taskkill 进程退出。 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return Promise.resolve()
  if (timeoutMs <= 0) return Promise.reject(new Error('Emergency process tree kill timed out'))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onExit = (): void => finish()
    const onError = (error: Error): void => finish(error)
    const timer = setTimeout(() => finish(new Error('Emergency process tree kill timed out')), timeoutMs)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}
