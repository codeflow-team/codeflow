/**
 * The contract `@codeflow-team/examples` publishes, checked from the consumer side.
 *
 * A UI renders this package without reading its source: it takes `EXAMPLES`,
 * puts `title`/`summary`/`highlights` on a card, and hands `source` +
 * `registryFor(example)` to a session. Every assertion here is something that
 * consumer is entitled to assume — and the reason they live in *core*'s test
 * suite rather than the examples package's own is that the second half of the
 * contract ("this registry actually analyzes this flow") can only be checked
 * with the analyzer.
 */

import { describe, expect, it } from "vitest";

import { EXAMPLES, registryFor } from "./helpers.js";
import { createCodeFlow } from "../../src/session.js";
import { createRegistry } from "../../src/registry/index.js";

const CATEGORIES = ["basics", "control-flow", "real-mcp", "stress", "degradation"];

describe("FlowExample", () => {
  it("has stable, unique, kebab-case ids", () => {
    const ids = EXAMPLES.map((example) => example.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });

  it("fills in every field a gallery card needs", () => {
    for (const example of EXAMPLES) {
      expect(CATEGORIES, example.id).toContain(example.category);
      expect(example.title.length, example.id).toBeGreaterThan(3);
      expect(example.title.length, `${example.id}: title is a name, not a sentence`).toBeLessThan(50);
      expect(example.summary.length, example.id).toBeGreaterThan(20);
      expect(example.description.length, example.id).toBeGreaterThan(80);
      expect(example.highlights.length, example.id).toBeGreaterThanOrEqual(3);
      for (const highlight of example.highlights) {
        expect(highlight.length, `${example.id}: "${highlight}"`).toBeGreaterThan(10);
      }
    }
  });

  it("reports a line count that matches the source it ships", () => {
    for (const example of EXAMPLES) {
      expect(example.lines, example.id).toBe(example.source.replace(/\n$/, "").split("\n").length);
      expect(example.source.startsWith("import type { Tools }"), example.id).toBe(true);
      expect(example.source, example.id).toContain("export default async function flow(");
    }
  });

  it("gives the long flows more highlights than the short ones", () => {
    // Not decoration: the highlights are how a reader knows what to look for in
    // 300 lines, and a long example with three of them is an example nobody can
    // navigate.
    for (const example of EXAMPLES.filter((candidate) => candidate.lines >= 200)) {
      expect(example.highlights.length, example.id).toBeGreaterThanOrEqual(7);
    }
  });
});

describe("registryFor", () => {
  it("answers for every example", () => {
    for (const example of EXAMPLES) {
      const registry = registryFor(example);
      expect(registry.id, example.id).toBe(example.registryId);
      expect(registry.tools.length, example.id).toBeGreaterThan(0);
      expect(registry.label.length, example.id).toBeGreaterThan(5);
    }
  });

  it("throws rather than handing back an empty registry", () => {
    expect(() =>
      registryFor({ ...EXAMPLES[0], registryId: "nope" }),
    ).toThrow(/not in REGISTRIES/);
  });

  it("returns a registry `createRegistry` accepts as-is", () => {
    // The one-line integration a host writes: `createRegistry(registryFor(e))`.
    for (const example of EXAMPLES) {
      const { tools, functions } = registryFor(example);
      const registry = createRegistry({ tools, functions });
      expect(registry.listTools().length, example.id).toBe(tools.length);
      expect(registry.listFunctions().length, example.id).toBe(functions.length);
    }
  });
});

describe("the two halves fit together", () => {
  it("every example analyzes against the registry it names", async () => {
    for (const example of EXAMPLES) {
      const { tools, functions } = registryFor(example);
      const session = createCodeFlow({ registry: createRegistry({ tools, functions }) });
      const graph = await session.analyze(example.source, { file: `${example.id}.flow.ts` });
      expect(graph.nodes.length, example.id).toBeGreaterThan(3);
      // A flow-contract violation would mean the source is not a flow at all.
      const contract = graph.diagnostics.filter((diagnostic) =>
        diagnostic.code.startsWith("flow-"),
      );
      expect(contract, example.id).toEqual([]);
    }
  });

  it("every library function an example imports is in its registry", async () => {
    for (const example of EXAMPLES) {
      const imported = [...example.source.matchAll(/import \{([^}]+)\} from "@flows\/lib"/g)]
        .flatMap((match) => match[1].split(","))
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      const available = new Set(registryFor(example).functions.map((fn) => fn.name));
      for (const name of imported) {
        expect(available.has(name), `${example.id} imports ${name}`).toBe(true);
      }
    }
  });

  it("every registry's library function is used by at least one of its examples", () => {
    // An unused definition in a registry is an entry in the node palette that
    // nothing demonstrates — dead weight in a gallery.
    for (const example of EXAMPLES) {
      const registry = registryFor(example);
      const sources = EXAMPLES.filter(
        (candidate) => candidate.registryId === registry.id,
      ).map((candidate) => candidate.source);
      for (const fn of registry.functions) {
        expect(
          sources.some((source) => source.includes(fn.name)),
          `${registry.id}: nothing uses ${fn.name}`,
        ).toBe(true);
      }
    }
  });
});
