import { describe, expect, it } from 'vitest'
import { formatChanges, readReleaseSubjects, renderReleaseNotes } from '../../scripts/generate-release-notes.mjs'

describe('release notes generation', () => {
  it('excludes the release commit and escapes Markdown', () => {
    expect(formatChanges(['chore: release v1.2.0', 'fix: preserve [paths]', 'feat: use *native* shell'], 'v1.2.0')).toBe(
      '- fix: preserve \\[paths\\]\n- feat: use \\*native\\* shell'
    )
  })

  it('uses a stable fallback when no subjects remain', () => {
    expect(formatChanges(['chore: release v1.2.0'], 'v1.2.0')).toBe('- No user-facing changes recorded.')
  })

  it('keeps installation guidance with changes', () => {
    const notes = renderReleaseNotes('v1.2.0', ['feat: ship release gate'])
    expect(notes).toContain('feat: ship release gate')
    expect(notes).toContain('SmartScreen')
    expect(notes).toContain('Gatekeeper')
    expect(notes).toContain('chmod +x')
  })

  it('uses the nearest reachable tag and first-parent history', () => {
    const calls: string[][] = []
    const subjects = readReleaseSubjects('v1.2.0', args => {
      calls.push(args)
      return args[0] === 'describe' ? 'v1.1.0' : 'chore: release v1.2.0\nfeat: next'
    })
    expect(calls).toEqual([
      ['describe', '--tags', '--abbrev=0', 'v1.2.0^'],
      ['log', '--first-parent', '--pretty=%s', 'v1.1.0..v1.2.0']
    ])
    expect(subjects).toEqual(['chore: release v1.2.0', 'feat: next'])
  })
})
