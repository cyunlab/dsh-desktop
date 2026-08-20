/** 验证发布 tag 与 package.json 的语义版本完全一致。 */
export function verifyReleaseVersion(tag: string | undefined, packageVersion: string): string
