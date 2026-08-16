export function assertSupportedNodeVersion(version: string): void {
  const match = /^(\d+)\./.exec(version)
  if (!match || Number(match[1]) !== 24) {
    throw new Error(`DeepSeek Harness Desktop requires Node 24; found ${version}`)
  }
}
