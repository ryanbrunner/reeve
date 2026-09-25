export interface Command {
  /** One line, for the list `reeve --help` prints. */
  summary: string;
  usage: string;
  /**
   * The exit code, or nothing for a command that keeps the process alive and
   * leaves it to end on its own, as `serve` does.
   */
  run(args: string[]): Promise<number | undefined>;
}

/** A mistake in how the command was typed: reported with its usage, not a stack. */
export class UsageError extends Error {}
