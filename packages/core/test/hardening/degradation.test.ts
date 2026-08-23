/**
 * Where the library gives up, and what it says when it does.
 *
 * I6 is not "handle everything" — it is "when you are not sure, show a `code`
 * or `unknown` node with a diagnostic, and never a node that means something
 * else". The tests here walk the edge of what the analyzer recognises and pin
 * which side each construct falls on, because the dangerous drift is *inwards*:
 * a future change that starts recognising `tools["slack"].send` by string, or
 * rewriting a call reached through an alias, buys a feature by breaking the one
 * promise the product rests on.
 */

import { describe, expect, it } from "vitest";

import { createRegistry } from "../../src/registry/index.js";
import { diagnosticsOf, flowSource, nodeAt, open, pathsOfType, refusal, toolNode } from "./helpers.js";

/* -------------------------------------------------------------------------- */
/* constructs that are simply not modelled                                     */
/* -------------------------------------------------------------------------- */

describe("unmodelled constructs become code nodes, never something else", () => {
  it("`switch` — no branch node is invented", async () => {
    const { graph } = await open(
      flowSource(
        `  switch (input.repository) {
    case "a":
      await tools.slack.send({ channel: "#a", message: "m" });
      break;
    default:
      await tools.slack.send({ channel: "#d", message: "m" });
  }`,
      ),
    );
    expect(pathsOfType(graph, "condition")).toEqual([]);
    expect(pathsOfType(graph, "code")).toEqual(["flow/stmt[0]"]);
    // The two calls are inside the opaque region — the diagnostics are the only
    // trace they exist, so there must be one per call (I1).
    expect(diagnosticsOf(graph, "hidden-call-in-expression")).toHaveLength(2);
  });

  it("a tool call inside a nested arrow function", async () => {
    const { graph } = await open(
      flowSource(
        `  const fn = async () => { await tools.slack.send({ channel: "#a", message: "m" }); };
  await fn();`,
      ),
    );
    expect(pathsOfType(graph, "tool")).toEqual([]);
    expect(diagnosticsOf(graph, "hidden-call-in-expression")).toHaveLength(1);
  });

  it("`throw`, `debugger` and a dynamic import all survive as opaque code", async () => {
    const { graph } = await open(
      flowSource(
        `  if (input.repository === "") throw new Error("no repo");
  debugger;
  const mod = await import("node:path");
  await tools.slack.send({ channel: "#a", message: String(mod) });`,
      ),
    );
    expect(graph.diagnostics.every((diagnostic) => diagnostic.severity !== "error")).toBe(true);
    expect(nodeAt(graph, "flow/call:slack.send[0]").type).toBe("tool");
  });

  it("two declarators in one statement degrade rather than being split", async () => {
    // `const a = 1, b = 2;` is one statement binding two names. Splitting it
    // into two nodes would break the 1:1 statement↔node projection (04 §1.1).
    const { graph } = await open(
      flowSource(
        `  const a = 1, b = 2;
  await tools.slack.send({ channel: "#a", message: String(a + b) });`,
      ),
    );
    expect(pathsOfType(graph, "code")).toEqual(["flow/stmt[0]"]);
  });

  it("a unicode identifier is a name like any other", async () => {
    const { graph } = await open(
      flowSource(
        `  const café = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#a", message: String(café.length) });`,
      ),
    );
    expect(
      graph.edges.some((edge) => edge.kind === "data" && edge.label === "café.length"),
    ).toBe(true);
  });

  it("keeps a ten-deep nest without flattening or losing a level", async () => {
    let body = `  await tools.slack.send({ channel: "#a", message: "m" });`;
    for (let depth = 0; depth < 10; depth++) {
      body = `  for (const x${String(depth)} of [1]) {\n${body}\n  }`;
    }
    const { graph } = await open(flowSource(body));
    expect(pathsOfType(graph, "loop")).toHaveLength(10);
    const send = toolNode(graph, "slack.send");
    expect(send.source.semanticPath.split("/for[0]")).toHaveLength(11);
  });
});

/* -------------------------------------------------------------------------- */
/* how `tools` may be reached                                                  */
/* -------------------------------------------------------------------------- */

