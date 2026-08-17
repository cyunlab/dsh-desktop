import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export async function reconcileDraftRelease(options, dependencies = {}) {
  const runGh = dependencies.runGh ?? runGhCommand
  const { repository, tag, title, notesFile, artifacts } = options
  if (!repository) throw new Error('GITHUB_REPOSITORY is required')
  if (!tag || !notesFile || artifacts.length === 0) throw new Error('tag, notes file, and at least one artifact are required')

  const lookup = await runGh(['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, '--jq', '.draft'])
  if (lookup.exitCode === 0) {
    if (lookup.stdout.trim() !== 'true') {
      throw new Error(`refusing to modify published release ${tag}`)
    }
    await requireSuccess(runGh(['release', 'edit', tag, '--repo', repository, '--draft', '--title', title, '--notes-file', notesFile]))
    await requireSuccess(runGh(['release', 'upload', tag, ...artifacts, '--repo', repository, '--clobber']))
    return 'updated'
  }

  if (!/HTTP 404\b/.test(lookup.stderr)) {
    throw new Error(`could not inspect release ${tag}: ${lookup.stderr.trim() || `gh exited ${lookup.exitCode}`}`)
  }
  await requireSuccess(runGh([
    'release', 'create', tag, ...artifacts, '--repo', repository, '--draft', '--verify-tag',
    '--title', title, '--notes-file', notesFile
  ]))
  return 'created'
}

async function requireSuccess(resultPromise) {
  const result = await resultPromise
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `gh exited ${result.exitCode}`)
}

export function runGhCommand(args) {
  return new Promise(resolve => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => resolve({ exitCode: -1, stdout, stderr: error.message }))
    child.once('exit', code => resolve({ exitCode: code ?? -1, stdout, stderr }))
  })
}

async function main() {
  const [tag, notesFile, ...artifacts] = process.argv.slice(2)
  const result = await reconcileDraftRelease({
    repository: process.env.GITHUB_REPOSITORY,
    tag,
    title: `DeepSeek Harness Desktop ${tag}`,
    notesFile,
    artifacts
  })
  console.log(`draft release ${tag} ${result}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
