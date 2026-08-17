import { describe, expect, it, vi } from 'vitest'
import { reconcileDraftRelease, type GhResult } from '../../scripts/reconcile-draft-release.mjs'

const options = {
  repository: 'owner/repo',
  tag: 'v1.2.3+build.4',
  title: 'Desktop v1.2.3+build.4',
  notesFile: 'notes.md',
  artifacts: ['one.dmg', 'two.exe']
}
const success = (stdout = ''): GhResult => ({ exitCode: 0, stdout, stderr: '' })

describe('draft release reconciliation', () => {
  it('creates a missing release as a draft', async () => {
    const runGh = vi.fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' })
      .mockResolvedValueOnce(success())
    await expect(reconcileDraftRelease(options, { runGh })).resolves.toBe('created')
    expect(runGh.mock.calls[1][0]).toEqual(expect.arrayContaining(['release', 'create', options.tag, '--draft', '--verify-tag']))
  })

  it('updates an existing draft and replaces its artifacts', async () => {
    const runGh = vi.fn()
      .mockResolvedValueOnce(success('true\n'))
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success())
    await expect(reconcileDraftRelease(options, { runGh })).resolves.toBe('updated')
    expect(runGh.mock.calls[1][0]).toEqual(expect.arrayContaining(['release', 'edit', options.tag, '--draft']))
    expect(runGh.mock.calls[2][0]).toEqual(['release', 'upload', options.tag, ...options.artifacts, '--repo', options.repository, '--clobber'])
  })

  it('refuses to mutate a published release', async () => {
    const runGh = vi.fn().mockResolvedValue(success('false\n'))
    await expect(reconcileDraftRelease(options, { runGh })).rejects.toThrow(/refusing to modify published/)
    expect(runGh).toHaveBeenCalledTimes(1)
  })

  it('does not treat API failures as a missing release', async () => {
    const runGh = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'HTTP 500' })
    await expect(reconcileDraftRelease(options, { runGh })).rejects.toThrow(/could not inspect/)
    expect(runGh).toHaveBeenCalledTimes(1)
  })
})
