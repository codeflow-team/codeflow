/**
 * The pure half of "bring your own MCP servers".
 *
 * `compose` is the seam the whole feature turns on: a list of configured
 * servers in, an `ExampleRegistry` out, which the palette, the analyzer, the AI
 * context and the Run bindings all read. It has to be a function — same input,
 * same registry, therefore the same `registryHash` and a staleness check that
 * means something across reloads (05 §2, 06 §5) — so it is tested as one.
 */

import { describe, expect, it } from "vitest";
import { createRegistry, generateToolsDts } from "@codeflow-team/core";
import {
  compose,
  defaultNamespace,
  formatCommand,
  includedTools,
  isSelected,
  parseCommand,
  runSpecs,
  selectAll,
  statusOf,
  toggleTool,
  type McpServerConfig,
  type McpToolRecord,
} from "../src/mcp/model.js";

function tool(method: string, toolName = method): McpToolRecord {
  return {
    method,
    toolName,
    label: method,
    description: `does ${method}`,
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  };
}

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "a",
    name: "Filesystem",
    namespace: "files",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    enabled: true,
    selected: null,
    discovery: {
      at: 1,
      via: "server",
      transport: "stdio",
      tools: [tool("readFile", "read_file"), tool("writeFile", "write_file")],
    },
    ...overrides,
  };
}

describe("compose", () => {
  it("turns discovered tools into a registry the analyzer can be built from", () => {
    const { registry, toolCount, collisions } = compose([server()]);

    expect(toolCount).toBe(2);
    expect(collisions).toEqual([]);
    expect(registry.tools.map((entry) => entry.name)).toEqual(["files.readFile", "files.writeFile"]);
    // The generated interface is the artifact three consumers read (05 §2).
    const dts = generateToolsDts(createRegistry({ tools: registry.tools, functions: [] }));
    expect(dts).toContain("files: {");
    expect(dts).toContain("readFile(input:");
  });

  it("is a function of its input — the same configuration composes to the same id", () => {
    expect(compose([server()]).registry.id).toBe(compose([server()]).registry.id);
  });

  it("changes id when the selection changes, because the registry changed", () => {
    const all = compose([server()]).registry.id;
    const one = compose([server({ selected: ["readFile"] })]).registry.id;
    expect(one).not.toBe(all);
  });

  it("renames every tool when the namespace moves", () => {
    const { registry } = compose([server({ namespace: "disk" })]);
    expect(registry.tools.map((entry) => entry.name)).toEqual(["disk.readFile", "disk.writeFile"]);
  });

  it("leaves a disabled server out entirely", () => {
    expect(compose([server({ enabled: false })]).toolCount).toBe(0);
  });

  it("leaves a server that has never connected out entirely", () => {
    expect(compose([server({ discovery: null })]).toolCount).toBe(0);
  });

  it("refuses a namespace collision instead of merging it", () => {
    const first = server({ id: "a", name: "One" });
    const second = server({ id: "b", name: "Two", discovery: { at: 1, via: "server", transport: "stdio", tools: [tool("readFile", "READ")] } });

    const { registry, collisions } = compose([first, second]);

    // The first claimant keeps the namespace; nothing of the second leaks in.
    expect(collisions).toEqual([{ namespace: "files", serverIds: ["a", "b"] }]);
    expect(registry.tools.map((entry) => entry.name)).toEqual(["files.readFile", "files.writeFile"]);
  });

  it("emits tools sorted by name, so the registry hash does not depend on order", () => {
    const one = compose([server({ discovery: { at: 1, via: "server", transport: "stdio", tools: [tool("b"), tool("a")] } })]);
    const two = compose([server({ discovery: { at: 1, via: "server", transport: "stdio", tools: [tool("a"), tool("b")] } })]);
    expect(one.registry.id).toBe(two.registry.id);
  });

  it("carries the description through — it is the JSDoc the AI reads", () => {
    const { registry } = compose([server()]);
    expect(registry.tools[0]?.description).toBe("does readFile");
  });
});