describe("`tools` reached in a way the patcher cannot rewrite", () => {
  it("does not resolve `tools[\"slack\"].send` — a computed member is not a path", async () => {
    const { graph } = await open(
      flowSource(
        `  await tools["slack"].send({ channel: "#a", message: "m" });
  await tools.slack["send"]({ channel: "#b", message: "m" });`,
      ),
    );
    // Recognising these would mean deciding what a computed key evaluates to.
    // The next step down that road is `tools.slack[k]`, and there is no bottom.
    expect(pathsOfType(graph, "tool")).toEqual([]);
    expect(pathsOfType(graph, "code")).toEqual(["flow/stmt[0..1]"]);
  });

  it("resolves a whole-root alias and lets its tool be changed", async () => {
    const source = flowSource(
      `  const t = tools;
  await t.slack.send({ channel: "#a", message: "m" });`,
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(toolNode(graph, "slack.send").id, {
      $tool: "github.getNewPRs",
    });
    // `t` stands for the whole `tools` object, so the text after it *is* the
    // tool path and rewriting it is exact.
    expect(result.source).toContain("await t.github.getNewPRs(");
  });

  it("refuses to change the tool of a call reached through a namespace alias", async () => {
    const source = flowSource(
      `  const gh = tools.github;
  const files = await gh.getFiles({ pr: input.repository });
  return files;`,
    );
    const { session, graph } = await open(source);
    expect(toolNode(graph, "github.getFiles").type).toBe("tool");
    const error = await refusal(
      session.patchNode(toolNode(graph, "github.getFiles").id, { $tool: "slack.send" }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("alias");
    expect(graph.source.content).toBe(source);
  });

  it("refuses the same through a destructured namespace alias", async () => {
    const { session, graph } = await open(
      flowSource(
        `  const { github } = tools;
  const files = await github.getFiles({ pr: input.repository });
  return files;`,
      ),
    );
    const error = await refusal(
      session.patchNode(toolNode(graph, "github.getFiles").id, { $tool: "slack.send" }),
    );
    expect(error.code).toBe("patch-unsupported");
  });

  it("still edits the argument fields of an aliased call — only the path is off limits", async () => {
    const source = flowSource(
      `  const gh = tools.github;
  const files = await gh.getFiles({ pr: "old" });
  return files;`,
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(toolNode(graph, "github.getFiles").id, { pr: "new" });
    expect(result.source).toBe(source.replace('"old"', '"new"'));
  });
});

/* -------------------------------------------------------------------------- */
/* a tool that is not in the registry                                          */
/* -------------------------------------------------------------------------- */

describe("an unresolved tool is shown, flagged, and left alone", () => {
  const source = flowSource('  await tools.github.getAuditLog({ repo: input.repository });');

  it("becomes an `unknown` node with an error diagnostic", async () => {
    const { graph } = await open(source);
    const node = nodeAt(graph, "flow/call:github.getAuditLog[0]");
    expect(node.type).toBe("unknown");
    expect(node.label).toBe("github.getAuditLog");
    expect(diagnosticsOf(graph, "unresolved-tool")).toHaveLength(1);
    expect(diagnosticsOf(graph, "unresolved-tool")[0].severity).toBe("error");
  });

  it("refuses to edit its fields — there is no schema to validate against", async () => {
    const { session, graph } = await open(source);
    const error = await refusal(
      session.patchNode(nodeAt(graph, "flow/call:github.getAuditLog[0]").id, { repo: "other" }),
    );
    expect(error.code).toBe("patch-not-editable");
    expect(graph.source.content).toBe(source);
  });

  it("becomes a real tool node the moment the registry learns about it", async () => {
    const registry = createRegistry();
    registry.registerTool({
      name: "github.getAuditLog",
      label: "Get Audit Log",
      inputSchema: { repo: "string" },
      editableFields: ["repo"],
    });
    const { session, graph } = await open(source, registry);
    expect(nodeAt(graph, "flow/call:github.getAuditLog[0]").type).toBe("tool");
    const result = await session.patchNode(nodeAt(graph, "flow/call:github.getAuditLog[0]").id, {
      // The field currently holds an expression, so the kind change is explicit
      // — a bare string there would be a silent reinterpretation (06 §3).
      repo: { kind: "literal", value: "other" },
    });
    expect(result.source).toContain('repo: "other"');
  });

  it("refuses every patch once the registry has moved under the graph (06 §5.0)", async () => {
    const registry = createRegistry();
    registry.registerTool({
      name: "slack.send",
      label: "Slack Send",
      inputSchema: { channel: "string", message: "string" },
      editableFields: ["channel"],
    });
    const flow = flowSource('  await tools.slack.send({ channel: "#a", message: "m" });');
    const { session, graph } = await open(flow, registry);
    registry.registerTool({ name: "extra.tool", label: "Extra", inputSchema: { x: "string" } });

    const error = await refusal(session.patchNode(toolNode(graph, "slack.send").id, { channel: "#b" }));
    expect(error.code).toBe("patch-conflict");
    expect(error.message).toContain("registry");
  });
});

/* -------------------------------------------------------------------------- */
/* replacing an opaque region                                                  */
/* -------------------------------------------------------------------------- */

describe("`$code` replaces an opaque region, or refuses", () => {
  const source = flowSource(
    `  const a = 1 + 2;
  await tools.slack.send({ channel: "#a", message: String(a) });`,
  );

  it("replaces the region with new text", async () => {
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/stmt[0]").id, {
      $code: "const a = 40 + 2;",
    });
    expect(result.source).toBe(source.replace("const a = 1 + 2;", "const a = 40 + 2;"));
  });

  it("accepts several statements in one region — the region is the unit, not the statement", async () => {
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/stmt[0]").id, {
      $code: "const b = 1; const a = b + 41;",
    });
    expect(result.source).toContain("const b = 1; const a = b + 41;");
  });

  it("refuses text that would not parse, and writes nothing", async () => {
    const { session, graph } = await open(source);
    const error = await refusal(
      session.patchNode(nodeAt(graph, "flow/stmt[0]").id, { $code: "const a = ;" }),
    );
    expect(error.code).toBe("patch-invalid");
    expect(graph.source.content).toBe(source);
  });

  it("refuses text whose braces do not balance, and writes nothing", async () => {
    const { session, graph } = await open(source);
    const error = await refusal(
      session.patchNode(nodeAt(graph, "flow/stmt[0]").id, { $code: "if (true) {" }),
    );
    expect(error.code).toBe("patch-invalid");
    expect(graph.source.content).toBe(source);
  });

  it.todo(
    "`$code` that drops a binding a later node still reads (`const a = 1+2;` → `const zzz = 1;`) is " +
      "accepted: the candidate parses and still obeys the flow contract, and core cannot type-check " +
      "it — the project runs ts-morph with `noLib`/`noResolve` so the analysis path never needs a " +
      "checker (04 §1.2), and 06 §4 makes the type check conditional on a host that has one. Closing " +
      "this in core needs a checker-backed validation environment, which is a decision above this " +
      "suite; a host that has one gets the guarantee today.",
  );
});
