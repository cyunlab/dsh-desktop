import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 为 Tauri CLI 补充 Rustup 的默认 cargo 目录，避免新终端尚未刷新 PATH 时启动失败。 */
function withCargoPath(environment) {
  const cargoBin = path.join(homedir(), '.cargo', 'bin')
  const executable = path.join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo')
  if (existsSync(executable) && !environment.PATH?.split(path.delimiter).includes(cargoBin)) {
    return { ...environment, PATH: `${cargoBin}${path.delimiter}${environment.PATH ?? ''}` }
  }
  return environment
}

/** 使用 pnpm 启动 Tauri，并继承终端输入输出与退出码。 */
function run() {
  const [command, ...args] = process.argv.slice(2)
  if (!command) throw new Error('Tauri command is required')
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const child = spawn(pnpm, ['exec', 'tauri', command, ...args], {
    cwd: process.cwd(),
    env: withCargoPath(process.env),
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  child.once('error', error => { throw error })
  child.once('exit', code => { process.exitCode = code ?? 1 })
}

run()
