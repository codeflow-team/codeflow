/**
 * `prompts/flow-style.md` — the style guide shipped into a workspace
 * (01-flow-contract.md §3, referenced as a prompt section by 10-ai-codegen.md §1).
 *
 * Written in English and kept short on purpose: it goes into an AI's context
 * budget alongside `tools.d.ts` and `lib.d.ts`, where the target for the whole
 * bundle is ~2k tokens. It is guidance, not a validator — code that ignores it
 * still runs, it just projects to fewer meaningful nodes and more code nodes.
 *
 * `codeflow generate` writes it only when it is missing, so a host can customise
 * its copy without the CLI stomping on it.
 */

import { FLOW_STYLE_PROMPT } from "@codeflow/core";

export const FLOW_STYLE_FILENAME = "flow-style.md";

export const FLOW_STYLE_MD = `# Flow style guide

CodeFlow reads a flow file and projects it into a workflow graph that non-developers
look at and trust. Code is the source of truth; the graph is a projection of it.
Write flows the way described here and every step becomes a readable node.

## The contract

One flow is one file, with exactly one default export:

\`\`\`ts
import type { Tools } from "../generated/tools";
import { isAuthChange } from "@flows/lib";

export default async function flow(
  input: { repository: string },
  tools: Tools
) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });

  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });

    if (files.some(isAuthChange)) {
      await tools.slack.send({
        channel: "#security",
        message: \`Security PR: \${pr.title}\`
      });
    }
  }
}
\`\`\`

- \`input\` (first parameter) is the trigger payload; its type defines the trigger node.
- \`tools\` (second parameter) is the only way to reach a tool or MCP server. Its type
  comes from \`generated/tools.d.ts\` — never redeclare it, never call a tool that is
  not in it.
- Library functions are imported from \`@flows/lib\`; see \`generated/lib.d.ts\` for
  what exists and with which signature.
- The return value is the flow's result.

## Rules

${FLOW_STYLE_PROMPT}

## What projects to a node

| Construct | Node |
| --- | --- |
| \`await tools.<ns>.<fn>(args)\` | tool |
| calling a function imported from \`@flows/lib\` | function |
| calling a named function declared in the file | function |
| \`const x = await ...\` | data output (port) of that node |
| \`if\` / \`else\` | condition + two control branches |
| \`for...of\`, \`for await...of\` | loop (body is a subgraph) |
| \`while (cond)\` | loop, condition editable |
| \`try\` / \`catch\` / \`finally\` | try, with an error edge |
| early \`return\` | output ("End Flow") |
| \`break\` / \`continue\` | jump inside the loop subgraph |
| \`Promise.all([...])\` | parallel + merge |
| template literal in an argument | expression, shown as \`{{ }}\` |
| anything else | custom code node, source kept verbatim |

Anything not in this table still works — it becomes a code node with the source
shown as written. That is a graceful fallback, not an error; it just shows the user
less structure.

## Imports

- \`import type { Tools } from "../generated/tools";\` — types only.
- \`import { ... } from "@flows/lib";\` — library functions.
- Type-only imports may come from anywhere in the workspace.
- Value imports from anywhere else degrade to an opaque code node with a warning —
  prefer a library function.
- Never edit anything under \`generated/\`: it is derived from the registry and is
  rewritten by \`codeflow generate\`.
`;
