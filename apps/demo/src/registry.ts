/**
 * Demo registry — the example tools and the library function used throughout
 * the specs (01 §1, 05 §4). Core ships no tool of its own (00 §6.6b); every name
 * here belongs to the host app.
 */

import { createRegistry } from "@codeflow/core";

export const demoRegistry = createRegistry({
  tools: [
    {
      name: "github.getNewPRs",
      label: "Get New PRs",
      description: "Get new pull requests",
      icon: "🐙",
      inputSchema: { repo: "string" },
      outputSchema: "PullRequest[]",
      editableFields: ["repo"],
    },
    {
      name: "github.getFiles",
      label: "Get PR Files",
      description: "Get files changed in a PR",
      icon: "🐙",
      inputSchema: { pr: "PullRequest" },
      outputSchema: "File[]",
      editableFields: ["pr"],
    },
    {
      name: "slack.send",
      label: "Slack Send",
      description: "Send a Slack message",
      icon: "💬",
      inputSchema: { channel: "string", message: "string" },
      editableFields: ["channel", { name: "message", editor: "expression" }],
    },
    {
      name: "payment.charge",
      label: "Charge Card",
      description: "Charge a card",
      icon: "💳",
      inputSchema: { amount: "number" },
      outputSchema: "Charge",
      editableFields: ["amount"],
    },
  ],
  functions: [
    {
      // Per-file predicate, so it can be used directly as a callback:
      // `files.some(isAuthChange)` — 05 §4, sugar rule 04 §2.2b.
      name: "isAuthChange",
      label: "Is Auth Change",
      description: "True when a changed file touches auth-related code",
      icon: "🔐",
      inputSchema: { file: "File" },
      outputSchema: "boolean",
      code: `export function isAuthChange(file: File) {
  return /auth|login|oauth|permission/i.test(file.path);
}`,
      modulePath: "@flows/lib",
    },
  ],
});
