import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

/** 为 Tauri CLI 补充 Rustup 的默认 cargo 目录，避免新终端尚未刷新 PATH 时启动失败。 */
function withCargoPath(environment) {
  const cargoBin = path.join(homedir(), '.cargo', 'bin')
  const executable = path.join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo')
  if (existsSync(executable) && !environment.PATH?.split(path.delimiter).includes(cargoBin)) {
    return { ...environment, PATH: `${cargoBin}${path.delimiter}${environment.PATH ?? ''}` }
  }
  return environment
}

/** 在 macOS 打包前强制要求可生成新式 Assets.car 的 Xcode 26 actool。 */
function assertMacOSIconToolchain(command) {
  if (process.platform !== 'darwin' || command !== 'build') return
  let output = ''
  try {
    output = execFileSync('xcrun', ['actool', '--version', '--output-format=human-readable-text'], { encoding: 'utf8' })
  } catch {
    throw new Error('macOS packaging requires full Xcode 26 or newer so the Icon Composer source can be compiled into Assets.car')
  }
  const version = output.match(/short-bundle-version:\s*(\d+)/)?.[1]
  if (!version || Number(version) < 26) {
    throw new Error(`macOS packaging requires actool 26 or newer; received: ${output.trim() || 'unknown version'}`)
  }
}

/** 使用 pnpm 启动 Tauri，并继承终端输入输出与退出码。 */
function run() {
  const [command, ...args] = process.argv.slice(2)
  if (!command) throw new Error('Tauri command is required')
  assertMacOSIconToolchain(command)
  const pnpmEntry = process.env.npm_execpath
  if (!pnpmEntry) throw new Error('Tauri launcher must be run from a pnpm script')
  const child = spawn(process.execPath, [pnpmEntry, 'exec', 'tauri', command, ...args], {
    cwd: process.cwd(),
    env: withCargoPath(process.env),
    stdio: 'inherit'
  })
  child.once('error', error => { throw error })
  child.once('exit', code => { process.exitCode = code ?? 1 })
}

run()
