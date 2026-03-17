export function buildForwardedUserArgs(args: {
  toolName: string | undefined;
  userArgs: Record<string, unknown>;
  raw: boolean | undefined;
}): Record<string, unknown> {
  const forwardedUserArgs: Record<string, unknown> = { ...args.userArgs };

  if (args.toolName === "read_file") {
    delete forwardedUserArgs.bypass_cache;
  }

  if (args.toolName === "apply_edits" && args.raw !== true) {
    forwardedUserArgs.verbose = true;
  }

  return forwardedUserArgs;
}
