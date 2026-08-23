/** Inspector model — 06-patch-engine.md §1. */

import { describe, expect, it } from "vitest";
import { createRegistry } from "@codeflow/core";
import { resolveInspectorFields } from "../src/inspector/fields.js";
import { canonicalGraph, node, tryGraph } from "./fixtures.js";

function registry() {
  return createRegistry({
    tools: [
      {
        name: "slack.send",
        label: "Slack Send",
        icon: "💬",
        inputSchema: { channel: "string", message: "string" },
        editableFields: ["channel", { name: "message", editor: "expression" }],
      },
    ],
  });
}

describe("resolveInspectorFields", () => {
  it("renders registry editable fields with `{{ }}` display values", () => {
    const slack = canonicalGraph().nodes.find((n) => n.id === "n_slack");
    const model = resolveInspectorFields(slack!, registry());

    expect(model.fields.map((f) => f.name)).toEqual(["channel", "message"]);
    expect(model.fields[0]).toMatchObject({ display: { text: "#security" }, editor: "text", declaredEditable: true });
    expect(model.fields[1]).toMatchObject({ display: { text: "Security PR: {{ pr.title }}" }, editor: "expression" });
    expect(model.fields[0].schema).toBe("string");
    expect(model.notice).toBeNull();
  });

  it("falls back to the argument keys when there is no registry", () => {
    const slack = canonicalGraph().nodes.find((n) => n.id === "n_slack");
    const model = resolveInspectorFields(slack!, null);
    expect(model.fields.map((f) => f.name)).toEqual(["channel", "message"]);
  });

  it("explains why fields are not editable when the argument is a variable (06 §1)", () => {
    const alert = tryGraph().nodes.find((n) => n.id === "n_alert");
    const model = resolveInspectorFields(alert!, null);
    expect(model.notice).toContain("not a visible object literal");
    for (const field of model.fields) expect(field.blockedReason).not.toBeNull();
  });

  it("refuses field edits on an unresolved call, even when its argument is a literal (03 §11)", () => {
    const unresolved = node({
      id: "n",
      type: "unknown",
      label: "github.getAuditLog",
      path: "flow/call:github.getAuditLog[0]",
      data: {
        toolName: "github.getAuditLog",
        resolved: false,
        arguments: { repo: "input.repository" },
        argumentsEditable: true,
        argumentsHaveSpread: false,
      },
    });
    const model = resolveInspectorFields(unresolved, registry());
    expect(model.notice).toContain("does not resolve to a tool in the registry");
    for (const field of model.fields) {
      expect(field.blockedReason).not.toBeNull();
      expect(field.patch).toBeNull();
    }
    // …but it can still be pointed at a real tool, or edited as code (06 §2).
    expect(model.toolChange).not.toBeNull();
    expect(model.codeEdit).toEqual({ kind: "region", label: "Edit statement as code" });
  });

  it("warns about spreads without offering to override hidden values (06 §1)", () => {
    const spread = node({
      id: "n",
      type: "tool",
      label: "Slack Send",
      path: "flow/call:slack.send[0]",
      data: {
        toolName: "slack.send",
        arguments: { channel: '"#a"' },
        argumentsEditable: true,
        argumentsHaveSpread: true,
      },
    });
    const model = resolveInspectorFields(spread, registry());
    expect(model.notice).toContain("spread");
  });

  it("flags a declared field the call does not set as needing configuration", () => {
    const partial = node({
      id: "n",
      type: "tool",
      label: "Slack Send",
      path: "flow/call:slack.send[0]",
      data: { toolName: "slack.send", arguments: { channel: '"#a"' }, argumentsEditable: true, argumentsHaveSpread: false },
    });
    const model = resolveInspectorFields(partial, registry());
    const message = model.fields.find((f) => f.name === "message");
    expect(message?.missing).toBe(true);
    expect(message?.raw).toBeNull();
  });

  it("does not call an optional property that the call omits 'needing a value'", () => {
    // Real shape, from the filesystem MCP server: `path` is required, `head`
    // and `tail` are not. Marking an optional field red is the same kind of
    // untruth as passing a wrong one silently (07 §5).
    const optional = createRegistry({
      tools: [
        {
          name: "fs.readTextFile",
          label: "Read Text File",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, head: { type: "number" }, tail: { type: "number" } },
            required: ["path"],
          },
          editableFields: ["path", "head", "tail"],
        },
      ],
    });
    const call = node({
      id: "n",
      type: "tool",
      label: "Read Text File",
      path: "flow/call:fs.readTextFile[0]",
      data: {
        toolName: "fs.readTextFile",
        arguments: { path: '"a.txt"' },
        argumentsEditable: true,
        argumentsHaveSpread: false,
      },
    });

    const model = resolveInspectorFields(call, optional);
    expect(model.fields.find((f) => f.name === "head")?.missing).toBe(false);
    expect(model.fields.find((f) => f.name === "tail")?.missing).toBe(false);
    expect(model.fields.find((f) => f.name === "path")?.raw).toBe('"a.txt"');
  });

  it("still calls a required property that the call omits 'needing a value'", () => {
    const strict = createRegistry({
      tools: [
        {
          name: "fs.readTextFile",
          label: "Read Text File",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, head: { type: "number" } },
            required: ["path", "head"],
          },
          editableFields: ["path", "head"],
        },
      ],
    });
    const call = node({
      id: "n",
      type: "tool",
      label: "Read Text File",
      path: "flow/call:fs.readTextFile[0]",
      data: {
        toolName: "fs.readTextFile",
        arguments: { path: '"a.txt"' },
        argumentsEditable: true,
        argumentsHaveSpread: false,
      },
    });

    expect(resolveInspectorFields(call, strict).fields.find((f) => f.name === "head")?.missing).toBe(true);
  });

  it("exposes the one editable expression of a condition and of a for…of loop", () => {
    const graph = canonicalGraph();
    const condition = resolveInspectorFields(graph.nodes.find((n) => n.id === "n_condition")!);
    expect(condition.fields[0]).toMatchObject({ name: "expression", editor: "expression" });
    expect(condition.fields[0].display.text).toBe("{{ files.some(isAuthChange) }}");

    const loop = resolveInspectorFields(graph.nodes.find((n) => n.id === "n_loop")!);
    expect(loop.fields.map((f) => f.name)).toEqual(["variable", "iterable"]);
  });

  it("says a synthetic output is not editable (03 §4)", () => {
    const output = canonicalGraph().nodes.find((n) => n.id === "n_output");
    expect(resolveInspectorFields(output!).notice).toContain("Synthetic output");
  });
});
