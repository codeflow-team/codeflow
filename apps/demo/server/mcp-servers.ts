/**
 * Which MCP servers this demo runner is willing to actually start.
 *
 * The allowlist is short on purpose, and the rule for being on it is: starting
 * the server must be *harmless* on a laptop with no configuration. That means
 * no network reach, no credentials, and nothing writable outside a throwaway
 * directory this process created and will delete.
 *
 *  - **filesystem** — real, pointed at a fresh scratch directory per run. It is
 *    the whole point of the exercise: a flow an AI wrote reads and writes real
 *    files through the official Anthropic server.
 *  - **memory** — real. Its knowledge graph lives in a JSON file inside the
 *    same scratch directory (`MEMORY_FILE_PATH`), so a run cannot pollute a
 *    previous one and nothing survives the run.
 *  - **everything** — real. It is the MCP reference server and exists to be
 *    called.
 *  - **sequential-thinking** — real. Pure computation, no I/O.
 *
 * Everything else is stubbed, and the UI says so per tool:
 *
 *  - **playwright** downloads and drives a browser — too heavy and too
 *    stateful to launch behind a click;
 *  - **duckduckgo / deepwiki / context7** reach the public internet, which the
 *    worker is not given;
 *  - **github / slack / payment** (the specs' `sample` registry) have no server
 *    at all — they are illustrations.
 *
 * The `strip` / `rename` columns mirror `packages/examples/scripts/servers.mjs`,
 * because the registries the flows are written against were generated with
 * them: `tools.browser.click` came from `browser_click`, so calling it back has
 * to undo the same transform. `namespace` is the property path in `tools`.
 *
 * ⚠️ This is a **demo runner, not a sandbox.** The worker has no network of its
 * own, but a real deployment must run flows in proper isolation (a V8 isolate
 * or a container — 09 §1); nothing here should be mistaken for that.
 */

export interface McpServerPlan {
  /** `tools.<namespace>.*` */
  namespace: string;
  /** Human-facing server name, shown on the badge. */
  server: string;
  command: string;
  /** `{{scratch}}` is replaced with the run's scratch directory. */
  args: string[];
  env?: Record<string, string>;
  /** Prefix every tool of this server repeats, stripped when naming methods. */
  strip: string | null;
  /** Exceptions to the slugging, keyed by MCP tool name. */
  rename?: Record<string, string>;
  /** Why a reader should believe this is safe to start. */
  safety: string;
}

export const RUNNABLE_SERVERS: McpServerPlan[] = [
  {
    namespace: "fs",
    server: "@modelcontextprotocol/server-filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{{scratch}}"],
    strip: null,
    safety: "Rooted at a throwaway directory created for this run; the server refuses paths outside it.",
  },
  {
    namespace: "memory",
    server: "@modelcontextprotocol/server-memory",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: { MEMORY_FILE_PATH: "{{scratch}}/memory.json" },
    strip: null,
    safety: "Its knowledge graph is a JSON file inside the run's scratch directory.",
  },
  {
    namespace: "everything",
    server: "@modelcontextprotocol/server-everything",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
    strip: null,
    safety: "The MCP reference server — it exists to be called and touches nothing.",
  },
  {
    namespace: "reasoning",
    server: "@modelcontextprotocol/server-sequential-thinking",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    strip: null,
    rename: { sequentialthinking: "sequentialThinking" },
    safety: "Pure computation; no files, no network.",
  },
];

/** Namespaces with no server, and the one-line reason shown next to them. */
export const STUB_REASONS: Record<string, string> = {
  browser: "Playwright would download and drive a real browser — too heavy to launch from a click.",
  search: "DuckDuckGo needs the public internet, which this runner does not give the worker.",
  deepwiki: "DeepWiki is a hosted service — no network from the worker.",
  context7: "Context7 is a hosted service — no network from the worker.",
  github: "The specs' illustrative registry — there is no GitHub server behind it.",
  slack: "The specs' illustrative registry — there is no Slack server behind it.",
  payment: "The specs' illustrative registry — there is no payment provider behind it.",
};

export function planFor(namespace: string): McpServerPlan | undefined {
  return RUNNABLE_SERVERS.find((plan) => plan.namespace === namespace);
}

export function stubReason(namespace: string): string {
  return STUB_REASONS[namespace] ?? "No MCP server is wired up for this namespace in the demo runner.";
}
