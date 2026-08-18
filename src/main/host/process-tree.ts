import type { ChildProcess } from 'node:child_process'

/** 在不依赖 shell 的情况下可靠终止一个 Host child。 */
export async function terminateChildProcess(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  if (hasExited(child)) return
  child.kill('SIGTERM')
  if (await waitForExit(child, timeoutMs)) return
  child.kill('SIGKILL')
  if (!await waitForExit(child, timeoutMs)) throw new Error('Host child did not exit after termination')
}

/** 判断 ChildProcess 是否已经结束。 */
function hasExited(child: ChildProcess): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined)
}

/** 在有限时间内等待 ChildProcess 退出。 */
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
