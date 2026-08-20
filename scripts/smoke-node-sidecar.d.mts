import type { ChildProcess } from 'node:child_process'

/** 等待子进程确认退出。 */
export function waitForChildExit(child: ChildProcess, timeoutMilliseconds?: number): Promise<void>

/** 强制终止子进程树并等待退出。 */
export function terminateProcessTree(child: ChildProcess, timeoutMilliseconds?: number): Promise<void>

/** 等待 Harness listener 停止接受连接。 */
export function waitForListenerClosed(origin: string, timeoutMilliseconds?: number): Promise<void>
