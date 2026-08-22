/**
 * The editing path of the inspector — 06 §3 (display syntax, form-relative
 * edits) and §2 (which operation a field maps to).
 *
 * The last block runs the encodings through the real patch engine: what the UI
 * builds has to come out of `patchNode` as the one-line diff 06 §4 draws, or the
 * encoding is wrong no matter how nice it looks in isolation.
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow, createRegistry, type WorkflowGraph } from "@codeflow/core";
import {
  changesFor,
  editorSpecFor,
  encodeAsTemplate,
  encodeFieldValue,
  hasInterpolation,
  templateBodyFromDisplay,
} from "../src/inspector/edit.js";
import { resolveInspectorFields, type InspectorField } from "../src/inspector/fields.js";
import { localFunctionBody } from "../src/code/region.js";
import { canonicalGraph } from "./fixtures.js";

function registry() {
  return createRegistry({
    tools: [
      { name: "github.getNewPRs", label: "Get New PRs", icon: "🐙", inputSchema: { repo: "string" }, outputSchema: "PullRequest[]", editableFields: ["repo"] },
      { name: "github.getFiles", label: "Get PR Files", icon: "🐙", inputSchema: { pr: "PullRequest" }, outputSchema: "File[]", editableFields: ["pr"] },
      {
        name: "slack.send",
        label: "Slack Send",
        icon: "💬",
        inputSchema: { channel: "string", message: "string" },
        editableFields: ["channel", { name: "message", editor: "expression" }],
      },
    ],
    functions: [
      {
        name: "isAuthChange",
        label: "Is Auth Change",
        icon: "🔐",
        inputSchema: { file: "File" },
        outputSchema: "boolean",
        code: "export function isAuthChange(file: File) {\n  return /auth/i.test(file.path);\n}",
        modulePath: "@flows/lib",
      },
    ],
  });
}

const SOURCE = `import type { Tools } from "../generated/tools";
import { isAuthChange } from "@flows/lib";

export default async function flow(input: { repository: string }, tools: Tools) {
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
`;

function fieldOf(node: Parameters<typeof resolveInspectorFields>[0], name: string, lookup = registry()): InspectorField {
  const field = resolveInspectorFields(node, lookup).fields.find((candidate) => candidate.name === name);
  if (field === undefined) throw new Error(`no field ${name}`);
  return field;
}

/* -------------------------------------------------------------------------- */
/* display → template body (06 §3)                                             */
/* -------------------------------------------------------------------------- */

