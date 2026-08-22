/**
 * I5 — identity stability without mis-binding (11 §2, 03 §5.2, 08 §3.3).
 *
 * Every scenario below runs two revisions of a flow through **one session**, the
 * only place identity continuity exists (03 §5.0), and asserts two things at
 * once: that ids survive where the spec commits to them, and — the part that
 * matters more — that an old id is never handed to a node that is not the same
 * step of the flow. Where the spec admits ambiguity (two siblings identical to
 * the byte), the assertion is on the *bijection*, not on which of the two won.
 */

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/analyzer/index.js";
import { applyIdentity, resolveIdentity } from "../src/mapper/resolve.js";
import { createCodeFlow } from "../src/session.js";
import type { ProvenanceMap } from "../src/model/index.js";
import { createSampleRegistry } from "./fixtures.js";
import { listFixtures, loadFixture } from "./harness/fixture.js";
import {
  assertBijective,
  assertIntegrity,
  changesOf,
  flowSource,
  idsOf,
  nodeById,
  nodeByPath,
  reanalyze,
} from "./harness/reanalyze.js";

const LIB_IMPORT = `import { isAuthChange } from "@flows/lib";\n`;

/* -------------------------------------------------------------------------- */
/* a — reformatting                                                            */
/* -------------------------------------------------------------------------- */

describe("a — reformatting the file changes no identity", () => {
  const before = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });
    if (files.some(isAuthChange)) {
      await tools.slack.send({ channel: "#security", message: "Security PR" });
    }
  }`,
    LIB_IMPORT,
  );

  // Same statements, byte-identical each; only trivia between them differs.
  const after = flowSource(
    `
  // fetch the pull requests we have not seen yet

      const prs = await tools.github.getNewPRs({ repo: input.repository });

  for (const pr of prs) {

        /* one PR at a time */
        const files = await tools.github.getFiles({ pr });

        if (files.some(isAuthChange)) {
          // tell the security channel
          await tools.slack.send({ channel: "#security", message: "Security PR" });
        }

  }
