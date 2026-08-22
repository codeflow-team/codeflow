/**
 * MCP tool → `ToolDefinition` mapping — 05-registry.md §3.
 *
 * No network, no transport, no server process: the adapter's whole input is a
 * `tools/list` payload, so a mock client is the honest test double.
 */

import { describe, expect, it } from "vitest";
import {
  discoverMcpTools,
  humanize,
  mcpToolToDefinition,
  mcpToolsToDefinitions,
  slugifyMethod,
  slugifyNamespace,
  type McpListToolsResult,
  type McpTool,
  type McpToolClient,
} from "../src/index.js";

/** A fake `tools/list`, optionally paginated. */
function client(pages: McpListToolsResult[]): McpToolClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async listTools(params) {
      calls.push(params);
      const index = params?.cursor === undefined ? 0 : Number(params.cursor);
      return pages[index] ?? { tools: [] };
    },
  };
}

const getIssue: McpTool = {
  name: "get-issue",
  description: "Get one issue by number",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      number: { type: "number" },
    },
    required: ["repo", "number"],
  },
};

describe("name mapping", () => {
  it("builds `<ns>.<method>` from the namespace and the MCP tool name", () => {
    const definition = mcpToolToDefinition(getIssue, { namespace: "github" });
    expect(definition.name).toBe("github.getIssue");
    expect(definition.mcp).toEqual({
      namespace: "github",
      method: "getIssue",
      toolName: "get-issue",
      renamed: true,
    });
  });

  it("slugs every shape of MCP name into a valid identifier", () => {
    expect(slugifyMethod("get-issue")).toBe("getIssue");
    expect(slugifyMethod("get_issue")).toBe("getIssue");
    expect(slugifyMethod("get.issue")).toBe("getIssue");
    expect(slugifyMethod("get issue")).toBe("getIssue");
    expect(slugifyMethod("getIssue")).toBe("getIssue");
    expect(slugifyMethod("GET_ISSUE")).toBe("getIssue");
    expect(slugifyMethod("get/issue!")).toBe("getIssue");
    expect(slugifyMethod("search__API__keys")).toBe("searchApiKeys");
    // A leading digit and a reserved word are the two ways a slug can still be
    // invalid — both are repaired rather than rejected.
    expect(slugifyMethod("2fa_check")).toBe("_2faCheck");
    expect(slugifyMethod("delete")).toBe("delete_");
    expect(slugifyMethod("!!!")).toBe("tool");
  });

  it("keeps a name that is already a valid method verbatim, and says so", () => {
    const definition = mcpToolToDefinition({ name: "getFiles" }, { namespace: "github" });
    expect(definition.name).toBe("github.getFiles");
    expect(definition.mcp.renamed).toBe(false);
    expect(definition.mcp.toolName).toBe("getFiles");
  });

  it("slugs the namespace too, and keeps dotted namespaces nested", () => {
    expect(slugifyNamespace("github-mcp")).toBe("githubMcp");
    expect(slugifyNamespace("acme.github")).toBe("acme.github");
    expect(mcpToolToDefinition(getIssue, { namespace: "acme.github" }).name).toBe(
      "acme.github.getIssue",
    );
  });

  it("never loses the original MCP identity", () => {
    const definition = mcpToolToDefinition(
      { name: "列出文件" },
      { namespace: "files", server: "fs-server" },
    );
    // Unmappable characters still produce a usable name…
    expect(definition.name).toBe("files.tool");
    // …and the tool remains addressable on the server it came from.
    expect(definition.mcp).toEqual({
      namespace: "files",
      method: "tool",
      toolName: "列出文件",
      renamed: true,
      server: "fs-server",
    });
  });

  it("keeps colliding slugs reachable instead of overwriting one", () => {
    const definitions = mcpToolsToDefinitions(
      [{ name: "get-issue" }, { name: "get_issue" }, { name: "getIssue" }],
      { namespace: "github" },
    );
    expect(definitions.map((definition) => definition.name)).toEqual([
      "github.getIssue",
      "github.getIssue2",
      "github.getIssue3",
    ]);
    expect(definitions.map((definition) => definition.mcp.toolName)).toEqual([
      "get-issue",
      "get_issue",
      "getIssue",
    ]);
  });

  it("honours a caller-supplied method name, and still slugs it", () => {
    const definition = mcpToolToDefinition(getIssue, {
      namespace: "github",
      methodName: () => "fetch one issue",
    });
    expect(definition.name).toBe("github.fetchOneIssue");
    expect(definition.mcp.toolName).toBe("get-issue");
  });
});