describe("templateBodyFromDisplay", () => {
  it("turns each `{{ expr }}` back into one `${expr}`", () => {
    expect(templateBodyFromDisplay("Security PR: {{ pr.title }}")).toBe("Security PR: ${pr.title}");
    expect(templateBodyFromDisplay("{{ a }} and {{ b.c }}")).toBe("${a} and ${b.c}");
  });

  it("round-trips the canonical message unchanged", () => {
    const message = fieldOf(canonicalGraph().nodes.find((n) => n.id === "n_slack")!, "message");
    expect(message.display.text).toBe("Security PR: {{ pr.title }}");
    expect(`\`${templateBodyFromDisplay(message.display.text)}\``).toBe(message.raw);
  });

  it("escapes what would otherwise be template syntax in the literal parts", () => {
    expect(templateBodyFromDisplay("cost: $100")).toBe("cost: $100");
    expect(templateBodyFromDisplay("literal ${notAnInterpolation}")).toBe("literal \\${notAnInterpolation}");
    expect(templateBodyFromDisplay("a `quoted` word")).toBe("a \\`quoted\\` word");
    expect(templateBodyFromDisplay("back\\slash")).toBe("back\\\\slash");
  });

  it("leaves an unclosed `{{` alone rather than inventing an interpolation", () => {
    expect(templateBodyFromDisplay("half {{ open")).toBe("half {{ open");
  });

  it("detects interpolations for the explicit string → template prompt", () => {
    expect(hasInterpolation("plain")).toBe(false);
    expect(hasInterpolation("hi {{ name }}")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* editor choice follows the current form (06 §3)                              */
/* -------------------------------------------------------------------------- */

describe("editorSpecFor", () => {
  const graph = canonicalGraph();
  const slack = graph.nodes.find((n) => n.id === "n_slack")!;

  it("gives a string literal a plain text box holding the unquoted text", () => {
    expect(editorSpecFor(fieldOf(slack, "channel"))).toMatchObject({ kind: "text", value: "#security" });
  });

  it("gives a template the friendly `{{ }}` text, not the raw source", () => {
    expect(editorSpecFor(fieldOf(slack, "message"))).toMatchObject({
      kind: "template",
      value: "Security PR: {{ pr.title }}",
    });
  });

  it("gives a bare expression the expression source without the display wrapper", () => {
    const files = graph.nodes.find((n) => n.id === "n_getFiles")!;
    expect(editorSpecFor(fieldOf(files, "pr"))).toMatchObject({ kind: "expression", value: "pr" });
  });

  it("falls back to code when the friendly form would be ambiguous (06 §3)", () => {
    const field: InspectorField = {
      name: "channel",
      label: "Channel",
      editor: "text",
      raw: '"{{ literal }}"',
      display: { kind: "string", text: "{{ literal }}", friendly: false, raw: '"{{ literal }}"' },
      declaredEditable: true,
      blockedReason: null,
      missing: false,
      patch: "field",
    };
    expect(editorSpecFor(field)).toMatchObject({ kind: "code", value: '"{{ literal }}"' });
  });

  it("uses the schema type for a field the call does not set", () => {
    const missing: InspectorField = {
      name: "amount",
      label: "Amount",
      editor: "text",
      raw: null,
      display: { kind: "empty", text: "", friendly: true, raw: "" },
      schema: "number",
      declaredEditable: true,
      blockedReason: null,
      missing: true,
      patch: "field",
    };
    expect(editorSpecFor(missing).kind).toBe("number");
  });
});

/* -------------------------------------------------------------------------- */
/* encoding (06 §3 table)                                                      */
/* -------------------------------------------------------------------------- */

describe("encodeFieldValue", () => {
  it("sends a bare string for a text box — the patcher writes it in the original form", () => {
    expect(encodeFieldValue("text", "#engineering")).toEqual({ ok: true, value: "#engineering" });
  });

  it("sends numbers and booleans as their own literals", () => {
    expect(encodeFieldValue("number", "42")).toEqual({ ok: true, value: 42 });
    expect(encodeFieldValue("checkbox", "", true)).toEqual({ ok: true, value: true });
  });

  it("refuses a number that is not one instead of writing something else", () => {
    const result = encodeFieldValue("number", "twelve");
    expect(result.ok).toBe(false);
  });

  it("clears a field with `{ kind: \"remove\" }` — needs-configuration, not an empty value", () => {
    expect(encodeFieldValue("number", "  ")).toEqual({ ok: true, value: { kind: "remove" } });
    expect(encodeFieldValue("expression", "")).toEqual({ ok: true, value: { kind: "remove" } });
  });

  it("sends expressions and code verbatim", () => {
    expect(encodeFieldValue("expression", " pr.title ")).toEqual({
      ok: true,
      value: { kind: "expression", text: "pr.title" },
    });
    expect(encodeFieldValue("code", '"{{ x }}"')).toEqual({
      ok: true,
      value: { kind: "expression", text: '"{{ x }}"' },
    });
  });

  it("sends a template as its body, interpolations included", () => {
    expect(encodeFieldValue("template", "Security PR: {{ pr.title }}")).toEqual({
      ok: true,
      value: { kind: "template", text: "Security PR: ${pr.title}" },
    });
  });

  it("only promotes a string to a template when asked explicitly (06 §3)", () => {
    expect(encodeFieldValue("text", "hi {{ name }}")).toEqual({ ok: true, value: "hi {{ name }}" });
    expect(encodeAsTemplate("hi {{ name }}")).toEqual({ kind: "template", text: "hi ${name}" });
  });
});

describe("changesFor", () => {
  const graph = canonicalGraph();

  it("puts an argument field in flat, the way 06 §4 shows", () => {
    const channel = fieldOf(graph.nodes.find((n) => n.id === "n_slack")!, "channel");
    expect(changesFor(channel, "#security-team")).toEqual({ channel: "#security-team" });
  });

  it("routes a condition and an iterable to their operations", () => {
    const condition = fieldOf(graph.nodes.find((n) => n.id === "n_condition")!, "expression");
    expect(changesFor(condition, { kind: "expression", text: "files.length > 0" })).toEqual({
      $condition: "files.length > 0",
    });

    const iterable = fieldOf(graph.nodes.find((n) => n.id === "n_loop")!, "iterable");
    expect(changesFor(iterable, { kind: "expression", text: "prs.slice(0, 5)" })).toEqual({
      $iterable: "prs.slice(0, 5)",
    });
  });

  it("marks the fields the patch engine has no edit for (07 §5)", () => {
    const variable = fieldOf(graph.nodes.find((n) => n.id === "n_loop")!, "variable");
    expect(variable.patch).toBeNull();
    expect(variable.blockedReason).toContain("structural edit");
  });
});

/* -------------------------------------------------------------------------- */
/* the encodings through the real patch engine (06 §4, I3)                     */
/* -------------------------------------------------------------------------- */

describe("UI encoding → patchNode", () => {
  async function analyzed(): Promise<{ session: ReturnType<typeof createCodeFlow>; graph: WorkflowGraph }> {
    const session = createCodeFlow({ registry: registry() });
    const graph = await session.analyze(SOURCE, { file: "flow.ts" });
    return { session, graph };
  }

  it("changes the channel with a one-line diff and no other byte moving (08 §4)", async () => {
    const { session, graph } = await analyzed();
    const slack = graph.nodes.find((node) => node.data["toolName"] === "slack.send")!;
    const field = fieldOf(slack, "channel");
    const encoded = encodeFieldValue(editorSpecFor(field).kind, "#security-team");
    expect(encoded.ok).toBe(true);

    const result = await session.patchNode(slack.id, changesFor(field, encoded.ok ? encoded.value : ""));

    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].oldText).toBe('"#security"');
    expect(result.patches[0].newText).toBe('"#security-team"');
    expect(result.source).toBe(SOURCE.replace('"#security"', '"#security-team"'));
    // Identity is carried by patch provenance (03 §5.2 step 0).
    for (const before of graph.nodes) {
      expect(result.graph.nodes.some((after) => after.id === before.id)).toBe(true);
    }
  });

  it("edits the text around an interpolation and keeps the template a template", async () => {
    const { session, graph } = await analyzed();
    const slack = graph.nodes.find((node) => node.data["toolName"] === "slack.send")!;
    const field = fieldOf(slack, "message");
    const spec = editorSpecFor(field);
    expect(spec.kind).toBe("template");

    const encoded = encodeFieldValue(spec.kind, "Security PR (auth): {{ pr.title }}");
    const result = await session.patchNode(slack.id, changesFor(field, encoded.ok ? encoded.value : ""));

    expect(result.source).toContain("`Security PR (auth): ${pr.title}`");
    expect(result.patches).toHaveLength(1);
  });

  it("re-sending the same display text is an empty edit — not one byte (I4)", async () => {
    const { session, graph } = await analyzed();
    const slack = graph.nodes.find((node) => node.data["toolName"] === "slack.send")!;
    const field = fieldOf(slack, "message");
    const spec = editorSpecFor(field);
    const encoded = encodeFieldValue(spec.kind, spec.value);

    const result = await session.patchNode(slack.id, changesFor(field, encoded.ok ? encoded.value : ""));
    expect(result.patches).toHaveLength(0);
    expect(result.source).toBe(SOURCE);
  });

  it("routes a condition edit through `$condition`", async () => {
    const { session, graph } = await analyzed();
    const condition = graph.nodes.find((node) => node.type === "condition")!;
    const field = fieldOf(condition, "expression");
    const result = await session.patchNode(condition.id, changesFor(field, { kind: "expression", text: "files.length > 0" }));
    expect(result.source).toContain("if (files.length > 0)");
  });

  it("refuses to delete a node whose binding is still read, naming the reader (06 §2)", async () => {
    const { session, graph } = await analyzed();
    const getFiles = graph.nodes.find((node) => node.data["toolName"] === "github.getFiles")!;
    await expect(session.patchNode(getFiles.id, { $delete: true })).rejects.toMatchObject({
      code: "patch-dependency",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* opaque regions                                                              */
/* -------------------------------------------------------------------------- */

describe("localFunctionBody", () => {
  const source = `function normalize(value: { a: string }): string {
  const trimmed = value.a.trim();
  if (trimmed === "}") return "brace";
  return \`\${trimmed}!\`;
}

export default async function flow() {}
`;

  it("returns the body of a local function, braces excluded", () => {
    const body = localFunctionBody(source, "normalize");
    expect(body).not.toBeNull();
    expect(body).toContain("const trimmed");
    expect(body).toContain("return `${trimmed}!`;");
    expect(body?.trimEnd().endsWith(";")).toBe(true);
  });

  it("is not fooled by a brace inside a string", () => {
    expect(localFunctionBody(source, "normalize")).toContain('=== "}"');
  });

  it("says nothing rather than guessing when there is no such declaration", () => {
    expect(localFunctionBody(source, "missing")).toBeNull();
  });
});
