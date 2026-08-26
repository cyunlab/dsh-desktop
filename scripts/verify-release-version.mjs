import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** 验证发布 tag 与 package.json 的语义版本完全一致。 */
export function verifyReleaseVersion(tag, packageVersion) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) {
    throw new Error(`release tag must start with v: ${tag ?? '<missing>'}`)
  }
  const tagVersion = tag.slice(1)
  if (!SEMANTIC_VERSION.test(tagVersion)) {
    throw new Error(`release tag is not a semantic version: ${tag}`)
  }
  if (!SEMANTIC_VERSION.test(packageVersion)) {
    throw new Error(`package.json version is not a semantic version: ${packageVersion}`)
  }
  if (tagVersion !== packageVersion) {
    throw new Error(`release tag ${tag} does not exactly match package.json version ${packageVersion}`)
  }
  return tagVersion
}

/** 从命令行读取发布 tag 与清单并执行版本校验。 */
async function main() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME
  const manifestPath = process.argv[3] ?? 'package.json'
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const version = verifyReleaseVersion(tag, manifest.version)
  console.log(`release version verified: v${version}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