`,
    LIB_IMPORT,
  );

  it("keeps every node id, in the same order", async () => {
    const { before: first, after: second } = await reanalyze(before, after);
    expect(idsOf(second)).toEqual(idsOf(first));
  });

  it("reports no additions or removals", async () => {
    const { changes } = await reanalyze(before, after);
    expect(changesOf(changes, "node.added")).toEqual([]);
    expect(changesOf(changes, "node.removed")).toEqual([]);
    expect(changesOf(changes, "edge.added")).toEqual([]);
    expect(changesOf(changes, "edge.removed")).toEqual([]);
  });

  it("reports source-range updates and nothing else", async () => {
    const { changes } = await reanalyze(before, after);
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.type).toBe("node.updated");
      expect(Object.keys(change.changes ?? {})).toEqual(["source"]);
    }
  });

  it("matches every node on its fingerprint, inside its sibling group", async () => {
    const { resolution } = await reanalyze(before, after);
    assertBijective(resolution);
    expect(resolution.removed).toEqual([]);
    expect(resolution.added).toEqual([]);
    expect(new Set(resolution.matches.map((match) => match.step))).toEqual(
      new Set(["sibling-fingerprint"]),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* b — an unrelated statement in between                                       */
/* -------------------------------------------------------------------------- */

describe("b — inserting an unrelated statement between two nodes", () => {
  const before = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#security", message: "Auth change detected" });`,
  );
  const after = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const startedAt = Date.now();
  await tools.slack.send({ channel: "#security", message: "Auth change detected" });`,
  );

  it("keeps both existing nodes and adds exactly one", async () => {
    const { before: first, after: second, changes, resolution } = await reanalyze(before, after);
    assertBijective(resolution);

    const prs = nodeByPath(first, "flow/call:github.getNewPRs[0]");
    const slack = nodeByPath(first, "flow/call:slack.send[0]");
    expect(nodeById(second, prs.id)?.source.semanticPath).toBe("flow/call:github.getNewPRs[0]");
    expect(nodeById(second, slack.id)?.source.semanticPath).toBe("flow/call:slack.send[0]");

    const added = changesOf(changes, "node.added");
    expect(added).toHaveLength(1);
    expect(nodeById(second, added[0].nodeId!)?.type).toBe("code");
    expect(changesOf(changes, "node.removed")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* c — inserting a byte-identical call before an existing one                   */
/* -------------------------------------------------------------------------- */

describe("c — inserting an identical call before the existing one (no provenance)", () => {
  const SEND = `  await tools.slack.send({ channel: "#security", message: "Auth change detected" });`;
  const before = flowSource(SEND);
  const after = flowSource(`${SEND}\n${SEND}`);

  it("keeps the old id on a slack.send node and adds exactly one node", async () => {
    const { before: first, after: second, changes, resolution } = await reanalyze(before, after);
    assertBijective(resolution);
    assertIntegrity(second);

    const oldSlack = nodeByPath(first, "flow/call:slack.send[0]");
    const carrier = nodeById(second, oldSlack.id);
    expect(carrier).toBeDefined();

    // Never mis-bound: whatever carries the old id is the same step of the flow.
    expect(carrier!.type).toBe("tool");
    expect(carrier!.data["toolName"]).toBe("slack.send");
    expect(carrier!.source.fingerprint).toBe(oldSlack.source.fingerprint);

    expect(changesOf(changes, "node.added")).toHaveLength(1);
    expect(changesOf(changes, "node.removed")).toEqual([]);
    // The added node is a *new* id, not a recycled one.
    const addedId = changesOf(changes, "node.added")[0].nodeId!;
    expect(idsOf(first)).not.toContain(addedId);
  });

  it("does not give the old id to a node whose content differs", async () => {
    const distinct = flowSource(
      `  await tools.slack.send({ channel: "#ops", message: "Deploy started" });\n${SEND}`,
    );
    const { before: first, after: second, changes } = await reanalyze(before, distinct);
    const oldSlack = nodeByPath(first, "flow/call:slack.send[0]");
    const carrier = nodeById(second, oldSlack.id);
    expect(carrier).toBeDefined();
    // The old node slid down to index [1]; the inserted one is the addition.
    expect(carrier!.source.semanticPath).toBe("flow/call:slack.send[1]");
    expect(carrier!.data["argumentText"]).toContain("#security");
    expect(changesOf(changes, "node.added")).toHaveLength(1);
    expect(changesOf(changes, "node.removed")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* d — provenance                                                              */
/* -------------------------------------------------------------------------- */

describe("d — patch provenance is absolute (03 §5.2 step 0)", () => {
  const SEND = `  await tools.slack.send({ channel: "#security", message: "Auth change detected" });`;
  const before = flowSource(SEND);
  const after = flowSource(`${SEND}\n${SEND}`);

  it("pins the old id to the node the patch says it is, not the one heuristics would pick", async () => {
    const registry = createSampleRegistry();
    const first = analyzeSource(before, registry);
    const oldSlack = nodeByPath(first, "flow/call:slack.send[0]");

    // Heuristics alone bind the old id to index [0] (asserted in scenario c);
    // the patch engine knows it inserted *above*, so it says [1].
    const provenance: ProvenanceMap = { [oldSlack.id]: "flow/call:slack.send[1]" };
    const { after: second, changes } = await reanalyze(before, after, { provenance });

    expect(nodeById(second, oldSlack.id)?.source.semanticPath).toBe("flow/call:slack.send[1]");
    expect(changesOf(changes, "node.added")).toHaveLength(1);
    expect(changesOf(changes, "node.removed")).toEqual([]);
    expect(nodeByPath(second, "flow/call:slack.send[0]").id).not.toBe(oldSlack.id);
  });

  it("accepts a source range instead of a semantic path", async () => {
    const registry = createSampleRegistry();
    const first = analyzeSource(before, registry);
    const oldSlack = nodeByPath(first, "flow/call:slack.send[0]");
    const secondCall = after.lastIndexOf("await tools.slack.send");
    const provenance: ProvenanceMap = {
      [oldSlack.id]: { range: { start: secondCall, end: secondCall + 10 } },
    };
    const { after: second } = await reanalyze(before, after, { provenance });
    expect(nodeById(second, oldSlack.id)?.source.semanticPath).toBe("flow/call:slack.send[1]");
  });

  it("keeps identity through a tool change — the id is an opaque handle (03 §5.3)", async () => {
    const registry = createSampleRegistry();
    const source = flowSource(
      `  const prs = await tools.github.getNewPRs({ repo: input.repository });`,
    );
    const patched = flowSource(`  const prs = await tools.github.getFiles({ pr: input.repository });`);
    const first = analyzeSource(source, registry);
    const old = nodeByPath(first, "flow/call:github.getNewPRs[0]");

    const provenance: ProvenanceMap = { [old.id]: "flow/call:github.getFiles[0]" };
    const { after: second, changes } = await reanalyze(source, patched, { provenance });

    const carrier = nodeById(second, old.id);
    expect(carrier?.data["toolName"]).toBe("github.getFiles");
    expect(changesOf(changes, "node.removed")).toEqual([]);
    expect(changesOf(changes, "node.added")).toEqual([]);
    const updated = changesOf(changes, "node.updated").find((c) => c.nodeId === old.id);
    expect(Object.keys(updated?.changes ?? {})).toContain("data");
  });

  it("honours an explicit removal without rebinding it", async () => {
    const registry = createSampleRegistry();
    const source = flowSource(
      `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#security", message: "Auth change detected" });`,
    );
    const patched = flowSource(
      `  const prs = await tools.github.getNewPRs({ repo: input.repository });`,
    );
    const first = analyzeSource(source, registry);
    const slack = nodeByPath(first, "flow/call:slack.send[0]");
    const provenance: ProvenanceMap = { [slack.id]: { removed: true } };

    const { changes, resolution } = await reanalyze(source, patched, { provenance });
    expect(resolution.removed).toContain(slack.id);
    expect(changesOf(changes, "node.removed").map((c) => c.nodeId)).toContain(slack.id);
  });

  it("falls back to heuristics when the named target does not exist", async () => {
    const registry = createSampleRegistry();
    const source = flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });`);
    const patched = flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.owner });`);
    const first = analyzeSource(source, registry);
    const old = nodeByPath(first, "flow/call:github.getNewPRs[0]");
    const provenance: ProvenanceMap = { [old.id]: "flow/call:nowhere[9]" };

    const { after: second } = await reanalyze(source, patched, { provenance });
    expect(nodeById(second, old.id)?.data["toolName"]).toBe("github.getNewPRs");
  });
});

