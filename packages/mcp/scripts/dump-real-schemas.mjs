#!/usr/bin/env node
/**
 * Dump REAL `tools/list` payloads from real MCP servers into
 * `test/real-schemas/<server>.json`, so the adapter + codegen can be tested
 * against schemas nobody on this side wrote.
 *
 * Every server here runs over stdio via `npx -y`, needs no OAuth, and (where it
 * touches the filesystem) is pointed at a throwaway scratch directory — never
 * at $HOME.
 *
 *   node packages/mcp/scripts/dump-real-schemas.mjs [name…]
 *
 * A server that fails to start, times out, or answers nothing is recorded in
 * `_report.json` with the reason and skipped; it never blocks the rest.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "test", "real-schemas");
const SCRATCH = join(tmpdir(), "codeflow-mcp-scratch");
const TIMEOUT_MS = 60_000;

/** @type {{ name: string, command: string, args: string[], env?: Record<string,string> }[]} */
const SERVERS = [
  {
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", SCRATCH],
  },
  { name: "memory", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
  {
    name: "sequential-thinking",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
  { name: "everything", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
  { name: "context7", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
  { name: "deepwiki", command: "npx", args: ["-y", "mcp-deepwiki@latest"] },
  { name: "playwright", command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"] },
  { name: "duckduckgo", command: "npx", args: ["-y", "duckduckgo-mcp-server"] },
];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${label})`)), ms);
      timer.unref?.();
    }),
  ]);
}

async function dump(server) {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...process.env, ...(server.env ?? {}) },
    stderr: "ignore",
  });
  const client = new Client({ name: "codeflow-schema-dump", version: "0.0.0" }, {});

  try {
    await withTimeout(client.connect(transport), TIMEOUT_MS, `${server.name}: connect`);

    /** @type {any[]} */
    const tools = [];
    let cursor = undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await withTimeout(
        client.listTools(cursor === undefined ? undefined : { cursor }),
        TIMEOUT_MS,
        `${server.name}: tools/list`,
      );
      tools.push(...(result.tools ?? []));
      if (!result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }

    const info = client.getServerVersion?.() ?? {};
    return {
      ok: true,
      payload: {
        server: server.name,
        command: `${server.command} ${server.args.join(" ")}`,
        serverInfo: info,
        capturedAt: new Date().toISOString(),
        toolCount: tools.length,
        tools,
      },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

async function main() {
  const only = process.argv.slice(2);
  const selected = only.length > 0 ? SERVERS.filter((s) => only.includes(s.name)) : SERVERS;

  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(join(SCRATCH, "hello.txt"), "scratch file for the filesystem server\n");
  mkdirSync(OUT_DIR, { recursive: true });

  const report = { capturedAt: new Date().toISOString(), ok: [], failed: [] };

  for (const server of selected) {
    process.stderr.write(`→ ${server.name} … `);
    const result = await dump(server);
    if (result.ok) {
      writeFileSync(
        join(OUT_DIR, `${server.name}.json`),
        `${JSON.stringify(result.payload, null, 2)}\n`,
      );
      report.ok.push({ name: server.name, toolCount: result.payload.toolCount });
      process.stderr.write(`${result.payload.toolCount} tools\n`);
    } else {
      report.failed.push({ name: server.name, reason: result.reason });
      process.stderr.write(`FAILED: ${result.reason}\n`);
    }
  }

  writeFileSync(join(OUT_DIR, "_report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(
    `\n${report.ok.length} server(s) captured, ${report.failed.length} failed → ${OUT_DIR}\n`,
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
