/**
 * Scaffold contents for `codeflow init` — the standard workspace layout of
 * 10-ai-codegen.md §2.
 *
 * The sample tools are `github.*` / `slack.*` because that is the running example
 * throughout the specs (01 §1, 07 §6). They are examples and nothing more: core
 * ships no tool of its own (design principle 6b), every tool here is workspace
 * data the owner can delete.
 *
 * Their schemas are written as inline JSON Schema rather than TS type references
 * so the generated `tools.d.ts` is self-contained — a `PullRequest[]` ref would
 * emit a `.d.ts` naming a type that exists nowhere in the workspace.
 */

import type { FunctionDefinition } from "@codeflow/core";

export const CONFIG_TEMPLATE = `// CodeFlow workspace config. The CLI runs this file as a build script (like
// vite.config.ts) to learn which tools exist; \`codeflow generate\` turns the
// result into generated/tools.d.ts and generated/lib.d.ts.
//
// It is deliberately dependency-free so a fresh workspace type-checks on its own.
// Once @codeflow/cli is installed, type it for editor support:
//   import type { CodeflowConfig } from "@codeflow/cli";
//   const config: CodeflowConfig = { … };

// Shared shapes, referenced by several tools below.
const pullRequest = {
  type: "object",
  properties: {
    number: { type: "number" },
    title: { type: "string" },
    author: { type: "string" },
    url: { type: "string" },
  },
  required: ["number", "title", "author"],
};

const changedFile = {
  type: "object",
  properties: {
    path: { type: "string" },
    additions: { type: "number" },
    deletions: { type: "number" },
  },
  required: ["path"],
};

const config = {
  tools: [
    {
      name: "github.getNewPRs",
      label: "Get New PRs",
      description: "Get new pull requests for a repository",
      inputSchema: { repo: "string" },
      outputSchema: { type: "array", items: pullRequest },
      editableFields: ["repo"],
    },
    {
      name: "github.getFiles",
      label: "Get PR Files",
      description: "Get the files changed in a pull request",
      inputSchema: { pr: pullRequest },
      outputSchema: { type: "array", items: changedFile },
    },
    {
      name: "slack.send",
      label: "Send Slack Message",
      description: "Send a message to a Slack channel",
      inputSchema: { channel: "string", message: "string" },
      editableFields: ["channel", "message"],
    },
  ],
};

export default config;
`;

/**
 * `moduleResolution: "bundler"` on purpose: the flow contract writes
 * `import type { Tools } from "../generated/tools"` without a file extension
 * (01-flow-contract.md §1), which `node16`/`nodenext` would reject. Flow files are
 * never compiled by tsc anyway — they are analyzed, and executed by a sandbox
 * runtime — so this config exists to type-check and to resolve `@flows/lib` to the
 * real source in `lib/` (05-registry.md §4).
 */
export const TSCONFIG_TEMPLATE = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": {
      "@flows/lib": ["./lib/index.ts"]
    }
  },
  "include": ["flows", "lib", "generated", "codeflow.config.ts"]
}
`;

export function packageJsonTemplate(name: string): string {
  return `{
  "name": ${JSON.stringify(name)},
  "private": true,
  "type": "module"
}
`;
}

/**
 * The sample library function of 05-registry.md §4. Written through the store, so
 * its metadata header is produced by the same code path as any other save.
 */
// Per-file predicate so it can be used directly as a callback:
// `files.some(isAuthChange)` — canonical example (01 §1) and label sugar (04 §2.2b).
export const SAMPLE_FUNCTION: FunctionDefinition = {
  name: "isAuthChange",
  label: "Is Auth Change",
  description: "True when a changed file touches authentication code",
  inputSchema: { file: "{ path: string }" },
  outputSchema: "boolean",
  code: `export function isAuthChange(file: { path: string }): boolean {
  return /auth|login|oauth|permission/i.test(file.path);
}
`,
  modulePath: "@flows/lib",
};

export const FLOWS_README = `# flows/

One flow per file, named \`<name>.flow.ts\`, each with a single default export:

\`\`\`ts
import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  // …
}
\`\`\`

See \`../prompts/flow-style.md\` for the full style guide, and \`../generated/tools.d.ts\`
for the tools this workspace has.
`;