/* -------------------------------------------------------------------------- */
/* e — swapping two calls of the same tool                                     */
/* -------------------------------------------------------------------------- */

describe("e — swapping two calls of the same tool with different arguments", () => {
  const a = `  await tools.slack.send({ channel: "#alpha", message: "A" });`;
  const b = `  await tools.slack.send({ channel: "#beta", message: "B" });`;
  const before = flowSource(`${a}\n${b}`);
  const after = flowSource(`${b}\n${a}`);

  it("each call keeps its own id — no cross-binding", async () => {
    const { before: first, after: second, changes, resolution } = await reanalyze(before, after);
    assertBijective(resolution);

    const alphaBefore = first.nodes.find((n) => String(n.data["argumentText"]).includes("#alpha"))!;
    const betaBefore = first.nodes.find((n) => String(n.data["argumentText"]).includes("#beta"))!;
    const alphaAfter = second.nodes.find((n) => String(n.data["argumentText"]).includes("#alpha"))!;
    const betaAfter = second.nodes.find((n) => String(n.data["argumentText"]).includes("#beta"))!;

    expect(alphaAfter.id).toBe(alphaBefore.id);
    expect(betaAfter.id).toBe(betaBefore.id);
    expect(changesOf(changes, "node.added")).toEqual([]);
    expect(changesOf(changes, "node.removed")).toEqual([]);
    // The order really did change: control edges were rewired.
    expect(changesOf(changes, "edge.added").length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* f — deleting one of two byte-identical siblings                             */
/* -------------------------------------------------------------------------- */

describe("f — two byte-identical siblings, one deleted (no provenance)", () => {
  const SEND = `  await tools.slack.send({ channel: "#security", message: "Auth change detected" });`;
  const before = flowSource(`${SEND}\n${SEND}`);
  const after = flowSource(SEND);

  it("removes exactly one and keeps exactly one — never both, never neither", async () => {
    const { before: first, after: second, changes, resolution } = await reanalyze(before, after);
    assertBijective(resolution);
    assertIntegrity(second);

    const oldIds = [
      nodeByPath(first, "flow/call:slack.send[0]").id,
      nodeByPath(first, "flow/call:slack.send[1]").id,
    ];
    const survivors = oldIds.filter((id) => nodeById(second, id) !== undefined);
    expect(survivors).toHaveLength(1);

    const removed = changesOf(changes, "node.removed").map((c) => c.nodeId);
    expect(removed.filter((id) => oldIds.includes(id!))).toHaveLength(1);
    expect(changesOf(changes, "node.added")).toEqual([]);
    // The ambiguity is acknowledged (03 §5.2); the bijection is not negotiable.
    expect(second.nodes.filter((n) => n.data["toolName"] === "slack.send")).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* g — editing one node's argument                                             */
/* -------------------------------------------------------------------------- */

describe("g — editing an argument", () => {
  const before = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#security", message: "Auth change detected" });`,
  );
  const after = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#engineering", message: "Auth change detected" });`,
  );

  it("updates the edited node in place and leaves the others untouched", async () => {
    const { before: first, after: second, changes } = await reanalyze(before, after);

    const slack = nodeByPath(first, "flow/call:slack.send[0]");
    const prs = nodeByPath(first, "flow/call:github.getNewPRs[0]");
    expect(nodeById(second, slack.id)?.data["argumentText"]).toContain("#engineering");
    expect(nodeById(second, prs.id)).toBeDefined();

    expect(changesOf(changes, "node.added")).toEqual([]);
    expect(changesOf(changes, "node.removed")).toEqual([]);
    const updated = changesOf(changes, "node.updated");
    const slackUpdate = updated.find((change) => change.nodeId === slack.id);
    expect(Object.keys(slackUpdate?.changes ?? {}).sort()).toEqual(["data", "source"]);
    // Nothing before the edit moved, so it is not in the diff at all.
    expect(updated.some((change) => change.nodeId === prs.id)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* h — a code node absorbing an adjacent statement                             */
/* -------------------------------------------------------------------------- */

describe("h — an unsupported statement next to an existing code node (04 §2.11)", () => {
  const before = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const count = prs.length;`,
  );
  const after = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const count = prs.length;
  const label = count > 3 ? "many" : "few";`,
  );

  it("keeps the code node's id through the merge — updated, not removed+added", async () => {
    const { before: first, after: second, changes, resolution } = await reanalyze(before, after);
    assertBijective(resolution);

    const code = first.nodes.find((node) => node.type === "code")!;
    expect(code.source.semanticPath).toBe("flow/stmt[1]");
    const carrier = nodeById(second, code.id);
    expect(carrier?.source.semanticPath).toBe("flow/stmt[1..2]");
    expect((carrier?.data["statementFingerprints"] as string[]).length).toBe(2);

    expect(changesOf(changes, "node.added")).toEqual([]);
    expect(changesOf(changes, "node.removed")).toEqual([]);
    const step = resolution.matches.find((match) => match.previousId === code.id)?.step;
    expect(step).toBe("sibling-signature");
  });
});

/* -------------------------------------------------------------------------- */
/* i — changing a call to a different tool, by hand                            */
/* -------------------------------------------------------------------------- */

describe("i — a hand-edited tool change (no provenance)", () => {
  const before = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#security", message: "Auth change detected" });`,
  );
  const after = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.github.getFiles({ pr: prs });`,
  );

  it("loses the id (removed + added) rather than binding it to another tool", async () => {
    const { before: first, after: second, changes, resolution } = await reanalyze(before, after);
    assertBijective(resolution);
    assertIntegrity(second);

    const slack = nodeByPath(first, "flow/call:slack.send[0]");
    const prs = nodeByPath(first, "flow/call:github.getNewPRs[0]");

    expect(nodeById(second, slack.id)).toBeUndefined();
    expect(resolution.removed).toContain(slack.id);
    expect(nodeById(second, prs.id)).toBeDefined();

    const getFiles = nodeByPath(second, "flow/call:github.getFiles[0]");
    expect(getFiles.id).not.toBe(slack.id);
    expect(idsOf(first)).not.toContain(getFiles.id);
    expect(changesOf(changes, "node.added").map((c) => c.nodeId)).toContain(getFiles.id);
  });
});

/* -------------------------------------------------------------------------- */
/* j — a regenerated file                                                      */
/* -------------------------------------------------------------------------- */

describe("j — AI regenerates the file (03 §5.3: best-effort)", () => {
  const before = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#security", message: "one" });`,
  );
  const after = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });
  }`,
  );

  it("keeps the nodes whose fingerprint survived and cleanly replaces the rest", async () => {
    const { before: first, after: second, changes, resolution } = await reanalyze(before, after);
    assertBijective(resolution);
    assertIntegrity(second);

    const prs = nodeByPath(first, "flow/call:github.getNewPRs[0]");
    const slack = nodeByPath(first, "flow/call:slack.send[0]");

    expect(nodeById(second, prs.id)?.data["toolName"]).toBe("github.getNewPRs");
    expect(nodeById(second, slack.id)).toBeUndefined();
    expect(changesOf(changes, "node.removed").map((c) => c.nodeId)).toEqual([slack.id]);

    const addedIds = changesOf(changes, "node.added").map((c) => c.nodeId!);
    expect(addedIds.map((id) => nodeById(second, id)!.type).sort()).toEqual(["loop", "tool"]);
    // No added node reuses an id the previous graph knew.
    for (const id of addedIds) expect(idsOf(first)).not.toContain(id);
  });
});

/* -------------------------------------------------------------------------- */
/* nesting, edges and the resolution API                                       */
/* -------------------------------------------------------------------------- */

describe("nested scopes are aligned by descent, not by name", () => {
  const before = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });
    await tools.slack.send({ channel: "#security", message: "Security PR" });
  }`,
  );
  // A whole `if` is wrapped around nothing new above the loop, shifting its index.
  const after = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  if (prs.length > 0) {
    const total = prs.length;
  }
  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });
    await tools.slack.send({ channel: "#security", message: "Security PR" });
  }`,
  );

  it("keeps the ids of everything inside the loop body", async () => {
    const { before: first, after: second, resolution } = await reanalyze(before, after);
    assertBijective(resolution);
    for (const path of [
      "flow/for[0]",
      "flow/for[0]/call:github.getFiles[0]",
      "flow/for[0]/call:slack.send[0]",
    ]) {
      expect(nodeById(second, nodeByPath(first, path).id)?.source.semanticPath).toBe(path);
    }
  });
});

describe("branch and handler scopes align independently", () => {
  it("editing the then-branch leaves the else-branch untouched", async () => {
    const before = flowSource(
      `  if (input.repository) {
    await tools.slack.send({ channel: "#security", message: "yes" });
  } else {
    await tools.slack.send({ channel: "#ops", message: "no" });
  }
  const done = 1;`,
    );
    const after = flowSource(
      `  if (input.repository) {
    const marker = 1;
    await tools.slack.send({ channel: "#security", message: "yes" });
  } else {
    await tools.slack.send({ channel: "#ops", message: "no" });
  }
  const done = 1;`,
    );
    const { before: first, after: second, changes, resolution } = await reanalyze(before, after);
    assertBijective(resolution);

    for (const path of [
      "flow/if[0]",
      "flow/if[0]/call:slack.send[0]",
      "flow/if[0]/else/call:slack.send[0]",
      "flow/if[0]#merge",
    ]) {
      expect(nodeById(second, nodeByPath(first, path).id)?.source.semanticPath).toBe(path);
    }
    expect(changesOf(changes, "node.added")).toHaveLength(1);
    expect(changesOf(changes, "node.removed")).toEqual([]);
  });

  it("editing the try body leaves catch and finally nodes untouched", async () => {
    const before = flowSource(
      `  try {
    await tools.github.getFiles({ pr: input.repository });
  } catch (err) {
    await tools.slack.send({ channel: "#alerts", message: "failed" });
  } finally {
    await tools.slack.send({ channel: "#audit", message: "done" });
  }`,
    );
    const after = flowSource(
      `  try {
    await tools.github.getNewPRs({ repo: input.repository });
    await tools.github.getFiles({ pr: input.repository });
  } catch (err) {
    await tools.slack.send({ channel: "#alerts", message: "failed" });
  } finally {
    await tools.slack.send({ channel: "#audit", message: "done" });
  }`,
    );
    const { before: first, after: second, changes, resolution } = await reanalyze(before, after);
    assertBijective(resolution);

    for (const path of [
      "flow/try[0]",
      "flow/try[0]/call:github.getFiles[0]",
      "flow/try[0]/catch/call:slack.send[0]",
      "flow/try[0]/finally/call:slack.send[0]",
    ]) {
      expect(nodeById(second, nodeByPath(first, path).id)?.source.semanticPath).toBe(path);
    }
    expect(changesOf(changes, "node.added")).toHaveLength(1);
    expect(changesOf(changes, "node.removed")).toEqual([]);
  });
});

describe("applyIdentity keeps the graph coherent", () => {
  it("remaps data.parentId and recomputes edge ids", async () => {
    const before = flowSource(
      `  for (const pr of input.repository) {
    await tools.slack.send({ channel: "#security", message: "one" });
  }`,
    );
    const after = flowSource(
      `  const first = input.repository.length;
  for (const pr of input.repository) {
    await tools.slack.send({ channel: "#security", message: "one" });
  }`,
    );
    const { after: second } = await reanalyze(before, after);
    const loop = nodeByPath(second, "flow/for[0]");
    const send = nodeByPath(second, "flow/for[0]/call:slack.send[0]");
    expect(send.data["parentId"]).toBe(loop.id);
    assertIntegrity(second);
  });

  it("never recycles the id of a removed node for a new one", () => {
    const registry = createSampleRegistry();
    const first = analyzeSource(
      flowSource(`  await tools.slack.send({ channel: "#security", message: "one" });`),
      registry,
    );
    const second = analyzeSource(
      flowSource(`  await tools.github.getFiles({ pr: input.repository });`),
      registry,
    );
    // Force the collision: pretend the fresh node's cold id is already spoken for.
    const resolution = resolveIdentity(first, second);
    const withCollision = {
      ...resolution,
      reserved: [...resolution.reserved, ...second.nodes.map((node) => node.id)],
    };
    const applied = applyIdentity(second, withCollision);
    const inherited = new Set(withCollision.mapping.values());
    for (const node of applied.nodes) {
      // A node that inherited nothing must not be handed an id already in use.
      if (inherited.has(node.id)) continue;
      expect(withCollision.reserved).not.toContain(node.id);
    }
    // The salting branch really fired: some node had to give up its cold id.
    expect(applied.nodes.map((node) => node.id)).not.toEqual(second.nodes.map((node) => node.id));
    assertIntegrity(applied);
  });

  it("does not mutate the graphs it is given", () => {
    const registry = createSampleRegistry();
    const first = analyzeSource(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "one" });`),
      registry,
    );
    const second = analyzeSource(
      flowSource(`  await tools.slack.send({ channel: "#b", message: "one" });`),
      registry,
    );
    const snapshot = JSON.stringify(second);
    applyIdentity(second, resolveIdentity(first, second));
    expect(JSON.stringify(second)).toBe(snapshot);
  });
});

