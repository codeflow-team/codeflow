/**
 * Sample registry used by the codegen tests — the github/slack example the specs
 * use throughout (01 §1, 05 §2, 07 §6). Tool names here are examples only: core
 * ships no tools (design principle 6b).
 */

import { createRegistry, type Registry } from "../src/registry/index.js";

export function createSampleRegistry(): Registry {
  const registry = createRegistry();

  registry.registerTool({
    name: "github.getNewPRs",
    label: "Get New PRs",
    description: "Get new pull requests",
    icon: "🐙",
    inputSchema: { repo: "string" },
    outputSchema: "PullRequest[]",
    editableFields: ["repo"],
  });

  registry.registerTool({
    name: "github.getFiles",
    label: "Get PR Files",
    description: "Get files changed in a PR",
    icon: "🐙",
    inputSchema: { pr: "PullRequest" },
    outputSchema: "File[]",
    editableFields: ["pr"],
  });

  registry.registerTool({
    name: "slack.send",
    label: "Slack Send",
    description: "Send a Slack message",
    icon: "💬",
    inputSchema: { channel: "string", message: "string" },
    editableFields: ["channel", { name: "message", editor: "expression" }],
  });

  registry.registerFunction({
    name: "isAuthChange",
    label: "Is Auth Change",
    inputSchema: { files: "File[]" },
    outputSchema: "boolean",
    code: `export function isAuthChange(files: File[]) {
  return files.some(f => /auth|login|oauth|permission/i.test(f.path));
}`,
    modulePath: "@flows/lib",
  });

  return registry;
}

export const HEADER_HASH_LINE = /^\/\/ registryHash: ([0-9a-f]{64})$/m;
