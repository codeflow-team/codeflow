/**
 * Control flow that is hostile on purpose.
 *
 * O1 says the graph must not lie about what runs. The cheapest way for it to
 * lie is a missing edge: a `finally` that never gets control from the `break`
 * that skips past it, a labelled `continue` drawn as if it targeted the loop it
 * sits in, a merge invented where the block simply ended. Each test below names
 * the edge (or the absence of one) that would be the lie.
 */

import { describe, expect, it } from "vitest";

import { edgeStrings, flowSource, hasEdge, nodeAt, open, pathsOfType } from "./helpers.js";

/* -------------------------------------------------------------------------- */
/* nesting                                                                     */
/* -------------------------------------------------------------------------- */

describe("try inside a loop inside a try", () => {
  const source = flowSource(
    `  try {
    for (const pr of [1, 2]) {
      try {
        await tools.slack.send({ channel: "#a", message: "x" });
      } catch (inner) {
        continue;
      } finally {
        await tools.slack.send({ channel: "#f", message: "f" });
      }
    }
  } catch (outer) {
    await tools.slack.send({ channel: "#o", message: "o" });
  }`,
  );

  it("nests both try nodes and the loop without losing a level", async () => {
    const { graph } = await open(source);
    expect(pathsOfType(graph, "try")).toEqual(["flow/try[0]", "flow/try[0]/for[0]/try[0]"]);
    expect(pathsOfType(graph, "loop")).toEqual(["flow/try[0]/for[0]"]);
    expect(nodeAt(graph, "flow/try[0]/for[0]").data["parentId"]).toBe(nodeAt(graph, "flow/try[0]").id);
  });

  it("routes the inner `continue` through the inner finally", async () => {
    // The whole point of the finally edge (04 §2.7): a `continue` that skipped
    // the cleanup on the graph while running it in reality is the graph lying
    // about a side effect.
    const { graph } = await open(source);
    expect(
      hasEdge(
        graph,
        "flow/try[0]/for[0]/try[0]/catch/continue[0]",
        "flow/try[0]/for[0]/try[0]/finally/call:slack.send[0]",
      ),
    ).toBe(true);
  });

  it("routes the inner body through the inner finally too", async () => {
    const { graph } = await open(source);
    expect(
      hasEdge(
        graph,
        "flow/try[0]/for[0]/try[0]/call:slack.send[0]",
        "flow/try[0]/for[0]/try[0]/finally/call:slack.send[0]",
      ),
    ).toBe(true);
  });

  it("gives the outer try its own error edge", async () => {
    const { graph } = await open(source);
    expect(edgeStrings(graph)).toContain(
      "control flow/try[0] -> flow/try[0]/catch/call:slack.send[0] [error]",
    );
  });
});

describe("`continue` inside a try that has a finally", () => {
  const source = flowSource(
    `  for (const pr of [1, 2]) {
    try {
      continue;
    } finally {
      await tools.slack.send({ channel: "#f", message: "f" });
    }
  }`,
  );

  it("draws the jump into the finally, not straight out of the loop", async () => {
    const { graph } = await open(source);
    expect(nodeAt(graph, "flow/for[0]/try[0]/continue[0]").type).toBe("jump");
    expect(
      hasEdge(graph, "flow/for[0]/try[0]/continue[0]", "flow/for[0]/try[0]/finally/call:slack.send[0]"),
    ).toBe(true);
  });

  it("keeps the finally's tool call visible as a node", async () => {
    const { graph } = await open(source);
    expect(nodeAt(graph, "flow/for[0]/try[0]/finally/call:slack.send[0]").type).toBe("tool");
  });
});

describe("labelled jumps across two loop levels", () => {
  const source = flowSource(
    `  outer: for (const a of [1]) {
    for (const b of [2]) {
      for (const c of [3]) {
        if (c > 1) continue outer;
        if (c > 2) break outer;
      }
    }
  }`,
  );

  it("names the target loop on the node label", async () => {
    const { graph } = await open(source);
    // "continue" alone would read as "next c", which is two loops off (04 §2.9).
    expect(nodeAt(graph, "flow/for[0]/for[0]/for[0]/if[0]/continue[0]").label).toBe("continue → outer");
    expect(nodeAt(graph, "flow/for[0]/for[0]/for[0]/if[1]/break[0]").label).toBe("break → outer");
  });

  it("records the label in node data so the UI can resolve the target", async () => {
    const { graph } = await open(source);
    expect(nodeAt(graph, "flow/for[0]/for[0]/for[0]/if[0]/continue[0]").data["label"]).toBe("outer");
    expect(nodeAt(graph, "flow/for[0]/for[0]/for[0]/if[1]/break[0]").data["kind"]).toBe("break");
  });

  it("nests all three loops", async () => {
    const { graph } = await open(source);
    expect(pathsOfType(graph, "loop")).toEqual([
      "flow/for[0]",
      "flow/for[0]/for[0]",
      "flow/for[0]/for[0]/for[0]",
    ]);
  });

  it("does not invent a merge after the last `if` of a block (04 §2.4)", async () => {
    const { graph } = await open(source);
    // if[0] converges (there is an if[1] after it); if[1] is the last statement
    // of the loop body, so both its branches are the block boundary.
    expect(pathsOfType(graph, "merge")).toEqual(["flow/for[0]/for[0]/for[0]/if[0]#merge"]);
  });
});

