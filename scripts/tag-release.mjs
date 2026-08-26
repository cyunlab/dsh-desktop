import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { SEMANTIC_VERSION, readDesktopVersions, verifyDesktopVersions } from './verify-release-version.mjs'

const VERSION_FILES = ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']

/** 比较两个合法语义版本；返回值大于零表示 left 更新。 */
export function compareSemanticVersions(left, right) {
  const parse = version => {
    const match = version.match(SEMANTIC_VERSION)
    if (!match) throw new Error(`invalid semantic version: ${version}`)
    return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? [] }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index]
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length)
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    if (a.prerelease[index] === undefined || b.prerelease[index] === undefined) return a.prerelease.length - b.prerelease.length
    if (a.prerelease[index] === b.prerelease[index]) continue
    const aNumber = /^\d+$/.test(a.prerelease[index])
    const bNumber = /^\d+$/.test(b.prerelease[index])
    if (aNumber && bNumber) return Number(a.prerelease[index]) - Number(b.prerelease[index])
    if (aNumber !== bNumber) return aNumber ? -1 : 1
    return a.prerelease[index].localeCompare(b.prerelease[index])
  }
  return 0
}

/** 更新 JSON 清单并保留仓库的两空格格式。 */
function updateJson(contents, version) {
  const manifest = JSON.parse(contents)
  manifest.version = version
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** 更新 Cargo package 块中指定包的版本。 */
export function updateCargoPackageVersion(contents, packageName, version) {
  const blocks = contents.split(/(?=^\[\[?package\]?\]\s*$)/m)
  let updated = false
  const result = blocks.map(block => {
    if (!new RegExp(`^name\\s*=\\s*"${packageName}"\\s*$`, 'm').test(block)) return block
    updated = true
    return block.replace(/^version\s*=\s*"[^"]+"\s*$/m, `version = "${version}"`)
  }).join('')
  if (!updated) throw new Error(`could not update ${packageName} in Cargo manifest`)
  return result
}

/** 无 shell 执行 Git 命令并返回规范化输出。 */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** 创建一个原子化的版本提交和 annotated tag。 */
export async function tagRelease(version) {
  if (!SEMANTIC_VERSION.test(version)) throw new Error(`invalid semantic version: ${version}`)
  if (git(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('working tree and index must be completely clean')
  if (git(['branch', '--show-current']) !== 'main') throw new Error('release tags may only be created from main')
  let upstream
  try { upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) } catch { throw new Error('main must have an upstream') }
  const [behind, ahead] = git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`]).split(/\s+/).map(Number)
  if (behind || ahead) throw new Error(`main must match ${upstream} exactly (behind ${behind}, ahead ${ahead})`)

  const originalHead = git(['rev-parse', 'HEAD'])
  const originals = new Map(await Promise.all(VERSION_FILES.map(async file => [file, await readFile(file, 'utf8')])))
  const current = JSON.parse(originals.get('package.json')).version
  if (compareSemanticVersions(version, current) <= 0) throw new Error(`release version ${version} must be greater than ${current}`)
  const tag = `v${version}`
  try { git(['rev-parse', '--verify', `refs/tags/${tag}`]); throw new Error(`tag ${tag} already exists`) } catch (error) {
    if (error.message === `tag ${tag} already exists`) throw error
  }

  let tagged = false
  try {
    await writeFile('package.json', updateJson(originals.get('package.json'), version))
    await writeFile('src-tauri/tauri.conf.json', updateJson(originals.get('src-tauri/tauri.conf.json'), version))
    await writeFile('src-tauri/Cargo.toml', updateCargoPackageVersion(originals.get('src-tauri/Cargo.toml'), 'deepseek-harness-desktop', version))
    await writeFile('src-tauri/Cargo.lock', updateCargoPackageVersion(originals.get('src-tauri/Cargo.lock'), 'deepseek-harness-desktop', version))
    verifyDesktopVersions(tag, await readDesktopVersions())
    git(['add', ...VERSION_FILES])
    git(['commit', '-m', `chore: release ${tag}`])
    git(['tag', '-a', tag, '-m', `DeepSeek Harness Desktop ${tag}`])
    tagged = true
    console.log(`Created ${tag}. Review it, then publish with:\n  git push origin HEAD ${tag}`)
  } catch (error) {
    if (tagged) git(['tag', '-d', tag])
    git(['reset', '--mixed', originalHead])
    await Promise.all([...originals].map(([file, contents]) => writeFile(file, contents)))
    throw error
  }
}

/** 从命令行创建发布提交和 tag。 */
async function main() {
  const [version] = process.argv.slice(2)
  if (!version) throw new Error('usage: pnpm release:tag <version>')
  await tagRelease(version)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
