/**
 * What this build of the demo can actually do.
 *
 * The same app is shipped two ways and they have genuinely different powers:
 *
 *  - **`pnpm dev` (local)** — a Vite dev server sits behind the page. It holds
 *    `OPENROUTER_API_KEY` for the AI panel and it can spawn real MCP servers
 *    over stdio for the Run feature.
 *  - **the public build** — a static bundle on a CDN. There is no server, so
 *    there is no key to hold and no process to spawn.
 *
 * Everything the product is *about* — analyze, graph, inspect, patch, diff,
 * Monaco round-trip — is `@codeflow-team/core`, which is browser-safe by design and
 * therefore identical in both. Only the two server-shaped features differ, and
 * 07-ui.md §5 is explicit that a feature which cannot work must say so rather
 * than fail quietly. This module is where that difference is named once, so the
 * UI can be honest about it in one voice instead of five.
 */

/*
 * Dot access, not `env["VITE_…"]`: Vite substitutes the literal at build time
 * only for the dotted form, so the flag is a constant the bundler can fold
 * away rather than a lookup that silently reads `undefined` in production.
 */

/** True in a build produced with `VITE_PUBLIC_DEMO=1` — the hosted, serverless one. */
export const IS_PUBLIC_BUILD = import.meta.env.VITE_PUBLIC_DEMO === "1";

/** Where to send someone who wants the parts only a local checkout can do. */
export const REPO_URL =
  (import.meta.env.VITE_REPO_URL as string | undefined) ??
  "https://github.com/codeflow-team/codeflow";

/** One sentence for why running a flow needs a machine, not a CDN. */
export const RUN_UNAVAILABLE_REASON =
  "Running a flow starts a Node worker and launches real MCP servers over stdio. A static site has no process to do that in, so Run is only available in a local checkout.";

/** What to do about it. */
export const RUN_UNAVAILABLE_FIX = "Run it locally instead:";