describe("label, description, icon", () => {
  it("prefers title, then annotations.title, then the humanized name", () => {
    expect(mcpToolToDefinition({ name: "get-issue", title: "Fetch Issue" }, { namespace: "gh" }).label)
      .toBe("Fetch Issue");
    expect(
      mcpToolToDefinition(
        { name: "get-issue", annotations: { title: "Issue Reader" } },
        { namespace: "gh" },
      ).label,
    ).toBe("Issue Reader");
    expect(mcpToolToDefinition({ name: "get-issue" }, { namespace: "gh" }).label).toBe("Get Issue");
    expect(humanize("GET_FILES")).toBe("Get Files");
    expect(humanize("getFiles")).toBe("Get Files");
  });

  it("passes the description through untouched", () => {
    const definition = mcpToolToDefinition(getIssue, { namespace: "github" });
    expect(definition.description).toBe("Get one issue by number");
    expect(mcpToolToDefinition({ name: "x" }, { namespace: "gh" }).description).toBeUndefined();
  });

  it("takes the icon from the first MCP icon when there is one", () => {
    const definition = mcpToolToDefinition(
      { name: "get-issue", icons: [{ src: "https://example.test/i.png" }] },
      { namespace: "github" },
    );
    expect(definition.icon).toBe("https://example.test/i.png");
  });
});

describe("schemas", () => {
  it("passes the MCP JSON Schema through as the input schema, byte for byte", () => {
    const definition = mcpToolToDefinition(getIssue, { namespace: "github" });
    expect(definition.inputSchema).toEqual(getIssue.inputSchema);
    expect(definition.inputSchema).toBe(getIssue.inputSchema);
  });

  it("maps an MCP output schema when the server declares one", () => {
    const outputSchema = { type: "object", properties: { url: { type: "string" } } };
    const definition = mcpToolToDefinition({ ...getIssue, outputSchema }, { namespace: "github" });
    expect(definition.outputSchema).toBe(outputSchema);
    // No output schema → none on the definition; codegen then emits Promise<void>.
    expect(mcpToolToDefinition(getIssue, { namespace: "github" }).outputSchema).toBeUndefined();
  });

  it("substitutes an empty object schema when a server omits inputSchema", () => {
    const definition = mcpToolToDefinition({ name: "ping" }, { namespace: "ops" });
    expect(definition.inputSchema).toEqual({ type: "object" });
    expect(definition.editableFields).toBeUndefined();
  });

  it("derives editable fields from the top-level input properties (06 §1)", () => {
    expect(mcpToolToDefinition(getIssue, { namespace: "github" }).editableFields).toEqual([
      "repo",
      "number",
    ]);
    expect(
      mcpToolToDefinition(getIssue, { namespace: "github", deriveEditableFields: false })
        .editableFields,
    ).toBeUndefined();
  });
});

describe("discovery", () => {
  it("maps everything `tools/list` returns", async () => {
    const definitions = await discoverMcpTools(
      client([{ tools: [getIssue, { name: "list-prs", title: "List PRs" }] }]),
      { namespace: "github", server: "github-mcp" },
    );
    expect(definitions.map((definition) => definition.name)).toEqual([
      "github.getIssue",
      "github.listPrs",
    ]);
    expect(definitions.every((definition) => definition.mcp.server === "github-mcp")).toBe(true);
  });

  it("follows nextCursor to the end — a partial registry would invent unknown nodes", async () => {
    const paged = client([
      { tools: [{ name: "a-tool" }], nextCursor: "1" },
      { tools: [{ name: "b-tool" }], nextCursor: "2" },
      { tools: [{ name: "c-tool" }] },
    ]);
    const definitions = await discoverMcpTools(paged, { namespace: "acme" });

    expect(definitions.map((definition) => definition.name)).toEqual([
      "acme.aTool",
      "acme.bTool",
      "acme.cTool",
    ]);
    expect(paged.calls).toEqual([undefined, { cursor: "1" }, { cursor: "2" }]);
  });

  it("stops when a server repeats a cursor instead of looping forever", async () => {
    const stuck: McpToolClient = {
      async listTools() {
        return { tools: [{ name: "a-tool" }], nextCursor: "same" };
      },
    };
    const definitions = await discoverMcpTools(stuck, { namespace: "acme", maxPages: 5 });
    expect(definitions.map((definition) => definition.name)).toEqual([
      "acme.aTool",
      "acme.aTool2",
    ]);
  });

  it("rejects a nameless tool rather than registering something unreachable", () => {
    expect(() => mcpToolToDefinition({ name: "" }, { namespace: "gh" })).toThrow(/no name/);
  });
});
