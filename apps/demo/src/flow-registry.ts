/**
 * Which registry a flow is analyzed against — one answer, for both kinds of flow.
 *
 * A built-in example names its registry and `mcp/use-mcp-servers.ts` decides
 * whether the visitor's own composed registry takes over. A flow the visitor
 * *made* is different in exactly one way: it was created against a registry they
 * picked, and that choice is part of the document. Honouring it is what makes
 * "open one of my flows" restore the thing that was saved rather than whatever
 * happens to be configured this afternoon.
 *
 * The one case worth being loud about: a flow written against MCP servers that
 * are no longer connected. The honest registry then is the empty one — every
 * tool call becomes an `unknown` node with a diagnostic (04 §1.2), which is
 * exactly what happened, rather than resolving against some unrelated built-in
 * set and drawing a diagram that never existed.
 */

import { createRegistry, type RegistryLookup } from "@codeflow/core";
import { REGISTRIES, type ExampleRegistry, type FlowExample } from "./examples-source.js";
import { registryInstance } from "./registry.js";
import { activeRegistry, type McpServersState } from "./mcp/use-mcp-servers.js";
import { MCP_REGISTRY, isMine } from "./my-flows.js";

const EMPTY: ExampleRegistry = {
  id: "mcp-none",
  label: "No MCP tools connected",
  tools: [],
  functions: [],
};

let emptyLookup: RegistryLookup | null = null;

function emptyRegistry(): RegistryLookup {
  emptyLookup ??= createRegistry({ tools: [], functions: [] });
  return emptyLookup;
}

export interface ResolvedRegistry {
  source: ExampleRegistry;
  lookup: RegistryLookup;
  /** True when the tools came from the visitor's own MCP servers. */
  fromMcp: boolean;
  /** Said out loud when the registry is not the one the flow asked for. */
  note: string | null;
}

export function resolveRegistry(
  example: FlowExample,
  mcp: Pick<McpServersState, "composed" | "active">,
): ResolvedRegistry {
  if (!isMine(example)) {
    const resolved = activeRegistry(example, mcp);
    return { ...resolved, note: null };
  }

  const choice = example.mine.registryChoice;

  if (choice === MCP_REGISTRY) {
    if (mcp.active) {
      const resolved = activeRegistry(example, mcp);
      return { ...resolved, note: null };
    }
    return {
      source: EMPTY,
      lookup: emptyRegistry(),
      fromMcp: true,
      note: "This flow was written against your own MCP servers, and none of them is connected right now. It is drawn against an empty registry, so every tool call is an unknown step — connect the servers again and it will resolve.",
    };
  }

  const built = REGISTRIES[choice];
  if (built === undefined) {
    return {
      source: EMPTY,
      lookup: emptyRegistry(),
      fromMcp: false,
      note: `This flow names the registry “${choice}”, which this build does not have. It is drawn against an empty registry, so every tool call is an unknown step.`,
    };
  }

  return { source: built, lookup: registryInstance(built), fromMcp: false, note: null };
}
