/**
 * Static prompt material shipped with the library — 10-ai-codegen.md §1.
 *
 * Three of the six bundle components are static text: the flow contract
 * ([01-flow-contract.md](../../../../docs/01-flow-contract.md) §1), the style
 * guide (01 §3) and the few-shot examples. They live here, in core, because
 * they are part of the *contract between CodeFlow and the AI* — the same
 * sentences that the analyzer's rules enforce. Everything is written in English
 * and kept short on purpose: the whole bundle targets ~2k tokens (10 §4).
 *
 * These strings are guidance for the model, never a validator: code that
 * ignores them still analyzes, it just projects to fewer meaningful nodes
 * (01 §3).
 */

/** 01 §1 + §2 — what a flow file is, and what projects to a node. */
export const FLOW_CONTRACT_PROMPT = `A flow is **one TypeScript file with exactly one default export**: an \`async\`
function taking exactly two parameters.

\`\`\`ts
import type { Tools } from "../generated/tools";

export default async function flow(
  input: { /* trigger payload */ },
  tools: Tools
) {
  // steps
}
\`\`\`

- \`input\` (first parameter) is the trigger payload. Its type defines the trigger node,
  so give it an explicit object type.
- \`tools\` (second parameter) is the only way to reach a tool. Its type comes from
  \`generated/tools.d.ts\`; never redeclare it and never call a tool that is not in it.
- Library functions are imported from \`@flows/lib\`; \`generated/lib.d.ts\` lists what
  exists and with which signature. Do not invent library functions.
- The return value is the flow's result.

Constructs that project to a node:

| Construct | Node |
| --- | --- |
| \`await tools.<ns>.<fn>(args)\` | tool |
| calling a function imported from \`@flows/lib\` | function |
| calling a named function declared in the same file | function |
| \`const x = await ...\` | data output (port) of that node |
| \`if\` / \`else\` | condition + two control branches |
| \`for...of\`, \`for await...of\` | loop (body is a subgraph) |
| \`while (cond)\` | loop, condition editable |
| \`try\` / \`catch\` / \`finally\` | try, with an error edge |
| early \`return\` | output ("End Flow") |
| \`break\` / \`continue\` | jump inside the loop subgraph |
| \`Promise.all([...])\` with an **array literal** | parallel + merge |
| template literal in an argument | expression, shown as \`{{ }}\` |
| anything else | custom code node, kept verbatim |

Anything outside the table still works — it degrades to an opaque code node. That is a
fallback, not an error, but it shows the reader less structure, so avoid it.`;

/** 01 §3 — the style guide, in the imperative form a model follows best. */
export const FLOW_STYLE_PROMPT = `1. **One step, one statement.** Every tool call is its own \`await\` statement — at the
   top level of the flow body, or directly inside an \`if\` / \`for\` / \`while\` / \`try\`
   block.
2. **Never hide a call inside an expression.** Not in a condition
   (\`if (await tools.x.y())\` ❌ — hoist it: \`const ok = await tools.x.y();\` then
   \`if (ok)\`), not as an argument to another call, not inside a callback
   (\`Promise.all(prs.map(...))\` ❌ — use \`for...of\`, or \`Promise.all([...])\` with an
   array literal). For parallel steps, write the calls **inside the array literal**
   (\`const [a, b] = await Promise.all([tools.x.one({…}), tools.y.two({…})]);\`); do not
   hoist them into \`const aPromise = tools.x.one({…})\` first — an un-awaited call in a
   \`const\` is not recognised as a step and the parallel branch disappears from the graph.
3. **Name your results.** Assign to a \`const\` with a meaningful name — the variable
   name becomes the label of the data edge in the graph. Never assign a call straight
   into an outer \`let\` (\`issue = await tools.jira.getIssue(…)\` ❌): take the result in
   a \`const\` first, then copy it (\`const fetched = await …; issue = fetched;\`).
4. **Extract complex conditions** into a named function with a descriptive name
   (\`isAuthChange\`) instead of a long inline expression: it becomes a readable node.
5. **Extract complex data transformations** into a named function too, instead of
   scattering \`.map\`/\`.reduce\`/\`.filter\` chains across the flow body.
6. **Keep \`try\`/\`catch\` narrow.** Wrap only the group of steps that can actually fail
   — one tool call, or a few adjacent ones — never the whole flow body.
7. **Every \`while\` needs a stopping condition visible in the code**: a counter or an
   attempt limit that the body updates (\`attempt += 1\`). An unbounded \`while\` gets a
   warning.
8. **\`return\` / \`break\` / \`continue\`** are the right way to write guards and early
   exits. Do not use recursion in the flow body.
9. **Imports.** \`import type { Tools } from "../generated/tools";\` is type-only —
   never import a value from \`generated/\`. Value imports come from \`@flows/lib\`.
   Type-only imports may come from anywhere. Any other value import degrades the
   statements that use it to opaque code nodes.`;

/** The canonical example of the specs — 01 §1, graph defined in 07 §6. */
export const CANONICAL_EXAMPLE = `\`\`\`ts
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
\`\`\``;

/**
 * A second example covering the constructs the canonical one does not: a
 * bounded \`while\`, a narrow \`try\`/\`catch\`/\`finally\`, an early \`continue\`, and a
 * \`Promise.all\` over an array literal. Tool names here are illustrative — the
 * real ones always come from \`generated/tools.d.ts\`.
 */
export const RESILIENCE_EXAMPLE = `\`\`\`ts
import type { Tools } from "../generated/tools";

export default async function flow(
  input: { issueKey: string },
  tools: Tools
) {
  let attempt = 0;
  let issue = null;

  while (issue === null && attempt < 3) {
    attempt += 1;
    try {
      const fetched = await tools.jira.getIssue({ key: input.issueKey });
      issue = fetched;
    } catch (error) {
      await tools.slack.send({ channel: "#alerts", message: \`Fetch failed: \${String(error)}\` });
    }
  }

  if (issue === null) {
    return { delivered: false };
  }

  const summary = await tools.jira.summarize({ issue });
  const comments = await tools.jira.getComments({ issue });
  const [posted, mailed] = await Promise.all([
    tools.slack.send({ channel: "#triage", message: summary }),
    tools.email.send({ to: "triage@example.com", subject: input.issueKey, body: summary })
  ]);

  for (const comment of comments) {
    if (comment.internal) {
      continue;
    }
    await tools.slack.send({ channel: "#triage", message: comment.body });
  }

  return { delivered: true, posted, mailed };
}
\`\`\``;

/** Delivery mode 1 needs the model to answer with a file, not with prose (10 §3). */
export const OUTPUT_FORMAT_PROMPT = `Answer with the **complete contents of one TypeScript flow file** and nothing else:
no explanation before or after, no markdown fences. Include the imports. If a step the
user asked for has no matching tool, still write the flow and leave a \`// TODO\` comment
rather than inventing a tool name.`;
