/**
 * Servers you can add with one click.
 *
 * The bar for being on this list is narrow and deliberate: **no OAuth, no paid
 * key, and it actually lists tools** when you click it. An entry that fails on
 * click is worse than no entry, because the first thing a visitor learns is
 * that the feature is broken rather than that their own server would work.
 *
 * Every row carries what was checked and when. `tools` is the count observed at
 * verification time — a real number, not a guess — and it is shown as "was N
 * when this list was written", because a server's tool list is the server
 * author's to change.
 *
 * The remote entries are the important ones: they are the only kind that can
 * work in the hosted build, where there is no process to spawn. `cors` records
 * whether the endpoint let a *browser* call it directly, which is exactly the
 * difference between "works on the deployed demo" and "works in a local
 * checkout only".
 */

import type { McpTransport } from "./model.js";

export interface CatalogEntry {
  id: string;
  name: string;
  /** One line: what its tools are for. */
  description: string;
  transport: McpTransport;
  /** stdio */
  command?: string;
  args?: string[];
  /** A `{{scratch}}`-style placeholder the user must replace before it works. */
  needsArgument?: string;
  /** remote */
  url?: string;
  /** Suggested namespace — `tools.<ns>.<method>`. */
  namespace: string;
  /** Tool count seen when this entry was verified. */
  tools: number;
  /** ISO date of that check. */
  verifiedOn: string;
  /** Did a browser reach it directly? Only meaningful for remote entries. */
  cors?: boolean;
  /** Anything a reader should know before clicking. */
  note?: string;
}

const CHECKED = "2026-08-23";

/**
 * Remote endpoints — the ones that work without a dev server behind the page.
 *
 * Every entry here answered `initialize` + `tools/list` anonymously **and**
 * returned `Access-Control-Allow-Origin: *` on a real preflight from
 * `http://localhost:5173`, which is what makes browser-direct discovery
 * possible and therefore what makes them usable on the hosted build.
 *
 * Endpoints deliberately left off, and why: AWS Knowledge, Astro Docs and
 * CoinGecko all answer without auth but send no usable CORS headers, so they
 * would work in a checkout and silently fail on the deployed page — exactly the
 * "an entry that fails on click" case. Sentry, Semgrep, Grafana, Linear, Notion,
 * Stripe, Vercel, Neon and the rest of the hosted set all answered 401. The old
 * `remote.mcpservers.org` aggregator no longer resolves at all.
 */
export const REMOTE_CATALOG: CatalogEntry[] = [
  {
    id: "deepwiki",
    name: "DeepWiki",
    description: "Ask questions about any public GitHub repository, and read its generated wiki.",
    transport: "http",
    url: "https://mcp.deepwiki.com/mcp",
    namespace: "deepwiki",
    tools: 3,
    verifiedOn: CHECKED,
    cors: true,
  },
  {
    id: "context7",
    name: "Context7",
    description: "Current documentation for a library or framework, by name.",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    namespace: "context7",
    tools: 2,
    verifiedOn: CHECKED,
    cors: true,
    note: "Answers anonymously; a free key only raises the rate limit.",
  },
  {
    id: "gitmcp",
    name: "GitMCP",
    description: "Search documentation and code across any GitHub repository.",
    transport: "http",
    url: "https://gitmcp.io/docs",
    namespace: "gitmcp",
    tools: 5,
    verifiedOn: CHECKED,
    cors: true,
  },
  {
    id: "mslearn",
    name: "Microsoft Learn",
    description: "Search Microsoft and Azure documentation, and fetch a page or a code sample.",
    transport: "http",
    url: "https://learn.microsoft.com/api/mcp",
    namespace: "mslearn",
    tools: 3,
    verifiedOn: CHECKED,
    cors: true,
  },
  {
    id: "cloudflare-docs",
    name: "Cloudflare Docs",
    description: "Search the Cloudflare documentation.",
    transport: "http",
    url: "https://docs.mcp.cloudflare.com/mcp",
    namespace: "cloudflare",
    tools: 2,
    verifiedOn: CHECKED,
    cors: true,
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    description: "Search models, datasets and spaces on the Hub.",
    transport: "http",
    url: "https://huggingface.co/mcp",
    namespace: "huggingface",
    tools: 4,
    verifiedOn: CHECKED,
    cors: true,
    note: "Anonymous access is rate-limited; an HF token adds more tools.",
  },
  {
    id: "mermaid",
    name: "Mermaid Chart",
    description: "Validate and render Mermaid diagrams, and read the syntax reference.",
    transport: "http",
    url: "https://mcp.mermaidchart.com/mcp",
    namespace: "mermaid",
    tools: 25,
    verifiedOn: CHECKED,
    cors: true,
    note: "25 tools — a good one to try the per-tool selection on. The diagram tools are open; its GitHub/Jira tools want their own tokens.",
  },
];

/**
 * stdio servers — local checkouts only; they start a process on this machine.
 *
 * Only four of the official `@modelcontextprotocol/server-*` packages are still
 * published and maintained (filesystem, memory, everything, sequential-thinking);
 * github, slack, puppeteer, gitlab, brave-search, google-maps, postgres, redis,
 * everart and aws-kb-retrieval are all deprecated on npm, and sqlite, git, time
 * and fetch are not on npm at all (the last three live on PyPI). So the list is
 * those four plus Playwright, which is the well-known key-free third party.
 *
 * The namespaces avoid the ones `server/mcp-servers.ts` already claims (`fs`,
 * `memory`, `everything`, `reasoning`): that allowlist wins at run time by
 * design, and a quick-add that silently ended up bound to a *different* server
 * than the one on the card would be the worst kind of confusing.
 */
export const STDIO_CATALOG: CatalogEntry[] = [
  {
    id: "everything",
    name: "MCP Everything",
    description: "The reference server. Echo, sums, images, sampling — it exists to be called.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
    namespace: "demo",
    tools: 13,
    verifiedOn: CHECKED,
  },
  {
    id: "memory",
    name: "Memory",
    description: "A local knowledge graph — entities, relations, observations.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    namespace: "notes",
    tools: 9,
    verifiedOn: CHECKED,
  },
  {
    id: "filesystem",
    name: "Filesystem (/tmp)",
    description: "Read, write, move and search files — rooted at /tmp for this entry.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    namespace: "files",
    tools: 14,
    verifiedOn: CHECKED,
    needsArgument: "/tmp",
    note: "Give it a different directory if /tmp is not what you want it reading and writing.",
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "A structured step-by-step reasoning scratchpad. One tool, no I/O.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    namespace: "think",
    tools: 1,
    verifiedOn: CHECKED,
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "Drive a real browser: navigate, snapshot, click, type, screenshot.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
    namespace: "browser",
    tools: 24,
    verifiedOn: CHECKED,
    note: "The first run downloads a browser, so give it a minute.",
  },
];

export const CATALOG: CatalogEntry[] = [...REMOTE_CATALOG, ...STDIO_CATALOG];
