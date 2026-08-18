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
export async function emergencyExitHostProcess(
  system: HostProcessEmergencySystem,
  timeoutMs = 2_000,
  absoluteDeadline = Date.now() + Math.max(0, timeoutMs)
): Promise<never> {
  const platform = system.platform ?? process.platform
  const pid = system.pid
  const deadline = absoluteDeadline
  try {
    if (pid === undefined || !isSafePid(pid)) return system.exit(1)
    if (platform === 'win32') {
      const terminator = (system.spawnProcess ?? spawn)('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore'
      })
      let taskkill: EmergencyExitResult | undefined
      try {
        taskkill = await waitForExit(terminator, remaining(deadline))
      } catch {
        // 超时/启动 error 会进入同一 deadline 内的 leader fallback。
      }
      if (!taskkill || taskkill.code !== 0 || taskkill.signal !== null) {
        if (!hasExited(terminator)) terminator.kill('SIGKILL')
        try { (system.killProcess ?? process.kill)(pid, 'SIGKILL') } catch { /* exit below remains the final fallback */ }
      }
    } else {
      const killProcess = system.killProcess ?? process.kill
      // 即使 deadline 已耗尽，也必须至少尝试一次已验证的 group TERM。
      signalProcessGroup(pid, 'SIGTERM', killProcess)
      if (remaining(deadline) > 0) signalProcessGroup(pid, 'SIGKILL', killProcess)
    }
  } catch {
    // 紧急路径仍必须交给 process.exit，不能因 taskkill/kill 自身失败而悬挂。
  }
  return system.exit(1)
}

/** 对当前 child 的 detached Unix process group发送信号。 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals, killProcess: (pid: number, signal?: NodeJS.Signals | number) => void): void {
  if (!isSafePid(pid)) return
  try { killProcess(-pid, signal) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
  }
}

/** 只允许可安全传给 taskkill 或负进程组的真实 pid。 */
function isSafePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1
}

/** 判断兜底 taskkill 进程是否已经结束。 */
function hasExited(child: ChildProcess): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined)
}

/** 在兜底截止时间内等待 taskkill 进程退出。 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<EmergencyExitResult> {
  if (hasExited(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  if (timeoutMs <= 0) return Promise.reject(new Error('Emergency process tree kill timed out'))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result?: EmergencyExitResult, error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
      if (error) reject(error)
      else resolve(result ?? { code: child.exitCode, signal: child.signalCode })
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => finish({ code, signal })
    const onError = (error: Error): void => finish(undefined, error)
    const timer = setTimeout(() => finish(undefined, new Error('Emergency process tree kill timed out')), timeoutMs)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

/** 记录 taskkill 进程的退出状态，供失败 fallback 判断。 */
interface EmergencyExitResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** 计算 emergency deadline 尚余的清理预算。 */
function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}
