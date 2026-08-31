/**
 * Where a step's values come from, and where they go — as *words*.
 *
 * The canvas used to answer that question only with lines: one dashed edge per
 * value, drawn between the two nodes. On the flows this product exists for that
 * is 131–172 dashed lines, and two thirds of them cross a `for`/`try` frame, so
 * they are drawn straight across the whole diagram. The control flow — the one
 * thing a non-developer reads a flow diagram for — disappeared underneath them.
 *
 * So data edges are hidden by default (see `DataEdgeMode`), and this module is
 * the reason that is not a loss of information: every hidden edge is restated on
 * the node itself as `Takes  dropPath ← Get File Info`, using the *name of the
 * step* rather than its id. The user still learns where the value came from;
 * they read it instead of tracing it.
 */

import type { WorkflowGraph } from "@codeflow-team/core";
import type { GraphIndex } from "../graph/index.js";

/** One end of a data edge, seen from the node this link is listed on. */
export interface DataLink {
  edgeId: string;
  /** The node at the *other* end. */
  nodeId: string;
  /** That node's human label — never its id (07 §4: names, not identifiers). */
  nodeLabel: string;
  /** The value travelling along the edge, when the graph named one. */
  value: string;
}

export interface NodeDataLinks {
  /** Values this step receives, in graph order. */
  incoming: DataLink[];
  /** Values this step hands on. */
  outgoing: DataLink[];
}

export const EMPTY_DATA_LINKS: NodeDataLinks = { incoming: [], outgoing: [] };

/**
 * How much of the data layer the canvas is drawing right now.
 *
 * - `none` — a clean control spine and nothing else. Not used by the shipped
 *   levels: even the beginner one reveals the selected step's own values, and
 *   this stays for a host that wants the spine and nothing but the spine.
 * - `selected` — only the edges touching the selected step, highlighted. The
 *   default at every disclosure level, because it is the moment data flow is
 *   genuinely useful: one step is being examined, and the question is where its
 *   input came from.
 * - `all` — the power-user override behind "Show data links". Even here the
 *   data layer is drawn much fainter than the control layer: control is the
 *   spine of the picture, data is annotation on it.
 */
export type DataEdgeMode = "none" | "selected" | "all";

/**
 * The rule the provider applies — one line, in one place, so it can be tested.
 *
 * Select-to-reveal at **every** disclosure level. An earlier pass tied it to the
 * level and made Simple mean "no data edges ever", which read progressive
 * disclosure backwards: the question a beginner asks first is "where does this
 * step get its input from", and pointing at a step is how they ask it. Four to
 * seven lines answer it and clutter nothing. What clutters is all 172 at once —
 * and that is what the toggle is for, at every level equally.
 */
export function resolveDataEdgeMode(showDataLinks: boolean): DataEdgeMode {
  return showDataLinks ? "all" : "selected";
}

/**
 * Index every data edge by both of its endpoints.
 *
 * Pure and DOM-free: the same map feeds the node body, the size the layout
 * measures that body at, and the inspector's "Data" section, so the three can
 * never disagree about what a step takes.
 */
export function buildDataLinks(
  graph: WorkflowGraph | null | undefined,
  index: GraphIndex,
): Map<string, NodeDataLinks> {
  const out = new Map<string, NodeDataLinks>();
  if (graph === null || graph === undefined) return out;

  const bucket = (id: string): NodeDataLinks => {
    let found = out.get(id);
    if (found === undefined) {
      found = { incoming: [], outgoing: [] };
      out.set(id, found);
    }
    return found;
  };
  const labelOf = (id: string): string => index.nodeById.get(id)?.label ?? id;

  for (const edge of graph.edges) {
    if (edge.kind !== "data") continue;
    // A self-edge would render as "takes x from itself", which says nothing.
    if (edge.source === edge.target) continue;
    const value = edge.label ?? "";
    bucket(edge.target).incoming.push({
      edgeId: edge.id,
      nodeId: edge.source,
      nodeLabel: labelOf(edge.source),
      value,
    });
    bucket(edge.source).outgoing.push({
      edgeId: edge.id,
      nodeId: edge.target,
      nodeLabel: labelOf(edge.target),
      value,
    });
  }
  return out;
}

/**
 * How many `Takes` rows a node card will show before it starts summarising.
 *
 * Three is where the card stops being a card. Past that the rest is counted
 * rather than dropped — "+4 more" is a true statement that sends the reader to
 * the inspector, which lists all of them.
 */
export const MAX_TAKES_ROWS = 3;

/** `dropPath ← Get File Info`, the text form of one incoming data edge. */
export function takesText(link: DataLink): string {
  return link.value.length === 0 ? `← ${link.nodeLabel}` : `${link.value} ← ${link.nodeLabel}`;
}

/**
 * Collapse the incoming links into the lines a node card shows.
 *
 * Two values arriving from the same step are one line (`a, b ← Get File Info`):
 * the interesting fact is the step, and repeating its name three times spends
 * the card's width on the part the reader already has.
 */
export function takesLines(links: NodeDataLinks | null | undefined): string[] {
  if (links === undefined || links === null || links.incoming.length === 0) return [];
  const bySource = new Map<string, { label: string; values: string[] }>();
  for (const link of links.incoming) {
    const found = bySource.get(link.nodeId);
    if (found === undefined) bySource.set(link.nodeId, { label: link.nodeLabel, values: link.value.length === 0 ? [] : [link.value] });
    else if (link.value.length > 0 && !found.values.includes(link.value)) found.values.push(link.value);
  }
  const lines: string[] = [];
  for (const { label, values } of bySource.values()) {
    lines.push(values.length === 0 ? `← ${label}` : `${values.join(", ")} ← ${label}`);
  }
  return lines;
}
