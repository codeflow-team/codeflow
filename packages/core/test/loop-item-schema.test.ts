/**
 * The item variable of a `for…of` gets the array's item schema — 03 §6.
 *
 * Without it the most useful thing to drag inside a loop (the current item's
 * own fields) has no shape at all, and the UI would have to re-derive it from
 * the graph — a second analyzer, which is the thing the scope table exists to
 * prevent. The rule is narrow on purpose: a bare identifier iterable with a
 * single writer whose declared output is a JSON-Schema array. Everything else
 * yields nothing rather than a guess (I6).
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow } from "../src/session.js";
import { createRegistry } from "../src/registry/index.js";
import type { ScopeBinding } from "../src/model/index.js";

const PR = {
  type: "object",
  properties: { title: { type: "string" }, number: { type: "number" } },
} as const;

const registry = createRegistry({
  tools: [
    { name: "gh.list", label: "List", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "array", items: PR } },
    { name: "gh.one", label: "One", inputSchema: { type: "object", properties: {} }, outputSchema: PR },
    { name: "slack.send", label: "Send", inputSchema: { type: "object", properties: { text: { type: "string" } } }, editableFields: ["text"] },
  ],
});

async function itemBinding(body: string, name: string): Promise<ScopeBinding | undefined> {
  const source = `export default async function flow(input: unknown, tools: any) {\n${body}\n}\n`;
  const session = createCodeFlow({ registry });
  const graph = await session.analyze(source, { file: "f.flow.ts" });
  const send = graph.nodes.find((n) => n.data.toolName === "slack.send")!;
  return graph.scopes[send.id].find((b) => b.name === name);
}

describe("loop item schema", () => {
  it("gives the item the array's item schema", async () => {
    const item = await itemBinding(
      `  const prs = await tools.gh.list({});\n  for (const pr of prs) {\n    await tools.slack.send({ text: "x" });\n  }`,
      "pr",
    );
    expect(item?.loopItem).toBe(true);
    expect(item?.schema).toEqual(PR);
  });

  it("gives a destructured name that property's schema, not the whole item", async () => {
    const title = await itemBinding(
      `  const prs = await tools.gh.list({});\n  for (const { title } of prs) {\n    await tools.slack.send({ text: "x" });\n  }`,
      "title",
    );
    expect(title?.schema).toEqual({ type: "string" });
  });

  it("says nothing when the iterable is a call, not a binding", async () => {
    const item = await itemBinding(
      `  const prs = await tools.gh.list({});\n  for (const pr of prs.slice(0, 2)) {\n    await tools.slack.send({ text: "x" });\n  }`,
      "pr",
    );
    expect(item?.loopItem).toBe(true);
    expect(item?.schema).toBeUndefined();
  });

  it("says nothing when the binding's declared output is not an array", async () => {
    const item = await itemBinding(
      `  const pr = await tools.gh.one({});\n  for (const key of pr) {\n    await tools.slack.send({ text: "x" });\n  }`,
      "key",
    );
    expect(item?.schema).toBeUndefined();
  });

  it("says nothing when two writers could hold two different shapes", async () => {
    const item = await itemBinding(
      `  let prs = await tools.gh.list({});\n  prs = [];\n  for (const pr of prs) {\n    await tools.slack.send({ text: "x" });\n  }`,
      "pr",
    );
    expect(item?.schema).toBeUndefined();
  });

  it("lets the drag it enables actually go through", async () => {
    const source = `export default async function flow(input: unknown, tools: any) {
  const prs = await tools.gh.list({});
  for (const pr of prs) {
    await tools.slack.send({ text: "x" });
  }
}
`;
    const session = createCodeFlow({ registry });
    const graph = await session.analyze(source, { file: "f.flow.ts" });
    const send = graph.nodes.find((n) => n.data.toolName === "slack.send")!;
    const result = await session.patchNode(send.id, { text: { kind: "expression", text: "pr.title" } });
    expect(result.source).toContain("text: pr.title");
  });
});
