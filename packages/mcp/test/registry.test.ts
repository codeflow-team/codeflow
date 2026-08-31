/**
 * The adapter's real contract: MCP tools registered through it are
 * indistinguishable from any other tool downstream — they codegen into the same
 * `Tools` interface the analyzer resolves against (05-registry.md §2/§3).
 *
 * This is the second acceptance criterion of 08 §4 at the unit level: tools from
 * the MCP adapter must produce the same artifacts as a local registry does.
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow, createRegistry } from "@codeflow-team/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  discoverMcpTools,
  mcpToolToDefinition,
  registerMcpServer,
  type McpTool,
  type McpToolClient,
} from "../src/index.js";

const pullRequest = {
  type: "object",
  properties: {
    number: { type: "number" },
    title: { type: "string" },
    author: { type: "string" },
  },
  required: ["number", "title"],
};

const tools: McpTool[] = [
  {
    name: "get_new_prs",
    title: "Get New PRs",
    description: "Get new pull requests for a repository",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, since: { type: "string" } },
      required: ["repo"],
    },
    outputSchema: { type: "array", items: pullRequest },
  },
  {
    name: "send-message",
    description: "Send a message to a channel",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string" }, message: { type: "string" } },
      required: ["channel", "message"],
    },
  },
];

const fakeClient: McpToolClient = {
  async listTools() {
    return { tools };
  },
};

describe("MCP → registry → codegen", () => {
  it("registers discovered tools and generates the interface from their JSON Schema", async () => {
    const registry = createRegistry();
    await registerMcpServer(registry, fakeClient, { namespace: "github", server: "gh" });

    expect(registry.listTools().map((tool) => tool.name)).toEqual([
      "github.getNewPrs",
      "github.sendMessage",
    ]);

    const dts = createCodeFlow({ registry }).generateToolsDts();

    expect(dts).toContain("export interface Tools {");
    expect(dts).toContain("github: {");
    // Required vs optional properties survive the JSON Schema → TS conversion,
    // and the array output schema becomes an array type.
    expect(dts).toContain(
      "getNewPrs(input: { repo: string; since?: string }): Promise<{ number: number; title: string; author?: string }[]>;",
    );
    // No output schema declared → Promise<unknown>, exactly like a local tool.
    expect(dts).toContain(
      "sendMessage(input: { channel: string; message: string }): Promise<unknown>;",
    );
    // The description is the JSDoc the AI reads (10 §1).
    expect(dts).toContain("/** Get new pull requests for a repository */");
  });

  it("mounts two servers side by side under their own namespaces", async () => {
    const registry = createRegistry();
    await registerMcpServer(registry, fakeClient, { namespace: "github" });
    await registerMcpServer(
      registry,
      { async listTools() { return { tools: [{ name: "send-message" }] }; } },
      { namespace: "slack" },
    );

    const dts = createCodeFlow({ registry }).generateToolsDts();
    expect(dts).toContain("github: {");
    expect(dts).toContain("slack: {");
    expect(registry.getTool("slack.sendMessage")).toBeDefined();
  });

  it("refuses to shadow an existing tool unless overwrite is asked for", async () => {
    const registry = createRegistry();
    await registerMcpServer(registry, fakeClient, { namespace: "github" });

    await expect(registerMcpServer(registry, fakeClient, { namespace: "github" })).rejects.toThrow(
      /already registered/,
    );
    await expect(
      registerMcpServer(registry, fakeClient, { namespace: "github", overwrite: true }),
    ).resolves.toHaveLength(2);
  });

  it("keeps the MCP provenance out of the registry fingerprint", async () => {
    const withMcp = createRegistry({ tools: await discoverMcpTools(fakeClient, { namespace: "github" }) });
    const withoutMcp = createRegistry({
      tools: (await discoverMcpTools(fakeClient, { namespace: "github" })).map(
        ({ mcp: _mcp, ...definition }) => definition,
      ),
    });

    // `mcp` rides along as provenance; the fingerprint is over registry content
    // (05 §2), so a tool means the same thing whether it came from MCP or not.
    expect(withMcp.registryHash()).toBe(withoutMcp.registryHash());
  });

  it("emits a `Tools` interface a contract-shaped flow can be analyzed against", async () => {
    const registry = createRegistry();
    await registerMcpServer(registry, fakeClient, { namespace: "github" });
    const session = createCodeFlow({ registry });

    const graph = await session.analyze(`import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPrs({ repo: input.repository });
  await tools.github.sendMessage({ channel: "#security", message: "done" });
  return prs;
}
`);

    const toolNodes = graph.nodes.filter((node) => node.type === "tool");
    expect(toolNodes.map((node) => node.data["toolName"])).toEqual([
      "github.getNewPrs",
      "github.sendMessage",
    ]);
    // Labels come from the registry — MCP `title` first, humanized name otherwise.
    expect(toolNodes.map((node) => node.label)).toEqual(["Get New PRs", "Send Message"]);
    expect(graph.nodes.some((node) => node.type === "unknown")).toBe(false);
    expect(graph.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("SDK compatibility", () => {
  it("accepts the SDK's own Tool and Client shapes", () => {
    // Compile-time assertions: a real `@modelcontextprotocol/sdk` client is a
    // valid `McpToolClient`, and a real `Tool` is a valid `McpTool`. If the SDK
    // changes shape, this stops compiling — which is the point.
    const sdkTool = {
      name: "get-issue",
      inputSchema: { type: "object", properties: {} },
    } as unknown as Tool;
    const asMcpTool: McpTool = sdkTool;
    const asClient: McpToolClient = {} as unknown as Client;

    expect(mcpToolToDefinition(asMcpTool, { namespace: "gh" }).name).toBe("gh.getIssue");
    expect(typeof asClient).toBe("object");
  });
});
