import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** 验证发布 tag 与一个清单版本完全一致。 */
export function verifyReleaseVersion(tag, manifestVersion) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) throw new Error(`release tag must start with v: ${tag ?? '<missing>'}`)
  const tagVersion = tag.slice(1)
  if (!SEMANTIC_VERSION.test(tagVersion)) throw new Error(`release tag is not a semantic version: ${tag}`)
  if (!SEMANTIC_VERSION.test(manifestVersion)) throw new Error(`manifest version is not a semantic version: ${manifestVersion}`)
  if (tagVersion !== manifestVersion) throw new Error(`release tag ${tag} does not exactly match manifest version ${manifestVersion}`)
  return tagVersion
}

/** 从 Cargo TOML 文本读取指定 package 的版本。 */
export function readCargoPackageVersion(contents, packageName) {
  const blocks = contents.split(/(?=^\[\[?package\]?\]\s*$)/m)
  const block = blocks.find(candidate => new RegExp(`^name\\s*=\\s*"${packageName}"\\s*$`, 'm').test(candidate))
  const version = block?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1]
  if (!version) throw new Error(`could not find ${packageName} version in Cargo manifest`)
  return version
}

/** 读取 Desktop 的全部权威及派生版本字段。 */
export async function readDesktopVersions(root = '.') {
  const [packageJson, tauriJson, cargoToml, cargoLock] = await Promise.all([
    readFile(`${root}/package.json`, 'utf8'),
    readFile(`${root}/src-tauri/tauri.conf.json`, 'utf8'),
    readFile(`${root}/src-tauri/Cargo.toml`, 'utf8'),
    readFile(`${root}/src-tauri/Cargo.lock`, 'utf8')
  ])
  return {
    'package.json': JSON.parse(packageJson).version,
    'src-tauri/tauri.conf.json': JSON.parse(tauriJson).version,
    'src-tauri/Cargo.toml': readCargoPackageVersion(cargoToml, 'deepseek-harness-desktop'),
    'src-tauri/Cargo.lock': readCargoPackageVersion(cargoLock, 'deepseek-harness-desktop')
  }
}

/** 验证所有 Desktop 版本字段与 tag 完全一致。 */
export function verifyDesktopVersions(tag, versions) {
  for (const [file, version] of Object.entries(versions)) {
    try { verifyReleaseVersion(tag, version) } catch (error) { throw new Error(`${file}: ${error.message}`) }
  }
  return tag.slice(1)
}

/** 从命令行读取发布 tag 与全部清单并执行校验。 */
async function main() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME
  const versions = await readDesktopVersions(process.argv[3] ?? '.')
  const version = verifyDesktopVersions(tag, versions)
  console.log(`release version verified across ${Object.keys(versions).length} manifests: v${version}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
