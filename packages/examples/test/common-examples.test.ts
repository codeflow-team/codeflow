/**
 * The two flows written against the `common` registry, checked as a consumer
 * sees them: analyzed, scored, and read for the shapes their cards promise.
 *
 * `packages/core/test/stress` already checks the corpus as a whole — node
 * censuses, identity, patch round-trips, and the type-check against each
 * registry's generated `tools.d.ts`. What is left, and what lives here because
 * it is about *these two flows* rather than about the analyzer, is the claim the
 * gallery cards make: that the everyday steps compose into something an editor
 * can open, that the loop really does carry a per-iteration agent step, and that
 * both flows sit at the top of the conformance ladder rather than merely
 * parsing.
 *
 * L2 (10 §5) is not decoration here: it means every call resolved against the
 * registry and no step is hidden inside a code node. A flow full of code nodes
 * would still run — it would just have nothing for a node editor to edit, which
 * is the one thing these two exist to provide.
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow, createRegistry } from "@codeflow/core";

import { EXAMPLES, REGISTRIES, registryFor } from "../src/index.js";
import type { FlowExample } from "../src/types.js";

const COMMON_EXAMPLES = EXAMPLES.filter((example) => example.registryId === "common");

async function open(example: FlowExample) {
  const { tools, functions } = registryFor(example);
  const session = createCodeFlow({ registry: createRegistry({ tools, functions }) });
  const graph = await session.analyze(example.source, { file: `${example.id}.flow.ts` });
  const validation = await session.validate(example.source, { file: `${example.id}.flow.ts` });
  return { graph, validation };
}

describe("the common registry's flows", () => {
  it("are the two the gallery advertises", () => {
    expect(COMMON_EXAMPLES.map((example) => example.id)).toEqual([
      "everyday-order-digest",
      "ticket-triage-agent",
    ]);
  });

  it("stay short enough to read — the point of the small one especially", () => {
    const digest = COMMON_EXAMPLES.find((example) => example.id === "everyday-order-digest")!;
    expect(digest.lines).toBeLessThan(80);
    for (const example of COMMON_EXAMPLES) expect(example.lines, example.id).toBeLessThan(200);
  });

  it("use every library function the registry offers", () => {
    // An entry in the palette that no example demonstrates is an entry nobody
    // can learn from. Core asserts this for the corpus; asserting it here means
    // a function added to `common` fails in its own package first.
    const sources = COMMON_EXAMPLES.map((example) => example.source).join("\n");
    for (const fn of REGISTRIES["common"].functions) {
      expect(sources.includes(`${fn.name}(`), `nothing calls ${fn.name}`).toBe(true);
    }
  });

  it.each(COMMON_EXAMPLES.map((example) => [example.id, example] as const))(
    "%s analyzes cleanly and reaches L2",
    async (id, example) => {
      const { graph, validation } = await open(example);
      expect(graph.nodes.length, id).toBeGreaterThan(8);
      expect(
        graph.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
        id,
      ).toEqual([]);
      expect(
        validation.level,
        `${id}: ${validation.diagnostics
          .filter((diagnostic) => diagnostic.severity !== "info")
          .map((diagnostic) => `${diagnostic.code} — ${diagnostic.message}`)
          .join("\n")}`,
      ).toBe("L2");
    },
  );

  it("projects every library call as a function node, not as opaque code", async () => {
    for (const example of COMMON_EXAMPLES) {
      const { graph } = await open(example);
      const names = new Set(
        graph.nodes
          .filter((node) => node.type === "function")
          .map((node) => String(node.data["functionName"])),
      );
      const imported = [...example.source.matchAll(/^  ([a-zA-Z]+),?$/gm)].map((match) => match[1]);
      expect(imported.length, example.id).toBeGreaterThan(5);
      for (const name of imported) {
        expect(names.has(name), `${example.id}: ${name} is not a function node`).toBe(true);
      }
    }
  });
});

describe("ticket-triage-agent", () => {
  it("puts the agent step inside the loop — the per-iteration shape", async () => {
    const example = EXAMPLES.find((candidate) => candidate.id === "ticket-triage-agent")!;
    const { graph } = await open(example);

    const loops = graph.nodes.filter((node) => node.type === "loop");
    expect(loops).toHaveLength(1);

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const inLoop = (nodeId: string): boolean => {
      let current = byId.get(nodeId);
      for (let depth = 0; depth < 20 && current !== undefined; depth++) {
        const parentId = current.data["parentId"];
        if (typeof parentId !== "string") return false;
        if (parentId === loops[0].id) return true;
        current = byId.get(parentId);
      }
      return false;
    };

    // The four steps a reader is promised happen once per ticket.
    for (const name of ["dateTimeStep", "formatText", "runAgentStep", "setFields"]) {
      const node = graph.nodes.find((candidate) => candidate.data["functionName"] === name);
      expect(node, `no ${name} node`).toBeDefined();
      expect(inLoop(node!.id), `${name} is not inside the loop`).toBe(true);
    }
  });

  it("labels the agent node as a stand-in wherever the label is rendered", async () => {
    const example = EXAMPLES.find((candidate) => candidate.id === "ticket-triage-agent")!;
    const { graph } = await open(example);
    const agent = graph.nodes.find((node) => node.data["functionName"] === "runAgentStep")!;
    // The node's label comes straight from the definition (05 §4), so this is
    // what the canvas prints under the icon.
    expect(agent.label.toLowerCase()).toContain("no model is called");
  });
});
