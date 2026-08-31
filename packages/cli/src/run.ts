/**
 * Command dispatch — the testable half of the `codeflow` binary.
 *
 * `run()` never calls `process.exit`; it returns the exit code and writes through
 * an injected IO surface, so the whole CLI can be exercised from a unit test.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodeFlowError } from "@codeflow-team/core";
import { flagBoolean, flagString, parseArgs } from "./args.js";
import { check, checkToJson, formatCheck } from "./commands/check.js";
import { generate } from "./commands/generate.js";
import { init } from "./commands/init.js";
import { CliError } from "./errors.js";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const defaultIo: Io = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

export const USAGE = `codeflow — CodeFlow workspace CLI

Usage
  codeflow generate [--agent-md] [--cwd <dir>]
      Regenerate generated/tools.d.ts and generated/lib.d.ts from
      codeflow.config.ts plus the function library in lib/, and seed
      prompts/flow-style.md when it is missing.
      --agent-md also prints the CLAUDE.md / AGENTS.md section that points an
      agent at those files.

  codeflow check [--json] [--cwd <dir>]
      Analyze every flow in flows/ against the current registry and report
      workspace-wide diagnostics, flag generated/*.d.ts that no longer match
      the registry, and print which flow uses which library function.
      Exits 1 on any error diagnostic or stale artifact.
      --json prints the same result machine-readably for CI.

  codeflow init [dir] [--force]
      Scaffold the standard workspace layout: codeflow.config.ts, flows/, lib/,
      tsconfig.json with the @flows/lib path mapping.

Options
  --cwd, -C <dir>   Run as if from <dir> (default: the current directory)
  --json            Machine-readable output (check only)
  --force, -f       Overwrite existing files (init only)
  --help, -h        Show this help
  --version, -v     Show the version`;

async function version(): Promise<string> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(await readFile(path.join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function reportGenerate(io: Io, result: Awaited<ReturnType<typeof generate>>): void {
  io.out(`codeflow generate — ${path.relative(process.cwd(), result.workspace.configPath) || result.workspace.configPath}`);
  io.out(
    `  registry: ${result.toolCount} tool(s), ${result.libraryFunctions.length} library function(s)  [registryHash ${result.registryHash.slice(0, 12)}]`,
  );
  for (const file of result.files) {
    io.out(`  ${file.changed ? "write" : "  ok "} ${file.relativePath}`);
  }
  if (result.agentMd !== undefined) {
    io.out("");
    io.out(result.agentMd);
  }
}

export async function run(argv: readonly string[], io: Io = defaultIo): Promise<number> {
  const args = parseArgs(argv);
  const cwd = flagString(args, "cwd");

  if (flagBoolean(args, "version") && args.command === undefined) {
    io.out(await version());
    return 0;
  }
  if (args.command === undefined || args.command === "help" || flagBoolean(args, "help")) {
    io.out(USAGE);
    return args.command === undefined && !flagBoolean(args, "help") ? 2 : 0;
  }

  try {
    switch (args.command) {
      case "generate": {
        const options = {
          agentMd: flagBoolean(args, "agent-md"),
          ...(cwd === undefined ? {} : { cwd }),
        };
        reportGenerate(io, await generate(options));
        return 0;
      }
      case "init": {
        const target = args.positionals[0] ?? cwd;
        const result = await init({
          ...(target === undefined ? {} : { cwd: target }),
          force: flagBoolean(args, "force"),
        });
        io.out(`codeflow init — ${result.root}`);
        for (const file of result.files) io.out(`  write ${file}`);
        io.out("");
        io.out("Next: codeflow generate");
        return 0;
      }
      case "check": {
        const result = await check(cwd === undefined ? {} : { cwd });
        if (flagBoolean(args, "json")) {
          io.out(JSON.stringify(checkToJson(result), null, 2));
        } else {
          for (const line of formatCheck(result)) io.out(line);
        }
        // Diagnostics are not CLI failures — the command ran fine and found
        // something. Exit 1 anyway: CI must not treat "flows are broken" as ok.
        return result.ok ? 0 : 1;
      }
      default:
        io.err(`codeflow: unknown command "${args.command}"\n`);
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof CliError || error instanceof CodeFlowError) {
      io.err(`codeflow: ${error.message}`);
      return 1;
    }
    io.err(`codeflow: ${(error as Error).stack ?? String(error)}`);
    return 1;
  }
}
