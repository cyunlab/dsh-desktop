import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** 转义 commit subject 中会改变 Markdown 结构的字符。 */
export function escapeMarkdown(text) {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1')
}

/** 从第一父链提交标题生成 Changes 列表。 */
export function formatChanges(subjects, tag) {
  const changes = subjects.filter(subject => subject && subject !== `chore: release ${tag}`)
  return changes.length ? changes.map(subject => `- ${escapeMarkdown(subject)}`).join('\n') : '- No user-facing changes recorded.'
}

/** 生成包含提交摘要和平台安装说明的发布说明。 */
export function renderReleaseNotes(tag, subjects) {
  return `## Changes\n\n${formatChanges(subjects, tag)}\n\n## Installation\n\n` +
    `Verify the downloaded filename and source before installing. Platform security prompts depend on the signing and notarization configuration used for this build.\n\n` +
    `- **Windows (x64, NSIS):** Microsoft Defender SmartScreen may warn that the publisher is unknown. Choose **More info**, verify the downloaded filename, then choose **Run anyway** only if you trust this repository and build.\n` +
    `- **macOS (Apple silicon arm64 or Intel x64, DMG):** Gatekeeper may block an unnotarized app. After verifying the downloaded filename, control-click the app in Finder, choose **Open**, then confirm **Open** only if you trust this repository and build.\n` +
    `- **Linux (x64, AppImage):** make the file executable with \`chmod +x <filename>.AppImage\`, then launch it directly.\n\n` +
    `Publishing this draft is an explicit maintainer action. This workflow never publishes a release automatically.\n`
}

/** 读取当前 tag 第一父链上自最近可达 tag 以来的提交标题。 */
export function readReleaseSubjects(tag, runGit = args => execFileSync('git', args, { encoding: 'utf8' }).trim()) {
  let previous = ''
  try { previous = runGit(['describe', '--tags', '--abbrev=0', `${tag}^`]) } catch {}
  const output = runGit(['log', '--first-parent', '--pretty=%s', previous ? `${previous}..${tag}` : tag])
  return output ? output.split('\n') : []
}

/** 从命令行生成发布说明文件。 */
async function main() {
  const [tag, output = 'release-notes.md'] = process.argv.slice(2)
  if (!tag) throw new Error('release tag is required')
  await writeFile(output, renderReleaseNotes(tag, readReleaseSubjects(tag)), 'utf8')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
