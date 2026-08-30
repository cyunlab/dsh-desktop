export function buildTauriArguments(
  command: string,
  args: string[],
  environment: Readonly<Record<string, string | undefined>>
): string[]
