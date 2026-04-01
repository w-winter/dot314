export function buildForwardedUserArgs(args: {
  toolName: string | undefined;
  userArgs: Record<string, unknown>;
}): Record<string, unknown> {
  const forwardedUserArgs: Record<string, unknown> = { ...args.userArgs };

  if (args.toolName === "read_file") {
    delete forwardedUserArgs.bypass_cache;
  }

  if (args.toolName === "apply_edits") {
    forwardedUserArgs.verbose = true;
  }

  return forwardedUserArgs;
}
