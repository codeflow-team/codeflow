/**
 * `codeflow generate --agent-md` — the file-based delivery mode of 10-ai-codegen.md §3.
 *
 * An agent harness (Claude Code, Cursor, …) reads the workspace itself: the
 * generated `.d.ts` files and the style guide ARE the context. All that is missing
 * is a paragraph in `CLAUDE.md` / `AGENTS.md` pointing the agent at them — this
 * emits exactly that paragraph, with the workspace's real paths in it.
 */

import path from "node:path";
import type { Workspace } from "./config.js";
import { FLOW_STYLE_FILENAME } from "./prompts.js";

export const AGENT_MD_BEGIN = "<!-- codeflow:begin -->";
export const AGENT_MD_END = "<!-- codeflow:end -->";

function relative(workspace: Workspace, dir: string, file?: string): string {
  const base = path.relative(workspace.root, dir) || ".";
  const joined = file === undefined ? base : path.join(base, file);
  return joined.split(path.sep).join("/");
}

/** Markdown section to paste into the workspace's `CLAUDE.md` / `AGENTS.md`. */
export function agentMarkdown(workspace: Workspace): string {
  const tools = relative(workspace, workspace.generatedDir, "tools.d.ts");
  const lib = relative(workspace, workspace.generatedDir, "lib.d.ts");
  const style = relative(workspace, workspace.promptsDir, FLOW_STYLE_FILENAME);
  const flows = relative(workspace, workspace.flowsDir);
  const libDir = relative(workspace, workspace.libDir);
  const generated = relative(workspace, workspace.generatedDir);

  return `${AGENT_MD_BEGIN}
## CodeFlow flows

This is a CodeFlow flows workspace. Flow code is the source of truth; CodeFlow
projects it into a workflow graph that non-developers read and edit.

Before writing or editing a flow, read these three files:

1. \`${tools}\` — every tool available, with its full signature. A flow may only call
   tools that appear here.
2. \`${lib}\` — the library functions importable from \`${workspace.libModulePath}\`.
3. \`${style}\` — the flow style guide. Follow it; it decides how much of the flow
   shows up as readable nodes.

Rules for this workspace:

- One flow per file in \`${flows}/\`, named \`<name>.flow.ts\`, with exactly one default
  export: \`export default async function flow(input, tools) { … }\`.
- Import tool types with \`import type { Tools } from "../${generated}/tools";\` and
  library functions with \`import { … } from "${workspace.libModulePath}";\`.
- Reusable logic belongs in \`${libDir}/\` (one function per file), not copied between flows.
- Never edit anything under \`${generated}/\` — it is derived from the registry. After
  changing \`${path.basename(workspace.configPath)}\` or \`${libDir}/\`, run \`codeflow generate\`.
- Run \`codeflow check\` to analyze every flow and report diagnostics.
${AGENT_MD_END}`;
}
