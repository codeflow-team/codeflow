/**
 * Golden fixture harness — 11-testing.md §3.2.
 *
 * A fixture is a self-contained directory:
 *
 *     fixtures/<case>/input.flow.ts        flow source
 *     fixtures/<case>/registry.json        declarative registry (no hooks)
 *     fixtures/<case>/expected-graph.json  reviewed expected graph
 *
 * `expected-graph.json` holds a *normalized* graph so it stays reviewable by
 * hand: opaque hashes are replaced by references that carry the same
 * information. Specifically
 *
 *   - node ids become `#<semanticPath>` (the id is a pure function of the path
 *     on the cold path — 03 §5.0 — and that derivation is asserted separately);
 *   - edge ids are dropped (derived from source/target/kind/ports, asserted
 *     separately) and edges are keyed by their endpoints;
 *   - every 64-hex fingerprint becomes `sha256#K`, K being the index of its
 *     first occurrence — preserving count, distinctness and cross-references;
 *   - `source.content`, `contentHash`, `registryHash`, `version` and `graph.id`
 *     are derived values asserted separately rather than duplicated here.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRegistry,
  type Registry,
  type ToolDefinition,
  type FunctionDefinition,
  type NodeDefinition,
} from "../../src/registry/index.js";
import type { WorkflowGraph, WorkflowNode } from "../../src/model/index.js";
import type { AnalyzeOptions } from "../../src/model/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const FIXTURES_DIR = join(HERE, "..", "fixtures");

export interface FixtureRegistryJson {
  tools?: ToolDefinition[];
  functions?: FunctionDefinition[];
  nodes?: NodeDefinition[];
}

export interface Fixture {
  name: string;
  dir: string;
  source: string;
  registry: Registry;
  expected: NormalizedGraph | null;
  options: AnalyzeOptions;
}

export const FIXTURE_FILE = "input.flow.ts";

export function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function loadFixture(name: string): Fixture {
  const dir = join(FIXTURES_DIR, name);
  const source = readFileSync(join(dir, "input.flow.ts"), "utf8");
  const registryJson = JSON.parse(
    readFileSync(join(dir, "registry.json"), "utf8"),
  ) as FixtureRegistryJson;
  const registry = createRegistry({
    tools: registryJson.tools ?? [],
    functions: registryJson.functions ?? [],
    nodes: registryJson.nodes ?? [],
  });

  const expectedPath = join(dir, "expected-graph.json");
  const expected = existsSync(expectedPath)
    ? (JSON.parse(readFileSync(expectedPath, "utf8")) as NormalizedGraph)
    : null;

  const optionsPath = join(dir, "options.json");
  const options: AnalyzeOptions = existsSync(optionsPath)
    ? (JSON.parse(readFileSync(optionsPath, "utf8")) as AnalyzeOptions)
    : {};

  return { name, dir, source, registry, expected, options: { file: FIXTURE_FILE, ...options } };
}

/* -------------------------------------------------------------------------- */
/* normalization                                                               */
/* -------------------------------------------------------------------------- */

export interface NormalizedNode {
  path: string;
  type: string;
  label: string;
  range: { start: [number, number, number]; end: [number, number, number] };
  fingerprint: string;
  inputs: unknown[];
  outputs: unknown[];
  data: Record<string, unknown>;
  capabilities: Record<string, boolean>;
}

export interface NormalizedEdge {
  from: string;
  to: string;
  kind: string;
  sourcePort?: string;
  targetPort?: string;
  label?: string;
}

export interface NormalizedGraph {
  nodes: NormalizedNode[];
  edges: NormalizedEdge[];
  diagnostics: {
    severity: string;
    code: string;
    message: string;
    at?: string;
  }[];
}

const HEX64 = /^[0-9a-f]{64}$/;

class HashTable {
  private readonly seen = new Map<string, string>();
  intern(hash: string): string {
    let key = this.seen.get(hash);
    if (key === undefined) {
      key = `sha256#${String(this.seen.size)}`;
      this.seen.set(hash, key);
    }
    return key;
  }
}

function mapDeep(value: unknown, ids: Map<string, string>, hashes: HashTable): unknown {
  if (typeof value === "string") {
    const mapped = ids.get(value);
    if (mapped !== undefined) return mapped;
    if (HEX64.test(value)) return hashes.intern(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => mapDeep(item, ids, hashes));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = mapDeep((value as Record<string, unknown>)[key], ids, hashes);
    }
    return out;
  }
  return value;
}

function nodeRef(node: WorkflowNode): string {
  return `#${node.source.semanticPath}`;
}

export function normalizeGraph(graph: WorkflowGraph): NormalizedGraph {
  const ids = new Map<string, string>();
  for (const node of graph.nodes) ids.set(node.id, nodeRef(node));
  const hashes = new HashTable();

  const nodes: NormalizedNode[] = graph.nodes
    .map((node) => ({
      path: node.source.semanticPath,
      type: node.type,
      label: node.label,
      range: {
        start: [node.source.start.line, node.source.start.column, node.source.start.offset] as [
          number,
          number,
          number,
        ],
        end: [node.source.end.line, node.source.end.column, node.source.end.offset] as [
          number,
          number,
          number,
        ],
      },
      fingerprint: hashes.intern(node.source.fingerprint),
      inputs: mapDeep(node.inputs, ids, hashes) as unknown[],
      outputs: mapDeep(node.outputs, ids, hashes) as unknown[],
      data: mapDeep(node.data, ids, hashes) as Record<string, unknown>,
      capabilities: { ...node.capabilities },
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const edges: NormalizedEdge[] = graph.edges
    .map((edge) => {
      const normalized: NormalizedEdge = {
        from: ids.get(edge.source) ?? edge.source,
        to: ids.get(edge.target) ?? edge.target,
        kind: edge.kind,
      };
      if (edge.sourcePort !== undefined) normalized.sourcePort = edge.sourcePort;
      if (edge.targetPort !== undefined) normalized.targetPort = edge.targetPort;
      if (edge.label !== undefined) normalized.label = edge.label;
      return normalized;
    })
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

  const diagnostics = graph.diagnostics
    .map((diagnostic) => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.source === undefined ? {} : { at: diagnostic.source.semanticPath }),
    }))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

  return { nodes, edges, diagnostics };
}
