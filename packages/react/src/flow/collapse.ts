/**
 * Folding a `for` / `while` / `try` into one box — and why a large flow arrives
 * folded.
 *
 * The canvas used to answer "show me this flow" by fitting all of it on screen.
 * On the flows this product exists for that means 101 steps at zoom 0.41, where
 * a 13px step name renders at five pixels: the whole graph, and not one word of
 * it. **A fit you cannot read is not a fit.**
 *
 * So the canvas now prefers *readable* over *complete*, and this module is what
 * makes that affordable. A container is a real structural unit of the flow —
 * "for each test case, do these twelve things" — and folding it says exactly
 * that, in one box, at full size. A 101-step flow becomes eight big steps a
 * non-developer can read, with every one of them one click from opening.
 *
 * Three promises hold it up, and they are the whole reason this is a
 * decluttering rather than a hiding:
 *
 * - **It never lies about size.** The count on a folded box is the true number
 *   of steps inside it, counted recursively — `innerCount`.
 * - **It never traps anything.** Anything that can address a node — the
 *   outline, the code panel's caret, a diagnostic, a failed run, a patch —
 *   goes through `expandFor`, which opens every fold between the node and the
 *   canvas before the selection lands.
 * - **It never hides a run.** The step executing right now is opened to, not
 *   summarised; see the provider's run effect.
 *
 * Pure and DOM-free, like the rest of `flow/`.
 */

import type { WorkflowGraph } from "@codeflow/core";
import type { GraphIndex } from "../graph/index.js";

/**
 * How a set of folded containers reshapes the graph the canvas draws.
 *
 * Built once per (index, collapsed) pair and shared by the layout and the React
 * Flow mapping, so the two can never disagree about which nodes exist.
 */
export interface CollapseView {
  /** The containers that are folded right now (only ones that really exist). */
  collapsed: ReadonlySet<string>;
  /** Every node inside a folded container — not drawn, not laid out. */
  hidden: ReadonlySet<string>;
  /**
   * For a hidden node, the folded box that stands in for it — the *outermost*
   * folded ancestor, since folding a container folds everything under it.
   * Every visible node maps to itself, so this is total over the graph.
   */
  standInOf: ReadonlyMap<string, string>;
  /** True number of steps inside a container, counted recursively. */
  innerCount: ReadonlyMap<string, number>;
}

export const EMPTY_COLLAPSE: CollapseView = {
  collapsed: new Set(),
  hidden: new Set(),
  standInOf: new Map(),
  innerCount: new Map(),
};

/** Every descendant count in the graph, keyed by container id. */
export function innerCounts(index: GraphIndex): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (id: string): number => {
    const known = counts.get(id);
    if (known !== undefined) return known;
    // Set before recursing so a malformed `parentId` cycle cannot spin forever.
    counts.set(id, 0);
    let total = 0;
    for (const child of index.childrenOf.get(id) ?? []) total += 1 + visit(child.id);
    counts.set(id, total);
    return total;
  };
  for (const id of index.containerIds) visit(id);
  return counts;
}

/** The chain of containers a node sits inside, innermost first. */
export function ancestorsOf(nodeId: string, index: GraphIndex): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([nodeId]);
  let current = index.parentOf.get(nodeId) ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = index.parentOf.get(current) ?? null;
  }
  return chain;
}

/**
 * Resolve a set of folded ids against a graph.
 *
 * Ids that no longer exist, or that name something with no children, are
 * dropped — a fold is only meaningful on a box that holds something.
 */
export function buildCollapseView(
  index: GraphIndex,
  collapsed: ReadonlySet<string>,
): CollapseView {
  const counts = innerCounts(index);
  const real = new Set<string>();
  for (const id of collapsed) {
    if (index.containerIds.has(id) && (counts.get(id) ?? 0) > 0) real.add(id);
  }
  if (real.size === 0) return { ...EMPTY_COLLAPSE, innerCount: counts };

  const hidden = new Set<string>();
  const standInOf = new Map<string, string>();

  /** Walk down from a folded box, claiming everything under it. */
  const claim = (id: string, standIn: string): void => {
    for (const child of index.childrenOf.get(id) ?? []) {
      if (hidden.has(child.id)) continue;
      hidden.add(child.id);
      standInOf.set(child.id, standIn);
      claim(child.id, standIn);
    }
  };
  // Outermost first, so a fold inside a fold never becomes the stand-in.
  const byDepth = [...real].sort(
    (a, b) => (index.depthOf.get(a) ?? 0) - (index.depthOf.get(b) ?? 0),
  );
  for (const id of byDepth) {
    if (hidden.has(id)) continue; // already inside another fold
    claim(id, id);
  }

  return { collapsed: real, hidden, standInOf, innerCount: counts };
}

/** The node that actually appears on the canvas in place of `nodeId`. */
export function standIn(view: CollapseView, nodeId: string): string {
  return view.standInOf.get(nodeId) ?? nodeId;
}

