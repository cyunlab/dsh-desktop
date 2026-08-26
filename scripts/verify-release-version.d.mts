export const SEMANTIC_VERSION: RegExp
export function verifyReleaseVersion(tag: string | undefined, manifestVersion: string): string
export function readCargoPackageVersion(contents: string, packageName: string): string
export function readDesktopVersions(root?: string): Promise<Record<string, string>>
export function verifyDesktopVersions(tag: string, versions: Record<string, string>): string
