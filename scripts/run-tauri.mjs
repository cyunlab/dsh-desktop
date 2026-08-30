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

/** 验证并规范化正式发布使用的 minisign 公钥文本。 */
function normalizeUpdaterPublicKey(value) {
  const normalized = value.trim()
  let decoded
  try { decoded = Buffer.from(normalized, 'base64').toString('utf8').replaceAll('\r\n', '\n').trim() } catch { decoded = '' }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
    || !/^untrusted comment: minisign public key: [0-9A-F]+\nRW[A-Za-z0-9+/=]+$/.test(decoded)) {
    throw new Error('DSH_UPDATER_PUBLIC_KEY must contain the base64-encoded two-line minisign public key file')
  }
  return normalized
}

/** 为正式 build 合并 updater 公钥，使运行时与 Tauri bundler 使用同一信任根。 */
export function buildTauriArguments(command, args, environment) {
  const cliArguments = [command]
  if (command === 'build' && environment.DSH_UPDATER_PUBLIC_KEY) {
    const pubkey = normalizeUpdaterPublicKey(environment.DSH_UPDATER_PUBLIC_KEY)
    cliArguments.push('--config', JSON.stringify({ plugins: { updater: { pubkey } } }))
  }
  const normalizedArguments = args[0] === '--' ? args.slice(1) : args
  return [...cliArguments, ...normalizedArguments]
}

/** 使用 pnpm 启动 Tauri，并继承终端输入输出与退出码。 */
function run() {
  const [command, ...args] = process.argv.slice(2)
  if (!command) throw new Error('Tauri command is required')
  const pnpmEntry = process.env.npm_execpath
  if (!pnpmEntry) throw new Error('Tauri launcher must be run from a pnpm script')
  const child = spawn(process.execPath, [pnpmEntry, 'exec', 'tauri', ...buildTauriArguments(command, args, process.env)], {
    cwd: process.cwd(),
    env: withCargoPath(process.env),
    stdio: 'inherit'
  })
  child.once('error', error => { throw error })
  child.once('exit', code => { process.exitCode = code ?? 1 })
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) run()
