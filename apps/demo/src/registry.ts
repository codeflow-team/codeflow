/**
 * Demo registry — the example tools and the library function used throughout
 * the specs (01 §1, 05 §4). Core ships no tool of its own (00 §6.6b); every name
 * here belongs to the host app.
 *
 * `icon` names an entry in the UI layer's icon set (`REGISTRY_ICONS`); anything
 * it does not know — an emoji, a letter — is rendered verbatim instead, so a
 * host is never forced into this one set.
 */

import { createRegistry } from "@codeflow/core";

export const demoRegistry = createRegistry({
  tools: [
    {
      name: "github.getNewPRs",
      label: "Get New PRs",
      description: "Get new pull requests",
      icon: "git-pull-request",
      inputSchema: { repo: "string" },
      outputSchema: "PullRequest[]",
      editableFields: ["repo"],
    },
    {
      name: "github.getFiles",
      label: "Get PR Files",
      description: "Get files changed in a PR",
      icon: "file-diff",
      inputSchema: { pr: "PullRequest" },
      outputSchema: "File[]",
      editableFields: ["pr"],
    },
    {
      name: "slack.send",
      label: "Slack Send",
      description: "Send a Slack message",
      icon: "message-square",
      inputSchema: { channel: "string", message: "string" },
      editableFields: ["channel", { name: "message", editor: "expression" }],
    },
    {
      name: "payment.charge",
      label: "Charge Card",
      description: "Charge a card",
      icon: "credit-card",
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
      icon: "shield-check",
      inputSchema: { file: "File" },
      outputSchema: "boolean",
      code: `export function isAuthChange(file: File) {
  return /auth|login|oauth|permission/i.test(file.path);
}`,
      modulePath: "@flows/lib",
    },
  ],
});