describe("`return` inside a catch that has a finally", () => {
  const source = flowSource(
    `  try {
    await tools.slack.send({ channel: "#a", message: "x" });
  } catch (e) {
    return { ok: false };
  } finally {
    await tools.slack.send({ channel: "#f", message: "f" });
  }
  return { ok: true };`,
  );

  it("routes the early return through the finally", async () => {
    const { graph } = await open(source);
    expect(nodeAt(graph, "flow/try[0]/catch/return[0]").type).toBe("output");
    expect(
      hasEdge(graph, "flow/try[0]/catch/return[0]", "flow/try[0]/finally/call:slack.send[0]"),
    ).toBe(true);
  });

  it("keeps the two returns as two separate output nodes (04 §2.9)", async () => {
    const { graph } = await open(source);
    expect(pathsOfType(graph, "output")).toEqual(["flow/try[0]/catch/return[0]", "flow/return[0]"]);
  });

  it.todo(
    "known over-approximation: the finally's single successor also serves the catch's return path — " +
      "after `return` in the catch, control leaves the function, but the flat model draws one exit from " +
      "the finally and it lands on the trailing return. Fixing this needs terminal-aware exits out of a " +
      "finally, which is beyond the MVP model of 04 §2.7 (the same section already scopes nested-try " +
      "terminals to their own finally).",
  );
});

describe("five-deep else-if", () => {
  const source = flowSource(
    `  const n = 3;
  if (n === 1) { await tools.slack.send({ channel: "#1", message: "1" }); }
  else if (n === 2) { await tools.slack.send({ channel: "#2", message: "2" }); }
  else if (n === 3) { await tools.slack.send({ channel: "#3", message: "3" }); }
  else if (n === 4) { await tools.slack.send({ channel: "#4", message: "4" }); }
  else { await tools.slack.send({ channel: "#5", message: "5" }); }
  return n;`,
  );

  it("projects the chain as nested conditions, one per `if` (04 §2.4)", async () => {
    const { graph } = await open(source);
    expect(pathsOfType(graph, "condition")).toEqual([
      "flow/if[0]",
      "flow/if[0]/else/if[0]",
      "flow/if[0]/else/if[0]/else/if[0]",
      "flow/if[0]/else/if[0]/else/if[0]/else/if[0]",
    ]);
  });

  it("converges on exactly one merge, the outermost one", async () => {
    const { graph } = await open(source);
    expect(pathsOfType(graph, "merge")).toEqual(["flow/if[0]#merge"]);
    // All five branches reach it.
    const merge = nodeAt(graph, "flow/if[0]#merge");
    expect(graph.edges.filter((edge) => edge.target === merge.id && edge.kind === "control")).toHaveLength(5);
  });

  it("labels each condition's own two branches", async () => {
    const { graph } = await open(source);
    const edges = edgeStrings(graph);
    expect(edges).toContain("control flow/if[0] -> flow/if[0]/call:slack.send[0] [true]");
    expect(edges).toContain("control flow/if[0] -> flow/if[0]/else/if[0] [false]");
  });
});

