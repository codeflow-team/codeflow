/**
 * The adapters against a *real* graph from `@codeflow/core`, so the assumptions
 * they make about `data.parentId` / `data.parentSlot` stay honest.
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow, createRegistry } from "@codeflow/core";
import { toElkGraph } from "../src/layout/elk-graph.js";
import { toReactFlow } from "../src/flow/to-react-flow.js";
import { buildIndex } from "../src/graph/index.js";

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

function session() {
  const registry = createRegistry({
    tools: [
      { name: "github.getNewPRs", label: "Get New PRs", icon: "🐙", inputSchema: { repo: "string" }, outputSchema: "PullRequest[]", editableFields: ["repo"] },
      { name: "github.getFiles", label: "Get PR Files", icon: "🐙", inputSchema: { pr: "PullRequest" }, outputSchema: "File[]", editableFields: ["pr"] },
      { name: "slack.send", label: "Slack Send", icon: "💬", inputSchema: { channel: "string", message: "string" }, editableFields: ["channel", { name: "message", editor: "expression" }] },
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
  return createCodeFlow({ registry });
}

describe("canonical flow (07 §6) through the UI adapters", () => {
  it("nests the loop body under the loop in both ELK and React Flow", async () => {
    const graph = await session().analyze(SOURCE);
    const index = buildIndex(graph);

    const loop = graph.nodes.find((n) => n.type === "loop");
    expect(loop).toBeDefined();
    const bodyIds = (index.childrenOf.get(loop!.id) ?? []).map((n) => n.type);
    expect(bodyIds).toEqual(["tool", "condition", "tool"]);

    const { root } = toElkGraph(graph, { mode: "expanded", index });
    const rootChildren = (root.children ?? []).map((c) => c.id);
    expect(rootChildren).toContain(loop!.id);
    expect(rootChildren).not.toContain(index.childrenOf.get(loop!.id)![0].id);

    const elkLoop = (root.children ?? []).find((c) => c.id === loop!.id);
    expect((elkLoop?.children ?? []).length).toBe(3);

    const { nodes, edges } = toReactFlow(graph, { mode: "expanded", index });
    expect(nodes).toHaveLength(graph.nodes.length);
    expect(edges).toHaveLength(graph.edges.length);
    for (const child of index.childrenOf.get(loop!.id) ?? []) {
      expect(nodes.find((n) => n.id === child.id)?.parentId).toBe(loop!.id);
    }
  });

  it("labels the branch and the data edges the way the spec draws them", async () => {
    const graph = await session().analyze(SOURCE);
    // `all` is the view that draws the whole data layer; the branch labels are
    // there in every view because they are the only place the diagram says
    // which way a decision goes.
    const { edges } = toReactFlow(graph, { mode: "expanded", dataEdges: "all" });
    const labels = edges.map((e) => e.label).filter((l) => l !== undefined);
    expect(labels).toContain("true");
    expect(labels).toContain("body");

    /*
     * A data edge's value name is carried on the edge whether or not it is
     * *printed* on the canvas: printing 131 of them was the clutter this view
     * was changed to fix, so the name rides in `data.value` and is promoted to
     * a visible label only while the edge is focused. Nothing is lost — the
     * node card and the inspector both name it in words.
     */
    const values = edges.map((e) => e.data?.value).filter((v) => v !== undefined);
    expect(values).toContain("prs");
    expect(values).toContain("input.repository");

    const dataEdge = edges.find((e) => e.data?.value === "prs");
    const focused = toReactFlow(graph, {
      mode: "expanded",
      dataEdges: "all",
      selectedNodeId: dataEdge!.source,
    }).edges.find((e) => e.id === dataEdge!.id);
    expect(focused?.label).toBe("prs");
  });
});
