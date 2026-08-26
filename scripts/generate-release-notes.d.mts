export function escapeMarkdown(text: string): string
export function formatChanges(subjects: string[], tag: string): string
export function renderReleaseNotes(tag: string, subjects: string[]): string
export function readReleaseSubjects(tag: string, runGit?: (args: string[]) => string): string[]
