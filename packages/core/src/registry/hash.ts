/**
 * Registry fingerprint — 05-registry.md §2.
 *
 * Deterministic over registry *content*: entries are sorted, object keys are
 * sorted, and function references (analyzer/patcher/renderer) are excluded — they
 * are behaviour, not identity, and are not serializable anyway.
 */

import { canonicalJson } from "../util/canonical-json.js";
import { sha256Hex } from "../util/sha256.js";
import type { RegisteredFunction, RegisteredNode, RegisteredTool } from "./definitions.js";

const FORMAT = "codeflow.registry.v1";

function byKey<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export interface RegistryContent {
  tools: readonly RegisteredTool[];
  functions: readonly RegisteredFunction[];
  nodes: readonly RegisteredNode[];
}

export function computeRegistryHash(content: RegistryContent): string {
  const payload = {
    format: FORMAT,
    tools: byKey(content.tools, (t) => t.name).map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      icon: tool.icon,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      editableFields: tool.editableFields,
    })),
    functions: byKey(content.functions, (f) => f.name).map((fn) => ({
      name: fn.name,
      label: fn.label,
      description: fn.description,
      icon: fn.icon,
      inputSchema: fn.inputSchema,
      outputSchema: fn.outputSchema,
      code: fn.code,
      modulePath: fn.modulePath,
      editableFields: fn.editableFields,
    })),
    nodes: byKey(content.nodes, (n) => n.type).map((node) => ({
      type: node.type,
      label: node.label,
      description: node.description,
      inputSchema: node.inputSchema,
      outputSchema: node.outputSchema,
      editableFields: node.editableFields,
    })),
  };
  return sha256Hex(canonicalJson(payload));
}
