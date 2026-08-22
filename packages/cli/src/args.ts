/**
 * Minimal argv parser.
 *
 * Hand-rolled on purpose: the CLI has three commands and five flags, and a
 * dependency for that would be pure cost. Supports `--flag`, `--flag=value`,
 * `--flag value`, short aliases, `--` passthrough, and bare positionals.
 */

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string | true>;
}

/** Flags that take a value; everything else is boolean. */
const VALUE_FLAGS = new Set(["cwd", "C"]);

const ALIASES = new Map<string, string>([
  ["C", "cwd"],
  ["h", "help"],
  ["v", "version"],
  ["f", "force"],
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!argument.startsWith("-") || argument === "-") {
      positionals.push(argument);
      continue;
    }

    const withoutDashes = argument.replace(/^--?/, "");
    const equals = withoutDashes.indexOf("=");
    const rawName = equals === -1 ? withoutDashes : withoutDashes.slice(0, equals);
    const name = ALIASES.get(rawName) ?? rawName;

    if (equals !== -1) {
      flags.set(name, withoutDashes.slice(equals + 1));
      continue;
    }
    if (VALUE_FLAGS.has(rawName) || VALUE_FLAGS.has(name)) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(name, next);
        index += 1;
        continue;
      }
    }
    flags.set(name, true);
  }

  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name) && args.flags.get(name) !== "false";
}
