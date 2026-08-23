/**
 * The contract `@codeflow/examples` publishes to whoever renders it.
 *
 * A gallery needs two things from an example: something to put on a card
 * (`title`, `summary`, `highlights`) and something to feed the analyzer
 * (`source` plus the registry it was written against). Everything here serves
 * one of those two jobs; nothing is derived at render time that could be got
 * wrong — `lines` in particular is computed from `source` when the package is
 * built, so a card and the code behind it can never disagree.
 */

import type { FunctionDefinition, ToolDefinition } from "@codeflow/core";

export type ExampleCategory =
  /** One construct at a time — the shape of a flow, nothing clever. */
  | "basics"
  /** Branches, loops, jumps, try/catch — the control-flow projection rules. */
  | "control-flow"
  /** Written against tool schemas captured from real MCP servers. */
  | "real-mcp"
  /** Long, deeply nested, many hard cases at once — the ones that hurt. */
  | "stress"
  /** Deliberately outside the contract, to show what CodeFlow says when it does not know. */
  | "degradation";

export interface FlowExample {
  /** Stable, kebab-case. Safe to use in a URL or as a React key. */
  id: string;
  /** Short name for a gallery card. */
  title: string;
  category: ExampleCategory;
  /** One sentence for the card. */
  summary: string;
  /** Two to four sentences: what this flow does, in product voice. */
  description: string;
  /** Line count of `source` (a trailing newline does not count as a line). */
  lines: number;
  /** The hard parts, spelled out — what a reader should go looking for. */
  highlights: string[];
  /** Key into `REGISTRIES`. */
  registryId: string;
  /** The full TypeScript source of the flow. */
  source: string;
}

export interface ExampleRegistry {
  id: string;
  label: string;
  tools: ToolDefinition[];
  functions: FunctionDefinition[];
}