describe("tool selection", () => {
  it("treats null as everything", () => {
    expect(includedTools(server()).map((entry) => entry.method)).toEqual(["readFile", "writeFile"]);
    expect(isSelected(server(), "readFile")).toBe(true);
  });

  it("normalizes a full selection back to null", () => {
    const partial = server({ selected: ["readFile"] });
    expect(toggleTool(partial, "writeFile").selected).toBeNull();
  });

  it("drops one tool without touching the rest", () => {
    const next = toggleTool(server(), "writeFile");
    expect(next.selected).toEqual(["readFile"]);
    expect(includedTools(next).map((entry) => entry.method)).toEqual(["readFile"]);
  });

  it("select-none composes to an empty registry, not to everything", () => {
    expect(compose([selectAll(server(), false)]).toolCount).toBe(0);
    expect(compose([selectAll(server(), true)]).toolCount).toBe(2);
  });
});

describe("run specs", () => {
  it("carries the method → MCP tool name map, which is the only way a new tool is callable", () => {
    const [spec] = runSpecs([server()], () => undefined);
    expect(spec?.methods).toEqual({ readFile: "read_file", writeFile: "write_file" });
    expect(spec?.command).toBe("npx");
  });

  it("only lists the tools that are actually selected", () => {
    const [spec] = runSpecs([server({ selected: ["readFile"] })], () => undefined);
    expect(spec?.methods).toEqual({ readFile: "read_file" });
  });

  it("attaches the token header only when both the name and a value exist", () => {
    const remote = server({ transport: "http", url: "https://example.test/mcp", headerName: "Authorization" });
    expect(runSpecs([remote], () => "Bearer x")[0]?.headers).toEqual({ Authorization: "Bearer x" });
    expect(runSpecs([remote], () => undefined)[0]?.headers).toBeUndefined();
    expect(runSpecs([server({ transport: "http", url: "https://example.test/mcp" })], () => "Bearer x")[0]?.headers).toBeUndefined();
  });

  it("skips a disabled server and a colliding namespace", () => {
    expect(runSpecs([server({ enabled: false })], () => undefined)).toEqual([]);
    const specs = runSpecs([server({ id: "a" }), server({ id: "b", name: "Other" })], () => undefined);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.server).toBe("Filesystem");
  });
});

describe("parseCommand", () => {
  it("splits a plain command line", () => {
    expect(parseCommand("npx -y @modelcontextprotocol/server-filesystem /tmp/scratch")).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/scratch"],
    });
  });

  it("keeps a quoted path in one piece", () => {
    expect(parseCommand('npx -y pkg "/Users/me/My Files"')).toEqual({
      command: "npx",
      args: ["-y", "pkg", "/Users/me/My Files"],
    });
  });

  it("does not interpret shell syntax — there is no shell", () => {
    // The pipe and the `&&` survive as ordinary argv entries; nothing is run
    // through `sh`, so they reach `spawn` as literal strings and do nothing.
    const parsed = parseCommand("npx pkg && rm -rf /");
    expect(parsed.command).toBe("npx");
    expect(parsed.args).toEqual(["pkg", "&&", "rm", "-rf", "/"]);
  });

  it("handles an empty line without throwing", () => {
    expect(parseCommand("   ")).toEqual({ command: "", args: [] });
  });

  it("round-trips through formatCommand", () => {
    const line = 'npx -y pkg "/Users/me/My Files"';
    expect(formatCommand(server({ ...parseCommand(line) }))).toBe(line);
  });
});

describe("namespaces and status", () => {
  it("slugs a server name into a valid identifier", () => {
    expect(defaultNamespace("@modelcontextprotocol/server-filesystem")).toBe("filesystem");
    expect(defaultNamespace("Mermaid Chart")).toBe("mermaidChart");
    expect(defaultNamespace("!!!")).toBe("mcp");
  });

  it("reports the three states a row can be in", () => {
    expect(statusOf(server())).toBe("connected");
    expect(statusOf(server({ discovery: null }))).toBe("not-connected");
    expect(statusOf(server({ discovery: null, error: "spawn ENOENT" }))).toBe("failed");
  });
});
