/**
 * Accessibility of the inspector's form controls.
 *
 * From the e2e session: DevTools reported "a form field element should have an
 * id or name attribute" on every input in `<NodeInspector>`. The controls were
 * wrapped in a `<label>`, which associates them implicitly, but that leaves the
 * control anonymous — no `htmlFor` relationship for assistive tech, no key for
 * autofill, no stable handle for a test or a script.
 *
 * There is no DOM in this package's test environment (`environment: "node"`,
 * and jsdom is not a dependency), so the assertions run over server-rendered
 * markup. That is enough for structure — ids, names and `for` — and is honest
 * about what it is not: nothing here exercises interaction.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCodeFlow, createRegistry, type WorkflowGraph, type WorkflowNode } from "@codeflow/core";
import { CodeFlowProvider } from "../../src/context/provider.js";
import { NodeInspector } from "../../src/inspector/NodeInspector.js";

const SOURCE = `import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of prs) {
    await tools.slack.send({ channel: "#security", message: \`PR \${pr.title}\` });
  }
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
        inputSchema: { channel: "string", message: "string", urgent: "boolean" },
        editableFields: ["channel", { name: "message", editor: "expression" }, "urgent"],
      },
    ],
  });
}

async function render(pick: (graph: WorkflowGraph) => WorkflowNode): Promise<string> {
  const session = createCodeFlow({ registry: registry() });
  const graph = await session.analyze(SOURCE, { file: "flow.ts" });
  return renderToStaticMarkup(
    createElement(
      CodeFlowProvider,
      {
        graph,
        session,
        source: SOURCE,
        selectedNodeId: pick(graph).id,
        onPatched: () => undefined,
        children: createElement(NodeInspector, {}),
      },
    ),
  );
}

const toolNode = (name: string) => (graph: WorkflowGraph): WorkflowNode => {
  const node = graph.nodes.find((candidate) => candidate.data["toolName"] === name);
  if (node === undefined) throw new Error(`no ${name} node`);
  return node;
};

/** Every `<input>`, `<textarea>` and `<select>` in the markup, as raw tags. */
function formControls(html: string): string[] {
  return html.match(/<(?:input|textarea|select)\b[^>]*>/g) ?? [];
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match === null ? null : match[1];
}

/** Ids that a `<label for=…>` in the markup points at. */
function labelledIds(html: string): Set<string> {
  const out = new Set<string>();
  for (const match of html.matchAll(/<label\b[^>]*\sfor="([^"]*)"/g)) out.add(match[1]);
  return out;
}

describe("every form control in the inspector is identified and labelled", () => {
  it("gives each control an id and a name", async () => {
    const html = await render(toolNode("slack.send"));
    const controls = formControls(html);
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(attribute(control, "id"), control).not.toBeNull();
      expect(attribute(control, "name"), control).not.toBeNull();
      expect(attribute(control, "id")).not.toBe("");
      expect(attribute(control, "name")).not.toBe("");
    }
  });

  it("points a <label for> at every control", async () => {
    const html = await render(toolNode("slack.send"));
    const labelled = labelledIds(html);
    for (const control of formControls(html)) {
      expect(labelled.has(attribute(control, "id")!), control).toBe(true);
    }
  });

  it("names each field control after its field", async () => {
    const html = await render(toolNode("slack.send"));
    const names = formControls(html).map((control) => attribute(control, "name"));
    expect(names).toContain("channel");
    expect(names).toContain("message");
    expect(names).toContain("urgent");
    // The non-field controls of the panel are identified too.
    expect(names).toContain("preview");
    expect(names).toContain("tool");
  });

  it("scopes the ids by node so two inspectors on one page cannot collide", async () => {
    const slack = await render(toolNode("slack.send"));
    const github = await render(toolNode("github.getNewPRs"));
    const idsOf = (html: string): string[] =>
      formControls(html).map((control) => attribute(control, "id")!);
    const shared = idsOf(slack).filter((id) => idsOf(github).includes(id));
    expect(shared).toEqual([]);
  });

  it("produces ids that are valid HTML id attributes", async () => {
    const html = await render(toolNode("slack.send"));
    for (const control of formControls(html)) {
      // No whitespace, no quotes — the things that would break `htmlFor` or a
      // selector built from the id.
      expect(attribute(control, "id")).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    }
  });

  it("keeps the field label text next to its control", async () => {
    const html = await render(toolNode("slack.send"));
    // Regression guard for the fix itself: the label element must still carry
    // the field name, or the a11y fix would have traded one problem for another.
    // The class list and the capitalisation are presentation (the label is
    // title-cased for reading); the marker class and the name are the contract.
    expect(html).toMatch(/<label[^>]*class="[^"]*\bcf-field__label\b[^"]*"[^>]*>channel/i);
    expect(html).toMatch(/<label[^>]*class="[^"]*\bcf-field__label\b[^"]*"[^>]*>message/i);
  });

  it("keeps a single labelling element per control — no duplicate labels", async () => {
    const html = await render(toolNode("slack.send"));
    const counts = new Map<string, number>();
    for (const match of html.matchAll(/<label\b[^>]*\sfor="([^"]*)"/g)) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
    for (const [id, count] of counts) expect(count, id).toBe(1);
  });

  it("still renders the empty state without any unlabelled control", async () => {
    const session = createCodeFlow({ registry: registry() });
    const graph = await session.analyze(SOURCE, { file: "flow.ts" });
    const html = renderToStaticMarkup(
      createElement(CodeFlowProvider, {
        graph,
        session,
        source: SOURCE,
        selectedNodeId: null,
        children: createElement(NodeInspector, {}),
      }),
    );
    expect(formControls(html)).toEqual([]);
    expect(html).toContain("Nothing selected");
  });
});
