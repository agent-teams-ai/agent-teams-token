export function trustedChildInvocation(
  command: string,
  arguments_: readonly string[],
  source: Record<string, string>,
  options: { workingDirectory: string },
): { arguments: string[]; environment: Record<string, string> };
