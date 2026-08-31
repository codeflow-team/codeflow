/**
 * Registry instances for the gallery.
 *
 * An example names its registry by id (`FlowExample.registryId`); the registry
 * itself is a plain list of tool and function definitions (`ExampleRegistry`).
 * Turning one into a live `Registry` is this file's whole job, and the result is
 * cached: a registry's hash is what a graph is analyzed against (05 §2), so
 * rebuilding it per render would invalidate every patch.
 *
 * Core ships no tool of its own (00 §6.6b) — every name here belongs to the
 * examples package (or, until it lands, to the local fallback).
 */

import { createRegistry, type RegistryLookup } from "@codeflow-team/core";
import { REGISTRIES, registryFor, type ExampleRegistry, type FlowExample } from "./examples-source.js";

const cache = new Map<string, RegistryLookup>();

export function registryInstance(definition: ExampleRegistry): RegistryLookup {
  const cached = cache.get(definition.id);
  if (cached !== undefined) return cached;
  const built = createRegistry({ tools: definition.tools, functions: definition.functions });
  cache.set(definition.id, built);
  return built;
}

export function registryInstanceFor(example: FlowExample): RegistryLookup {
  return registryInstance(registryFor(example));
}

/**
 * The specs' canonical registry — GitHub + Slack, the one 01 §1 and 05 §4 are
 * written against. Kept as a named export for tests and scripts that want a
 * session without picking an example first.
 */
export const demoRegistry: RegistryLookup = registryInstance(
  REGISTRIES["sample"] ?? (Object.values(REGISTRIES)[0] as ExampleRegistry),
);