/**
 * How big a flow has to be before it arrives folded.
 *
 * Below this nothing folds at all: a thirty-step flow is a diagram, not a
 * directory, and it fits on screen at a readable size as it is.
 */
export const FOLD_ABOVE = 40;
/** A box worth folding. Folding "try { one thing }" trades a step for a step. */
export const FOLD_MIN_INNER = 3;
/**
 * The largest share of a flow a `try` may fold away.
 *
 * A loop and a `try` are not the same kind of box, and the difference decides
 * this. "For each test case in cases — 75 steps inside" is a whole sentence: it
 * names what is repeated and how much of it there is, and a reader who folds
 * there has lost nothing but detail. "Try — 80 steps inside" names nothing. A
 * `try` is a frame *around* the flow, not a step in it, so folding the one that
 * wraps four fifths of `browser-qa-runner` would replace the diagram with a box
 * that says only that errors are handled somewhere.
 *
 * So a `try` earns a fold only while it is small enough to be detail. Above
 * that it stays open and the loops *inside* it fold instead — which is how the
 * 101-step flow comes down to 26 boxes with its spine still on screen.
 */
export const FOLD_TRY_MAX_SHARE = 0.25;

export interface AutoCollapseOptions {
  foldAbove?: number;
  minInner?: number;
  tryMaxShare?: number;
}

/**
 * Which containers a flow should arrive folded.
 *
 * Every container big enough to be worth folding, at every depth — including
 * ones nested inside another fold, which is what makes opening a box a *step*
 * of disclosure rather than a dump: open "For each test case" and its own three
 * loops are folded in turn.
 *
 * Returns an empty set for anything small enough to read as it is.
 */
export function autoCollapse(
  index: GraphIndex,
  options: AutoCollapseOptions = {},
): Set<string> {
  const foldAbove = options.foldAbove ?? FOLD_ABOVE;
  const minInner = options.minInner ?? FOLD_MIN_INNER;
  const tryMaxShare = options.tryMaxShare ?? FOLD_TRY_MAX_SHARE;

  const total = index.nodeById.size;
  const folded = new Set<string>();
  if (total <= foldAbove) return folded;

  const counts = innerCounts(index);
  for (const id of index.containerIds) {
    const inner = counts.get(id) ?? 0;
    if (inner < minInner) continue;
    if (index.nodeById.get(id)?.type === "try" && inner > total * tryMaxShare) continue;
    folded.add(id);
  }
  return folded;
}

/**
 * The folds that have to open for `nodeId` to be on screen.
 *
 * This is the "never traps anything" promise, in one function: selection from
 * the outline, from the code panel's caret, from a diagnostic, from a failed
 * run, and from a patch that added a step all route through it.
 */
export function expandFor(
  nodeId: string,
  index: GraphIndex,
  collapsed: ReadonlySet<string>,
): Set<string> | null {
  const opening = ancestorsOf(nodeId, index).filter((id) => collapsed.has(id));
  if (opening.length === 0) return null;
  const next = new Set(collapsed);
  for (const id of opening) next.delete(id);
  return next;
}

/** `12 steps inside` — the honest label on a folded box. */
export function insideLabel(count: number): string {
  return `${String(count)} step${count === 1 ? "" : "s"} inside`;
}

/**
 * Whether two graphs are the same flow being re-read, or two different flows.
 *
 * It decides one thing — whether the fold state survives a new graph — and it
 * cannot use `graph.id`, which is a hash of the *content* and so changes on
 * every keystroke. Nor can it rely on the host passing `null` in between: the
 * demo does, and React still coalesced the two updates into one render, which
 * is how a switched example kept the previous flow's (empty) folds and arrived
 * at 101 unfolded steps on screen.
 *
 * Node identity is the real signal — but *overlapping at all* is not enough. A
 * node id is a hash of its semantic path and shape, so two unrelated flows
 * share the ids of their synthetic steps: the webhook trigger, an implicit
 * `End Flow`, a `Merge`. Measured across every shipped example, the worst
 * cross-example overlap is 0.43 of the larger graph (two six- and seven-step
 * flows sharing three synthetic nodes), while re-analyzing one flow after an
 * edit keeps nearly all of them. Half is the gap between those two facts.
 */
export const SAME_FLOW_OVERLAP = 0.5;

export function isSameFlow(
  before: WorkflowGraph | null | undefined,
  after: WorkflowGraph,
): boolean {
  if (before === null || before === undefined) return false;
  const largest = Math.max(before.nodes.length, after.nodes.length);
  if (largest === 0) return true;
  const ids = new Set(before.nodes.map((node) => node.id));
  let shared = 0;
  for (const node of after.nodes) if (ids.has(node.id)) shared++;
  return shared / largest >= SAME_FLOW_OVERLAP;
}