describe("Promise.all inside a loop inside a try", () => {
  const source = flowSource(
    `  try {
    for (const pr of [1, 2]) {
      const [a, b] = await Promise.all([
        tools.github.getFiles({ pr }),
        tools.github.getNewPRs({ repo: input.repository }),
      ]);
      await tools.slack.send({ channel: "#a", message: String(a.length + b.length) });
    }
  } catch (e) {
    await tools.slack.send({ channel: "#e", message: "e" });
  }`,
  );

  it("keeps the parallel node and both branches inside the loop inside the try", async () => {
    const { graph } = await open(source);
    expect(pathsOfType(graph, "parallel")).toEqual(["flow/try[0]/for[0]/parallel[0]"]);
    expect(pathsOfType(graph, "tool")).toEqual([
      "flow/try[0]/for[0]/parallel[0]/call:github.getFiles[0]",
      "flow/try[0]/for[0]/parallel[0]/call:github.getNewPRs[0]",
      "flow/try[0]/for[0]/call:slack.send[0]",
      "flow/try[0]/catch/call:slack.send[0]",
    ]);
  });

  it("labels the branches so the destructured ports can be traced back", async () => {
    const { graph } = await open(source);
    const edges = edgeStrings(graph);
    expect(edges).toContain(
      "control flow/try[0]/for[0]/parallel[0] -> flow/try[0]/for[0]/parallel[0]/call:github.getFiles[0] [branch 0]",
    );
    expect(edges).toContain(
      "control flow/try[0]/for[0]/parallel[0] -> flow/try[0]/for[0]/parallel[0]/call:github.getNewPRs[0] [branch 1]",
    );
  });

  it("hangs the destructured outputs off the merge, with data edges downstream", async () => {
    const { graph } = await open(source);
    const merge = nodeAt(graph, "flow/try[0]/for[0]/parallel[0]#merge");
    expect(merge.outputs.map((port) => port.id)).toEqual(["a", "b"]);
    const consumer = nodeAt(graph, "flow/try[0]/for[0]/call:slack.send[0]");
    const labels = graph.edges
      .filter((edge) => edge.kind === "data" && edge.source === merge.id && edge.target === consumer.id)
      .map((edge) => edge.label);
    expect(labels).toEqual(["a.length", "b.length"]);
  });

  it("feeds the loop variable into the branch that uses it", async () => {
    const { graph } = await open(source);
    expect(
      hasEdge(
        graph,
        "flow/try[0]/for[0]",
        "flow/try[0]/for[0]/parallel[0]/call:github.getFiles[0]",
        "data",
      ),
    ).toBe(true);
  });
});

describe("a code node between two tool nodes that depend on each other", () => {
  const source = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const filtered = prs.filter((p: { open: boolean }) => p.open).slice(0, 3);
  const files = await tools.github.getFiles({ pr: filtered[0] });
  return files;`,
  );

  it("threads control through the opaque region rather than around it", async () => {
    const { graph } = await open(source);
    expect(hasEdge(graph, "flow/call:github.getNewPRs[0]", "flow/stmt[1]")).toBe(true);
    expect(hasEdge(graph, "flow/stmt[1]", "flow/call:github.getFiles[0]")).toBe(true);
  });

  it("keeps the data dependency visible on both sides of the opaque region", async () => {
    const { graph } = await open(source);
    // If the code node swallowed the binding silently, deleting the first tool
    // node would look safe while breaking the third statement (06 §2).
    expect(hasEdge(graph, "flow/call:github.getNewPRs[0]", "flow/stmt[1]", "data")).toBe(true);
    expect(hasEdge(graph, "flow/stmt[1]", "flow/call:github.getFiles[0]", "data")).toBe(true);
  });

  it("refuses to delete the producer while the code node still reads it", async () => {
    const { session, graph } = await open(source);
    const error = await session
      .patchNode(nodeAt(graph, "flow/call:github.getNewPRs[0]").id, { $delete: true })
      .catch((cause: unknown) => cause);
    expect((error as { code?: string }).code).toBe("patch-dependency");
    expect((error as Error).message).toContain("prs");
  });
});

describe("unsupported loop forms degrade instead of being approximated", () => {
  it("turns a classic `for (;;)` into a code node and still flags the tool call inside", async () => {
    const { graph } = await open(
      flowSource(
        `  for (let i = 0; i < 3; i++) {
    await tools.slack.send({ channel: "#a", message: "m" });
  }`,
      ),
    );
    expect(pathsOfType(graph, "loop")).toEqual([]);
    expect(pathsOfType(graph, "code")).toEqual(["flow/stmt[0]"]);
    // The call must not vanish silently — the diagnostic is the trace (I1).
    expect(graph.diagnostics.some((d) => d.code === "unsupported-construct")).toBe(true);
  });

  it("turns a `do…while` into a code node", async () => {
    const { graph } = await open(
      flowSource(
        `  let n = 0;
  do {
    n++;
  } while (n < 3);`,
      ),
    );
    expect(pathsOfType(graph, "loop")).toEqual([]);
    expect(pathsOfType(graph, "code")).toEqual(["flow/stmt[0..1]"]);
  });

  it("warns on a while loop it cannot see a bound for (04 §2.8)", async () => {
    const { graph } = await open(
      flowSource(
        `  while (input.repository.length > 0) {
    await tools.slack.send({ channel: "#a", message: "m" });
  }`,
      ),
    );
    expect(nodeAt(graph, "flow/while[0]").type).toBe("loop");
    expect(graph.diagnostics.some((d) => d.code === "unbounded-loop-risk")).toBe(true);
  });
});
