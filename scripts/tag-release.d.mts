export function compareSemanticVersions(left: string, right: string): number
export function updateCargoPackageVersion(contents: string, packageName: string, version: string): string
export function tagRelease(version: string): Promise<void>
