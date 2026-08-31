/**
 * `NodeDefinition.renderer` — the half of the renderer seam that draws a *node*.
 *
 * Core has declared this field since 05 §1 and typed it `unknown`, because core
 * is React-free. Until now nothing in this package read it: a declared
 * extension point that no consumer resolves is not an extension point, it is a
 * promise. This module resolves it, validates it (a host's registry is data,
 * and data can be wrong), and — the part that is easy to forget — makes the
 * *layout* aware of it.
 *
 * That last point is not decoration. `.cf-node` is `height: 100%; overflow:
 * hidden`, so a card is drawn inside exactly the box ELK was given; a body
 * whose height nothing measured is a body clipped in half. So a renderer
 * declares its height, `rendererMeasurer` folds that into `measureNode`, and
 * the card and the box agree the way they already do for every built-in row.
 *
 * A renderer that declares nothing gets `DEFAULT_NODE_BODY_HEIGHT` — a real
 * number rather than "as much as it wants", because there is no honest way to
 * lay out a box whose contents nobody can measure.
 */

import type { ComponentType } from "react";
import type { RegistryLookup, WorkflowNode } from "@codeflow-team/core";
import type { DisclosureMode } from "./summary.js";
import { measureNode, type Measurer } from "../layout/measure.js";

/** What a node renderer is handed. */
export interface NodeBodyProps {
  node: WorkflowNode;
  mode: DisclosureMode;
}

/**
 * A registered renderer: a component, or a component plus the height it needs.
 *
 * The bare-component form exists because it is what a host will write first;
 * it then gets the default height, and the object form is how it asks for more.
 */
export interface NodeBodySpec {
  height?: number;
  render: ComponentType<NodeBodyProps>;
}

export type NodeBodyRenderer = ComponentType<NodeBodyProps> | NodeBodySpec;

/** Body height for a renderer that does not declare one. Two settings rows. */
export const DEFAULT_NODE_BODY_HEIGHT = 44;

export interface ResolvedNodeRenderer {
  component: ComponentType<NodeBodyProps>;
  height: number;
}

/**
 * The renderer registered for `type`, or `null`.
 *
 * `renderer` arrives as `unknown` from core and is validated here rather than
 * cast: a malformed entry in a host's registry must show up as "no custom
 * renderer" — the card then draws its normal body — instead of as a crash on
 * the canvas.
 */
export function resolveNodeRenderer(
  registry: RegistryLookup | null | undefined,
  type: string,
): ResolvedNodeRenderer | null {
  const renderer = registry?.getNode(type)?.renderer;
  if (typeof renderer === "function") {
    return { component: renderer as ComponentType<NodeBodyProps>, height: DEFAULT_NODE_BODY_HEIGHT };
  }
  if (typeof renderer === "object" && renderer !== null) {
    const spec = renderer as { height?: unknown; render?: unknown };
    if (typeof spec.render !== "function") return null;
    const height =
      typeof spec.height === "number" && Number.isFinite(spec.height) && spec.height > 0
        ? spec.height
        : DEFAULT_NODE_BODY_HEIGHT;
    return { component: spec.render as ComponentType<NodeBodyProps>, height };
  }
  return null;
}

/**
 * A `Measurer` that knows about registered renderers.
 *
 * Handed to ELK (and to the React Flow mapping) so a custom node's card is laid
 * out at the size it will actually be drawn at. With no registry, or no
 * registered renderers, it is `measureNode` exactly.
 */
export function rendererMeasurer(registry: RegistryLookup | null | undefined): Measurer {
  return (node, mode, links, collapsedInner) => {
    // The beginner level draws no body at all (07 §4) — one line per step is
    // the whole point of that level, and a custom renderer does not get to
    // override it.
    if (mode === "compact" || (collapsedInner !== undefined && collapsedInner !== null)) {
      return measureNode(node, mode, links, collapsedInner);
    }
    const resolved = resolveNodeRenderer(registry, String(node.type));
    if (resolved === null) return measureNode(node, mode, links, collapsedInner);
    return measureNode(node, mode, links, collapsedInner, resolved.height);
  };
}
