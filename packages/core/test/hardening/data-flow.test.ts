/**
 * Data flow under adversarial naming.
 *
 * A data edge is a promise: "this step's output is that step's input". Getting
 * it wrong in either direction is expensive — a missing edge lets the delete
 * dependency check (06 §2) wave through a delete that breaks the file; a wrong
 * edge points the reader at a step that had nothing to do with the value. The
 * cases here are all about names: shadowed, reused, destructured, renamed, or
 * used before they exist.
 */

import { describe, expect, it } from "vitest";

import { edgeStrings, flowSource, hasEdge, nodeAt, open, pathsOfType, refusal } from "./helpers.js";

/* -------------------------------------------------------------------------- */
/* shadowing                                                                   */
/* -------------------------------------------------------------------------- */

describe("shadowing resolves to the innermost binding (03 §6)", () => {
  it("binds three same-named declarations to three different producers", async () => {
    const source = flowSource(
      `  const files = await tools.github.getNewPRs({ repo: input.repository });
  for (const x of files) {
    const files2 = await tools.github.getFiles({ pr: x });
    for (const y of files2) {
      const files3 = await tools.github.getFiles({ pr: y });
      await tools.slack.send({ channel: "#a", message: String(files3.length) });
    }
  }`,
    );
    const { graph } = await open(source);
    const edges = edgeStrings(graph);
    // The consumer reads `files3` — the innermost one, produced two levels in.
    expect(edges).toContain(
      "data flow/for[0]/for[0]/call:github.getFiles[0] -> flow/for[0]/for[0]/call:slack.send[0] [files3.length]",
    );
    // …and nothing from the outer producers leaks into it.
    expect(
      edges.filter((edge) => edge.startsWith("data flow/call:github.getNewPRs[0] -> flow/for[0]/for[0]/call:slack.send"))
    ).toEqual([]);
  });

  it("does not let an inner `const files` steal the outer one's readers", async () => {
    const source = flowSource(
      `  const files = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of [1]) {
    const files = await tools.github.getFiles({ pr });
    await tools.slack.send({ channel: "#inner", message: String(files.length) });
  }
  await tools.slack.send({ channel: "#outer", message: String(files.length) });`,
    );
    const { graph } = await open(source);
    const edges = edgeStrings(graph);
    // Inner consumer ← inner producer.
    expect(edges).toContain(
      "data flow/for[0]/call:github.getFiles[0] -> flow/for[0]/call:slack.send[0] [files.length]",
    );
    // Outer consumer ← outer producer, even though the name was reused.
    expect(edges).toContain(
      "data flow/call:github.getNewPRs[0] -> flow/call:slack.send[0] [files.length]",
    );
    expect(edges).not.toContain(
      "data flow/for[0]/call:github.getFiles[0] -> flow/call:slack.send[0] [files.length]",
    );
  });

  it("resolves a three-level chain of differently named bindings", async () => {
    const source = flowSource(
      `  const pr = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr2 of pr) {
    const pr3 = pr2;
    for (const pr4 of [pr3]) {
      const files = await tools.github.getFiles({ pr: pr4 });
      await tools.slack.send({ channel: "#a", message: String(files.length) });
    }
  }`,
    );
    const { graph } = await open(source);
    expect(hasEdge(graph, "flow/call:github.getNewPRs[0]", "flow/for[0]", "data")).toBe(true);
    expect(hasEdge(graph, "flow/for[0]", "flow/for[0]/stmt[0]", "data")).toBe(true);
    expect(hasEdge(graph, "flow/for[0]/stmt[0]", "flow/for[0]/for[0]", "data")).toBe(true);
    expect(hasEdge(graph, "flow/for[0]/for[0]", "flow/for[0]/for[0]/call:github.getFiles[0]", "data")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* multiple writers                                                            */
/* -------------------------------------------------------------------------- */

describe("a `let` written in several branches has an edge from each writer", () => {
  const source = flowSource(
    `  let channel = "#default";
  if (input.repository === "a") { channel = "#a"; }
  else if (input.repository === "b") { channel = "#b"; }
  else { channel = "#c"; }
  await tools.slack.send({ channel, message: "m" });`,
  );

  it("draws one data edge per writer, not just from the last one", async () => {
    const { graph } = await open(source);
    const consumer = nodeAt(graph, "flow/call:slack.send[0]");
    const writers = graph.edges
      .filter((edge) => edge.kind === "data" && edge.target === consumer.id && edge.label === "channel")
      .map((edge) => graph.nodes.find((node) => node.id === edge.source)!.source.semanticPath)
      .sort();
    // Declaration + three assignments: dropping any of them would tell the
    // reader a value comes from somewhere it may well not (03 §6).
    expect(writers).toEqual([
      "flow/if[0]/else/if[0]/else/stmt[0]",
      "flow/if[0]/else/if[0]/stmt[0]",
      "flow/if[0]/stmt[0]",
      "flow/stmt[0]",
    ]);
  });

  it("still converges the branches on a single merge before the consumer", async () => {
    const { graph } = await open(source);
    expect(pathsOfType(graph, "merge")).toEqual(["flow/if[0]#merge"]);
    expect(hasEdge(graph, "flow/if[0]#merge", "flow/call:slack.send[0]")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* destructuring                                                               */
/* -------------------------------------------------------------------------- */

describe("destructuring", () => {
  it("renames with `const { data: rows }` and keeps the port on the source property", async () => {
    const source = flowSource(
      `  const { data: rows } = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#a", message: String(rows.length) });`,
    );
    const { graph } = await open(source);
    const producer = nodeAt(graph, "flow/call:github.getNewPRs[0]");
    // The port is the *property* (`data`) and the edge label is the *binding*
    // (`rows`): the reader needs both — which field it came from, and what it
    // is called downstream.
    expect(producer.outputs.map((port) => port.id)).toEqual(["data"]);
    expect(producer.outputs.map((port) => port.label)).toEqual(["rows"]);
    expect(hasEdge(graph, "flow/call:github.getNewPRs[0]", "flow/call:slack.send[0]", "data")).toBe(true);
  });

  it("binds every name of a nested pattern, not the pattern's text", async () => {
    // Regression: `const { a: { b } } = …` produced a binding literally named
    // "{ b }". Nothing downstream could ever match it, so the data edge into
    // the consumer went missing — and with it the delete dependency check.
    const source = flowSource(
      `  const rows = await tools.github.getNewPRs({ repo: input.repository });
  const { a: { b } } = rows[0];
  await tools.slack.send({ channel: "#a", message: String(b) });`,
    );
    const { graph } = await open(source);
    const code = nodeAt(graph, "flow/stmt[1]");
    expect(code.outputs.map((port) => port.id)).toEqual(["b"]);
    expect(hasEdge(graph, "flow/stmt[1]", "flow/call:slack.send[0]", "data")).toBe(true);
  });

  it("binds a nested array pattern too", async () => {
    const source = flowSource(
      `  const rows = await tools.github.getNewPRs({ repo: input.repository });
  const [[first]] = rows;
  await tools.slack.send({ channel: "#a", message: String(first) });`,
    );
    const { graph } = await open(source);
    expect(nodeAt(graph, "flow/stmt[1]").outputs.map((port) => port.id)).toEqual(["first"]);
    expect(hasEdge(graph, "flow/stmt[1]", "flow/call:slack.send[0]", "data")).toBe(true);
  });

  it("binds a rest element", async () => {
    const source = flowSource(
      `  const rows = await tools.github.getNewPRs({ repo: input.repository });
  const { first, ...rest } = rows[0];
  await tools.slack.send({ channel: "#a", message: String(first) + String(rest) });`,
    );
    const { graph } = await open(source);
    expect(nodeAt(graph, "flow/stmt[1]").outputs.map((port) => port.id).sort()).toEqual(["first", "rest"]);
  });

  it("refuses to delete a producer whose nested binding is still read", async () => {
    const source = flowSource(
      `  const rows = await tools.github.getNewPRs({ repo: input.repository });
  const { a: { b } } = rows[0];
  await tools.slack.send({ channel: "#a", message: String(b) });`,
    );
    const { session, graph } = await open(source);
    const error = await refusal(session.patchNode(nodeAt(graph, "flow/stmt[1]").id, { $delete: true }));
    expect(error.code).toBe("patch-dependency");
    expect(error.message).toContain("b");
  });
});

/* -------------------------------------------------------------------------- */
/* one binding read in several places                                          */
/* -------------------------------------------------------------------------- */

describe("a binding read from a condition, a body and a template", () => {
  const source = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  if (prs.length > 0) {
    await tools.slack.send({ channel: "#a", message: \`got \${prs.length}\` });
  }
  return prs;`,
  );

  it("draws an edge to every reader", async () => {
    const { graph } = await open(source);
    const producer = nodeAt(graph, "flow/call:github.getNewPRs[0]");
    const readers = graph.edges
      .filter((edge) => edge.kind === "data" && edge.source === producer.id)
      .map((edge) => graph.nodes.find((node) => node.id === edge.target)!.source.semanticPath)
      .sort();
    expect(readers).toEqual(["flow/if[0]", "flow/if[0]/call:slack.send[0]", "flow/return[0]"]);
  });

  it("reads the interpolation of a template as a use", async () => {
    const { graph } = await open(source);
    expect(edgeStrings(graph)).toContain(
      "data flow/call:github.getNewPRs[0] -> flow/if[0]/call:slack.send[0] [prs.length]",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* names used before they exist                                                */
/* -------------------------------------------------------------------------- */

describe("a name used before its declaration does not derail the analyzer", () => {
  const source = flowSource(
    `  await tools.slack.send({ channel: later, message: "m" });
  const later = "#late";
  return later;`,
  );

  it("analyzes without crashing and still emits every node", async () => {
    const { graph } = await open(source);
    expect(pathsOfType(graph, "tool")).toEqual(["flow/call:slack.send[0]"]);
    expect(pathsOfType(graph, "code")).toEqual(["flow/stmt[1]"]);
    expect(pathsOfType(graph, "output")).toEqual(["flow/return[0]"]);
  });

  it("does not invent a backwards data edge for the temporal dead zone", async () => {
    const { graph } = await open(source);
    // At the point of the call the binding does not exist yet (it would throw
    // at run time). Drawing the edge anyway would claim a dependency that the
    // program's own semantics deny.
    expect(hasEdge(graph, "flow/stmt[1]", "flow/call:slack.send[0]", "data")).toBe(false);
  });

  it("survives a function used before its declaration (hoisted)", async () => {
    const { graph } = await open(
      flowSource(
        `  const flagged = pick([1, 2]);
  function pick(xs: number[]) { return xs[0]; }
  await tools.slack.send({ channel: "#a", message: String(flagged) });`,
      ),
    );
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.diagnostics.every((d) => d.severity !== "error")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* the trigger as a producer                                                   */
/* -------------------------------------------------------------------------- */

describe("`input` is a producer like any other", () => {
  it("labels the edge with the property path actually read", async () => {
    const { graph } = await open(
      flowSource('  await tools.github.getNewPRs({ repo: input.repository });'),
    );
    expect(edgeStrings(graph)).toContain(
      "data flow#trigger -> flow/call:github.getNewPRs[0] [input.repository]",
    );
  });

  it("keeps the edge when `input` is read from inside a nested construct", async () => {
    const { graph } = await open(
      flowSource(
        `  for (const pr of [1]) {
    try {
      await tools.slack.send({ channel: input.repository, message: "m" });
    } catch (e) {
      await tools.slack.send({ channel: "#e", message: "e" });
    }
  }`,
      ),
    );
    expect(
      hasEdge(graph, "flow#trigger", "flow/for[0]/try[0]/call:slack.send[0]", "data"),
    ).toBe(true);
  });
});
