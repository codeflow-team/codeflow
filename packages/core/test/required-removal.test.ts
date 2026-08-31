/**
 * Removing a field warns only when the schema says it is required — 06 §3.
 *
 * The warning used to fire for *any* schema-known field, so clearing an
 * optional `head` on a filesystem tool announced "the node needs configuration
 * before the flow runs" about an edit that was entirely correct. A warning that
 * cries on a correct edit is one people learn to skip past, and then it is not
 * there for the one that matters (07 §5).
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow } from "../src/session.js";
import { createRegistry } from "../src/registry/index.js";
import { fieldRequiredness } from "../src/registry/validate.js";

const registry = createRegistry({
  tools: [
    {
      name: "fs.readTextFile",
      label: "Read Text File",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, head: { type: "number" } },
        required: ["path"],
      },
      outputSchema: { type: "object", properties: { content: { type: "string" } } },
      editableFields: ["path", "head"],
    },
  ],
});

const SRC = `export default async function flow(input: { path: string }, tools: any) {
  const file = await tools.fs.readTextFile({ path: input.path, head: 50 });
  return file;
}
`;

async function removeField(name: string) {
  const session = createCodeFlow({ registry });
  const graph = await session.analyze(SRC, { file: "f.flow.ts" });
  const node = graph.nodes.find((n) => n.data.toolName === "fs.readTextFile")!;
  return session.patchNode(node.id, { [name]: { kind: "remove" } });
}

describe("removing a field", () => {
  it("says nothing when the removed field is optional", async () => {
    const result = await removeField("head");
    expect(result.source).not.toContain("head");
    expect(result.diagnostics.filter((d) => d.code === "needs-configuration")).toEqual([]);
  });

  it("warns, and names the tool, when the removed field is required", async () => {
    const result = await removeField("path");
    const warning = result.diagnostics.find((d) => d.code === "needs-configuration");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("`path` is required by \"Read Text File\"");
  });

  it("warns differently when the schema never says what is required", async () => {
    // A named-fields registry declares no requiredness at all. Silence there
    // would hide the removal of a property the call cannot work without.
    const namedFields = createRegistry({
      tools: [{ name: "slack.send", label: "Slack Send", inputSchema: { channel: "string", message: "string" }, editableFields: ["channel", "message"] }],
    });
    const session = createCodeFlow({ registry: namedFields });
    const src = `export default async function flow(input: unknown, tools: any) {\n  await tools.slack.send({ channel: "#a", message: "b" });\n}\n`;
    const graph = await session.analyze(src, { file: "f.flow.ts" });
    const node = graph.nodes.find((n) => n.data.toolName === "slack.send")!;
    const result = await session.patchNode(node.id, { channel: { kind: "remove" } });
    const warning = result.diagnostics.find((d) => d.code === "needs-configuration");
    expect(warning?.message).toContain("does not declare which of its inputs are required");
    // …and it must not claim the field was required, because nothing said so.
    expect(warning?.message).not.toContain("is required by");
  });

  it("reads requiredness as three answers, not two", () => {
    const json = { type: "object", properties: { a: {}, b: {} }, required: ["a"] };
    expect(fieldRequiredness(json, "a")).toBe("required");
    expect(fieldRequiredness(json, "b")).toBe("optional");
    // "says nothing" is its own answer — never folded into either of the others.
    expect(fieldRequiredness({ a: "string" }, "a")).toBe("unknown");
    expect(fieldRequiredness("File[]", "a")).toBe("unknown");
    expect(fieldRequiredness({ type: "object", properties: { a: {} } }, "a")).toBe("unknown");
  });
});
