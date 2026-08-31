/**
 * What "this node changed" is allowed to mean on the canvas.
 *
 * `CodeFlowProvider` highlights the node that was edited plus anything the
 * patch added, and deliberately **not** every `node.updated` of the graph diff.
 * The reason is mechanical: shifting a range by five characters marks every
 * node after the edit as updated, so highlighting all of them would tell the
 * user that steps they never touched had changed — the canvas version of the
 * lie O1 forbids. (That over-reporting was found and fixed during the editing
 * UI work; this file is what keeps the narrower rule.)
 *
 * The provider's state cannot be driven without a DOM (this package's test
 * environment is `node` and jsdom is not a dependency — see the `todo` at the
 * bottom), so what is locked here is the *contract the provider reads*: which
 * changes a real patch reports, and which nodes really did change text.
 */

import { describe, expect, it } from "vitest";
import {
  createCodeFlow,
  createRegistry,
  type GraphChange,
  type PatchResult,
  type WorkflowGraph,
} from "@codeflow-team/core";

const SOURCE = `import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#security", message: "m" });
  await tools.slack.send({ channel: "#audit", message: "m" });
  return prs;
}
`;

function registry() {
  return createRegistry({
    tools: [
      {
        name: "github.getNewPRs",
        label: "Get New PRs",
        inputSchema: { repo: "string" },
        outputSchema: "PullRequest[]",
        editableFields: ["repo"],
      },
      {
        name: "slack.send",
        label: "Slack Send",
        inputSchema: { channel: "string", message: "string" },
        editableFields: ["channel", "message"],
      },
    ],
  });
}

/** Exactly the rule `provider.tsx` applies to a `PatchResult`. */
function highlighted(nodeId: string, changes: readonly GraphChange[]): Set<string> {
  const touched = new Set<string>([nodeId]);
  for (const change of changes) {
    if (change.type === "node.added" && change.nodeId !== undefined) touched.add(change.nodeId);
  }
  return touched;
}

/** Node id → the source text it covers, so "did this node's code change" is answerable. */
function textByNode(graph: WorkflowGraph): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of graph.nodes) {
    out.set(node.id, graph.source.content.slice(node.source.start.offset, node.source.end.offset));
  }
  return out;
}

async function patch(changes: Record<string, unknown>, pick: (graph: WorkflowGraph) => string) {
  const session = createCodeFlow({ registry: registry() });
  const before = await session.analyze(SOURCE, { file: "flow.ts" });
  const nodeId = pick(before);
  const result: PatchResult = await session.patchNode(nodeId, changes);
  return { before, nodeId, result };
}

const firstSlack = (graph: WorkflowGraph): string =>
  graph.nodes.filter((node) => node.data["toolName"] === "slack.send")[0].id;

describe("the canvas highlights only what actually changed", () => {
  it("highlights exactly the edited node for a field edit", async () => {
    const { nodeId, result } = await patch({ channel: "#engineering" }, firstSlack);
    expect([...highlighted(nodeId, result.changes)]).toEqual([nodeId]);
  });

  it("marks more than the edited node as `node.updated` — which is why the filter exists", async () => {
    const { nodeId, result } = await patch({ channel: "#engineering-team" }, firstSlack);
    const updated = result.changes
      .filter((change) => change.type === "node.updated")
      .map((change) => change.nodeId);
    // The edit lengthened the line, so every node after it moved. If the canvas
    // read this list directly, three untouched steps would light up.
    expect(updated).toContain(nodeId);
    expect(updated.length).toBeGreaterThan(1);
    expect(highlighted(nodeId, result.changes).size).toBeLessThan(updated.length);
  });

  it("never highlights a node whose source text is byte-identical", async () => {
    const { before, nodeId, result } = await patch({ channel: "#engineering-team" }, firstSlack);
    const textBefore = textByNode(before);
    const textAfter = textByNode(result.graph);
    for (const id of highlighted(nodeId, result.changes)) {
      const wasThere = textBefore.get(id);
      // Added nodes have no "before" text; everything else must really differ.
      if (wasThere === undefined) continue;
      expect(textAfter.get(id), id).not.toBe(wasThere);
    }
  });

  it("highlights every node whose source text really did change", async () => {
    const { before, nodeId, result } = await patch({ channel: "#engineering-team" }, firstSlack);
    const textBefore = textByNode(before);
    const textAfter = textByNode(result.graph);
    const touched = highlighted(nodeId, result.changes);
    for (const [id, text] of textBefore) {
      const now = textAfter.get(id);
      if (now === undefined || now === text) continue;
      expect(touched.has(id), `${id} changed text but would not be highlighted`).toBe(true);
    }
  });

  it("highlights the inserted node as well as the anchor on a palette insert", async () => {
    const { nodeId, result } = await patch(
      { $insert: { tool: "slack.send", where: "after" } },
      (graph) => graph.nodes.find((node) => node.data["toolName"] === "github.getNewPRs")!.id,
    );
    const touched = highlighted(nodeId, result.changes);
    const added = result.changes
      .filter((change) => change.type === "node.added")
      .map((change) => change.nodeId!);
    expect(added).toHaveLength(1);
    expect([...touched].sort()).toEqual([nodeId, ...added].sort());
  });

  it("reports nothing at all for an edit that changes no bytes (I4)", async () => {
    const { result } = await patch({ channel: "#security" }, firstSlack);
    expect(result.patches).toEqual([]);
    expect(result.changes).toEqual([]);
  });

  it.todo(
    "DOM-level: after `patchNode` resolves, the canvas node for the edited step carries `is-changed` " +
      "and its unedited siblings do not. Needs a DOM to run the provider's state updates; jsdom is not " +
      "a dependency of @codeflow-team/react and adding one is out of scope for this pass. Until then the " +
      "browser checklist (11 §3.5) covers it and the rule above covers the data it reads.",
  );
});