/* -------------------------------------------------------------------------- */
/* corpus-wide properties (11 §3.3)                                            */
/* -------------------------------------------------------------------------- */

describe("across the whole fixture corpus", () => {
  for (const name of listFixtures()) {
    it(`${name}: re-analyzing the same source keeps every id and reports nothing`, async () => {
      const fixture = loadFixture(name);
      const session = createCodeFlow({ registry: fixture.registry });
      const first = await session.analyze(fixture.source, fixture.options);
      const second = await session.analyze(fixture.source, fixture.options);
      expect(idsOf(second)).toEqual(idsOf(first));
      expect(second.edges.map((edge) => edge.id)).toEqual(first.edges.map((edge) => edge.id));
      expect(session.lastChanges()).toEqual([]);
    });

    it(`${name}: an unrelated leading comment moves ranges, not identity`, async () => {
      const fixture = loadFixture(name);
      const session = createCodeFlow({ registry: fixture.registry });
      const first = await session.analyze(fixture.source, fixture.options);
      const second = await session.analyze(
        `// an unrelated comment\n${fixture.source}`,
        fixture.options,
      );

      expect(idsOf(second)).toEqual(idsOf(first));
      assertIntegrity(second);
      for (const change of session.lastChanges()) {
        expect(change.type).toBe("node.updated");
        expect(Object.keys(change.changes ?? {})).toEqual(["source"]);
      }
    });
  }
});

describe("session continuity vs cold determinism (03 §5.0)", () => {
  it("a session carries ids across; a cold analyze of the same source may differ", async () => {
    const registry = createSampleRegistry();
    const SEND = `  await tools.slack.send({ channel: "#security", message: "one" });`;
    const before = flowSource(SEND);
    const after = flowSource(
      `  await tools.slack.send({ channel: "#ops", message: "two" });\n${SEND}`,
    );

    const { before: first, after: second } = await reanalyze(before, after);
    const cold = analyzeSource(after, registry);

    const carried = nodeById(second, nodeByPath(first, "flow/call:slack.send[0]").id)!;
    expect(carried.source.semanticPath).toBe("flow/call:slack.send[1]");
    // Cold ids are a pure function of the semantic path — the session id is not.
    expect(nodeByPath(cold, "flow/call:slack.send[1]").id).not.toBe(carried.id);
    expect(idsOf(second).slice().sort()).not.toEqual(idsOf(cold).slice().sort());
  });
});
