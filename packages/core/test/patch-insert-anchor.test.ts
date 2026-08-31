/**
 * Where an inserted statement is allowed to land — 06 §2, invariant I6.
 *
 * `isUnbracedBody` has guarded the *delete* path since it was written, for the
 * reason spelled out on it: removing the brace-less body of a branch promotes
 * whatever comes next into that branch. The insert path had no such guard, and
 * the same shape produced the mirror-image failure — a step the user aimed at
 * one branch running unconditionally, with the re-analyzed graph faithfully
 * showing the file, so nothing anywhere reported the gesture had done something
 * else. Both reproductions below are permanent tests now.
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow } from "../src/session.js";
import { CodeFlowError } from "../src/errors.js";
import { createSampleRegistry } from "./fixtures.js";
import type { WorkflowGraph, WorkflowNode } from "../src/model/index.js";

const FILE = "flow.ts";

function flowSource(body: string): string {
  return `import type { Tools } from "../generated/tools";
export default async function flow(input: { repository: string }, tools: Tools) {
${body}
}
`;
}

async function open(source: string) {
  const session = createCodeFlow({ registry: createSampleRegistry() });
  const graph = await session.analyze(source, { file: FILE });
  return { session, graph, source };
}

function node(graph: WorkflowGraph, path: string): WorkflowNode {
  const found = graph.nodes.find((candidate) => candidate.source.semanticPath === path);
  expect(found, `no node at ${path}`).toBeDefined();
  return found!;
}

async function refusal(promise: Promise<unknown>): Promise<CodeFlowError> {
  const caught = await promise.catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(CodeFlowError);
  return caught as CodeFlowError;
}

const INSERT = {
  tool: "slack.send",
  arguments: { channel: "#b", message: "x" },
} as const;

/* -------------------------------------------------------------------------- */
/* the brace-less branch body                                                  */
/* -------------------------------------------------------------------------- */

const UNBRACED = flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of prs) {
    if (pr.draft) await tools.slack.send({ channel: "#draft", message: "d" });
  }`);

describe("inserting next to the brace-less body of a branch", () => {
  it("refuses `after` — the step would run for every item, not just drafts", async () => {
    const { session, graph } = await open(UNBRACED);
    const error = await refusal(
      session.patchNode(node(graph, "flow/for[0]/if[0]/call:slack.send[0]").id, {
        $insert: { ...INSERT, where: "after" },
      }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("no block of its own");
    expect(error.message).toContain("Add braces to the branch first");
  });

  it("refuses `before` — the same structural problem, not a special case", async () => {
    const { session, graph } = await open(UNBRACED);
    const error = await refusal(
      session.patchNode(node(graph, "flow/for[0]/if[0]/call:slack.send[0]").id, {
        $insert: { ...INSERT, where: "before" },
      }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("no block of its own");
  });

  it("leaves the source byte-identical when it refuses", async () => {
    const { session, graph, source } = await open(UNBRACED);
    await refusal(
      session.patchNode(node(graph, "flow/for[0]/if[0]/call:slack.send[0]").id, {
        $insert: { ...INSERT, where: "after" },
      }),
    );
    expect(session.getGraph()?.source.content).toBe(source);
    expect(session.getGraph()?.source.content).toBe(UNBRACED);
  });

  it("still inserts into a properly braced branch — the guard does not over-refuse", async () => {
    const braced = flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of prs) {
    if (pr.draft) {
      await tools.slack.send({ channel: "#draft", message: "d" });
    }
  }`);
    const { session, graph } = await open(braced);
    const result = await session.patchNode(node(graph, "flow/for[0]/if[0]/call:slack.send[0]").id, {
      $insert: { ...INSERT, where: "after" },
    });
    // The new statement lands inside the braces, indented with its neighbour.
    expect(result.source).toBe(
      braced.replace(
        `      await tools.slack.send({ channel: "#draft", message: "d" });\n`,
        `      await tools.slack.send({ channel: "#draft", message: "d" });\n      await tools.slack.send({ channel: "#b", message: "x" });\n`,
      ),
    );
  });

  it("still appends into a braced branch through the container node", async () => {
    const { session, graph } = await open(
      flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of prs) {
    await tools.slack.send({ channel: "#a", message: "b" });
  }`),
    );
    const result = await session.patchNode(node(graph, "flow/for[0]").id, {
      $insert: { ...INSERT, where: "append", slot: "body" },
    });
    expect(result.source).toContain('    await tools.slack.send({ channel: "#b", message: "x" });\n  }');
  });
});

/* -------------------------------------------------------------------------- */
/* terminal statements                                                         */
/* -------------------------------------------------------------------------- */

describe("inserting after a statement nothing can follow", () => {
  const withContinue = flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of prs) {
    if (pr.draft) {
      continue;
    }
    await tools.slack.send({ channel: "#a", message: "b" });
  }`);

  it("refuses `after` a `continue` and points at `before`", async () => {
    const { session, graph, source } = await open(withContinue);
    const error = await refusal(
      session.patchNode(node(graph, "flow/for[0]/if[0]/continue[0]").id, {
        $insert: { ...INSERT, where: "after" },
      }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("Nothing runs after");
    expect(error.message).toContain("before");
    expect(session.getGraph()?.source.content).toBe(source);
  });

  it("refuses `after` a `continue` that is itself a brace-less body", async () => {
    // The original reproduction: `if (pr.draft) continue;`. Relocating the new
    // step into the branch is not the fix either — it would be unreachable.
    const { session, graph } = await open(
      flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of prs) {
    if (pr.draft) continue;
    await tools.slack.send({ channel: "#a", message: "b" });
  }`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/for[0]/if[0]/continue[0]").id, {
        $insert: { ...INSERT, where: "after" },
      }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("Nothing runs after");
  });

  it("refuses `after` an explicit return — that code would be unreachable", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });
  return 1;`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/return[0]").id, { $insert: { ...INSERT, where: "after" } }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("Nothing runs after");
  });

  it("refuses `after` the synthetic end-of-flow node, and names the way out", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow#output").id, { $insert: { ...INSERT, where: "after" } }),
    );
    // Previously a `patch-conflict` about statement boundaries — true of the
    // implementation, meaningless to the caller.
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("append");
  });

  it("still allows `before` a terminal statement", async () => {
    const { session, graph } = await open(withContinue);
    const result = await session.patchNode(node(graph, "flow/for[0]/if[0]/continue[0]").id, {
      $insert: { ...INSERT, where: "before" },
    });
    expect(result.source).toContain(
      `      await tools.slack.send({ channel: "#b", message: "x" });\n      continue;`,
    );
  });
});
