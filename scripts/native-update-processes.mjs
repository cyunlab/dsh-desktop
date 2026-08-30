import { readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

const PROCESS_ENVIRONMENT_BOUND = 1024 * 1024

/** 转义一个只会嵌入 PowerShell 单引号 literal 的已验证路径。 */
function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/** 从 ps 的 PID + command 行中只选 exact executable 及其参数。 */
export function parseDesktopProcessRows(output, executable) {
  const pids = []
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    if (match[2] === executable || match[2].startsWith(`${executable} `)) pids.push(Number(match[1]))
  }
  return [...new Set(pids)].sort((left, right) => left - right)
}

/** 判断 /proc/PID/environ 是否含 exact APPIMAGE 路径。 */
export function processEnvironmentContainsAppImage(environmentBytes, installPath) {
  if (!Buffer.isBuffer(environmentBytes) || environmentBytes.length > PROCESS_ENVIRONMENT_BOUND) return false
  return environmentBytes.toString('utf8').split('\0').includes(`APPIMAGE=${installPath}`)
}

/** 比较更新前后 canonical 安装根与主程序，Windows 使用不区分大小写语义。 */
export function sameInstallationLocation(target, baseline, updated) {
  if (target === 'linux-x86_64') return Boolean(baseline?.installPath) && baseline.installPath === updated?.installPath
  if (!baseline?.root || !baseline?.executable || !updated?.root || !updated?.executable) return false
  if (target === 'windows-x86_64') {
    return path.win32.normalize(baseline.root).toLowerCase() === path.win32.normalize(updated.root).toLowerCase()
      && path.win32.normalize(baseline.executable).toLowerCase() === path.win32.normalize(updated.executable).toLowerCase()
  }
  return baseline.root === updated.root && baseline.executable === updated.executable
}

/** 枚举 exact 安装来源当前仍在运行的全部 Desktop PID。 */
export async function findDesktopProcessIds(target, installation, environment, command) {
  if (target === 'windows-x86_64') {
    const expected = powershellLiteral(path.win32.normalize(installation.executable))
    const script = `$items=@(Get-Process | Where-Object { try { [IO.Path]::GetFullPath($_.Path) -ieq ${expected} } catch { $false } } | Select-Object -ExpandProperty Id); [Console]::Out.Write(($items -join "\`n"))`
    const output = await command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { environment })
    return [...new Set(output.split(/\r?\n/).filter(value => /^\d+$/.test(value.trim())).map(Number))].sort((left, right) => left - right)
  }
  if (target.startsWith('darwin-')) {
    const output = await command('ps', ['-axo', 'pid=,command='], { environment, outputBound: 4 * 1024 * 1024 })
    return parseDesktopProcessRows(output, installation.executable)
  }
  const pids = []
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    const [environmentBytes, executable] = await Promise.all([
      readFile(`/proc/${pid}/environ`).catch(() => null),
      realpath(`/proc/${pid}/exe`).catch(() => ''),
    ])
    if (environmentBytes && path.basename(executable).toLowerCase().includes('deepseek') && processEnvironmentContainsAppImage(environmentBytes, installation.installPath)) pids.push(pid)
  }
  return pids.sort((left, right) => left - right)
}

/** 判断平台 PID 是否仍存在，不把权限错误误判为退出。 */
export async function processExists(target, pid, environment, command) {
  if (!pid) return false
  if (target === 'windows-x86_64') {
    const script = `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [Console]::Out.Write('true') } else { [Console]::Out.Write('false') }`
    return (await command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { environment })).trim() === 'true'
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

/** 从 PID/PPID 快照求出固定根进程当时的完整后代闭包。 */
function processTreeFromRows(rows, rootPid) {
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, parentPid] of rows) {
      if (descendants.has(parentPid) && !descendants.has(pid)) {
        descendants.add(pid)
        changed = true
      }
    }
  }
  return [...descendants].sort((left, right) => left - right)
}

/** 记录 Host listener 及其当前子进程树，供正常关闭后逐 PID 验证。 */
export async function findProcessTreePids(target, rootPid, environment, command) {
  let rows
  if (target === 'windows-x86_64') {
    const script = "[Console]::Out.Write((@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress))"
    const body = await command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { environment, outputBound: 4 * 1024 * 1024 })
    const records = JSON.parse(body)
    rows = (Array.isArray(records) ? records : [records]).map(record => [Number(record.ProcessId), Number(record.ParentProcessId)])
  } else {
    const body = await command('ps', ['-axo', 'pid=,ppid='], { environment, outputBound: 4 * 1024 * 1024 })
    rows = body.split(/\r?\n/).flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
      return match ? [[Number(match[1]), Number(match[2])]] : []
    })
  }
  return processTreeFromRows(rows, rootPid)
}
