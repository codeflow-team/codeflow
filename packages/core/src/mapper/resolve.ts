/**
 * Identity resolution — 03-data-model.md §5.2.
 *
 * Given the graph a session already holds and a freshly **cold-analyzed** graph
 * of the new source, decide which fresh node *is* which previous node, so ids
 * carry across (§5.0 "session continuity"). The resolve order is the spec's:
 *
 *   0. **patch provenance** — authoritative, no heuristic;
 *   1. **sibling-group alignment** — nodes sharing a parent scope are matched by
 *      an order-preserving alignment; "equal" means fingerprint first (a sure
 *      match), call signature second (a weak match). Comparing fingerprints
 *      first is what makes swapping two calls of the same tool with different
 *      arguments resolve to the right node each, instead of crossing over;
 *   2. **fingerprint** across the whole graph (a node moved in the tree);
 *   3. **source range** proximity + type;
 *   4. **structural context** (best-effort).
 *
 * Every step is a strict bijection: an id is handed to at most one fresh node
 * and a fresh node takes at most one previous id. Steps 3 and 4 only fire when
 * the pairing is *mutually unique*, and none of the heuristic steps ever binds
 * across a content change bigger than the weak-match rule allows.
 *
 * The safety rule of §5.2 outranks the ambition to preserve identity:
 * **reporting removed+added is always preferable to binding an old id onto a
 * different node** — mis-binding is the more serious failure (I5, 11 §2).
 *
 * Acknowledged limitation (spec §5.2): two siblings identical *to the byte* are
 * not distinguishable from a source diff. Deleting one of them may report the
 * "wrong" one as removed. The consequence is cosmetic (view state, selection),
 * the bijection still holds, and the provenance path is immune.
 */

import type {
  ProvenanceMap,
  ProvenanceTarget,
  NodeType,
  WorkflowGraph,
  WorkflowNode,
} from "../model/index.js";
import { coldNodeId, computeEdgeId } from "./ids.js";

/** Which rule bound a pair — useful for debugging and for Phase 4 diagnostics. */
export type IdentityMatchStep =
  | "provenance"
  | "sibling-fingerprint"
  | "sibling-signature"
  | "fingerprint"
  | "range"
  | "structure";

export interface IdentityMatch {
  previousId: string;
  /** Id the node carries in the *fresh* (cold) graph, before remapping. */
  freshId: string;
  step: IdentityMatchStep;
}

export interface IdentityResolution {
  /** fresh (cold) node id → previous node id. */
  mapping: ReadonlyMap<string, string>;
  matches: readonly IdentityMatch[];
  /** Previous node ids with no counterpart — reported as `node.removed`. */
  removed: readonly string[];
  /** Fresh (cold) node ids with no counterpart — reported as `node.added`. */
  added: readonly string[];
  /**
   * Every id the previous graph used. `applyIdentity` never hands one of these
   * to a node that did not inherit it, so a removed id is not silently recycled
   * for an unrelated new node inside the same session.
   */
  reserved: readonly string[];
}

export interface ResolveIdentityOptions {
  /** 03 §5.2 step 0 — supplied by the patch engine (Phase 4). */
  provenance?: ProvenanceMap;
}

/* -------------------------------------------------------------------------- */
/* node comparison                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `tool` and `unknown` are the same family: a call whose tool left the registry
 * degrades to `unknown` without becoming a different step of the flow (03 §11
 * even allows "replace & reconfigure" on it). Everything else is its own family.
 */
function family(type: NodeType): string {
  return type === "tool" || type === "unknown" ? "call" : String(type);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

/**
 * Weak match key. Deliberately coarse on everything a supported edit can
 * change (arguments, condition expression, loop iterable) and precise on what
 * identifies the step itself (which tool, which function, which kind of jump).
 * Changing the tool of a call therefore drops identity on the heuristic path —
 * accepted by §5.3, which promises that case only through provenance.
 */
function signature(node: WorkflowNode): string {
  const data = node.data;
  switch (node.type) {
    case "tool":
    case "unknown":
      return `call:${str(data["toolName"])}`;
    case "function":
      return `function:${str(data["functionName"])}`;
    case "loop":
      return `loop:${str(data["kind"])}`;
    case "jump":
      return `jump:${str(data["kind"])}:${str(data["label"])}`;
    case "merge":
      return `merge:${str(data["of"])}`;
    case "output":
      return `output:${data["explicit"] === true ? "explicit" : "synthetic"}`;
    default:
      return family(node.type);
  }
}

/** Per-statement fingerprints of a merged `code` node (04 §2.11). */
function statementFingerprints(node: WorkflowNode): readonly string[] {
  const value = node.data["statementFingerprints"];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function sharesStatement(a: WorkflowNode, b: WorkflowNode): boolean {
  const left = new Set(statementFingerprints(a));
  if (left.size === 0) return false;
  return statementFingerprints(b).some((entry) => left.has(entry));
}

/** Sure match: same family, same normalized AST fingerprint. */
function strongKey(node: WorkflowNode): string {
  return `${family(node.type)}|${node.source.fingerprint}`;
}

/**
 * Weak match — 04 §2.11 for `code` nodes (≥1 shared statement fingerprint means
 * the same node grew or shrank, so `node.updated` rather than removed+added),
 * signature equality for everything else.
 */
function weakEqual(a: WorkflowNode, b: WorkflowNode): boolean {
  if (family(a.type) !== family(b.type)) return false;
  if (a.type === "code" || b.type === "code") return sharesStatement(a, b);
  return signature(a) === signature(b);
}

function rangesOverlap(a: WorkflowNode, b: WorkflowNode): boolean {
  const as = a.source.start.offset;
  const ae = Math.max(a.source.end.offset, as + 1);
  const bs = b.source.start.offset;
  const be = Math.max(b.source.end.offset, bs + 1);
  return as < be && bs < ae;
}

/* -------------------------------------------------------------------------- */
/* semantic-path scopes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The scope a node is a sibling in: its semantic path minus the last segment.
 * `flow/for[0]/if[0]/call:slack.send[0]` → `flow/for[0]/if[0]`;
 * `flow/if[0]#merge` → `flow` (a merge is a sibling of the statement it follows);
 * `flow#trigger` → `` (the flow itself).
 *
 * Scopes are matched *pairwise by descent*, not by name: once two container
 * nodes are matched, their bodies are aligned against each other even if their
 * sibling indices differ, which is what keeps a whole subtree stable when
 * something is inserted above it.
 */
function scopeOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Sub-scopes a container node owns: body, else-branch, catch and finally. */
const SCOPE_SUFFIXES = ["", "/else", "/catch", "/finally"] as const;

function push(map: Map<string, WorkflowNode[]>, key: string, node: WorkflowNode): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [node]);
  else bucket.push(node);
}

function groupByScope(nodes: readonly WorkflowNode[]): Map<string, WorkflowNode[]> {
  const groups = new Map<string, WorkflowNode[]>();
  for (const node of nodes) push(groups, scopeOf(node.source.semanticPath), node);
  return groups;
}

/* -------------------------------------------------------------------------- */
/* resolver                                                                    */
/* -------------------------------------------------------------------------- */

class Resolver {
  private readonly previousByScope: Map<string, WorkflowNode[]>;
  private readonly freshByScope: Map<string, WorkflowNode[]>;
  private readonly freshByPath = new Map<string, WorkflowNode>();
  private readonly previousById = new Map<string, WorkflowNode>();

  private readonly boundPrevious = new Set<string>();
  private readonly boundFresh = new Set<string>();
  private readonly matches: IdentityMatch[] = [];
  private readonly visitedScopes = new Set<string>();

  constructor(
    private readonly previous: WorkflowGraph,
    private readonly fresh: WorkflowGraph,
  ) {
    this.previousByScope = groupByScope(previous.nodes);
    this.freshByScope = groupByScope(fresh.nodes);
    for (const node of previous.nodes) this.previousById.set(node.id, node);
    for (const node of fresh.nodes) this.freshByPath.set(node.source.semanticPath, node);
  }

  resolve(options: ResolveIdentityOptions): IdentityResolution {
    if (options.provenance !== undefined) this.applyProvenance(options.provenance);

    // 1 — sibling-group alignment, descending from the flow root. `""` holds the
    // trigger and the synthetic output; `flow` holds the top-level statements.
    this.alignScopes("", "");
    this.alignScopes("flow", "flow");

    // 2 — fingerprint match across the whole graph (a node moved in the tree).
    this.matchGlobalFingerprints();

    // 3 — source range proximity + type, only where the pairing is unambiguous.
    this.matchMutuallyUnique(
      (previous, fresh) => weakEqual(previous, fresh) && rangesOverlap(previous, fresh),
      "range",
    );

    // 4 — structural context: same position in the (renamed) tree.
    this.matchMutuallyUnique(
      (previous, fresh) =>
        weakEqual(previous, fresh) &&
        previous.source.semanticPath === fresh.source.semanticPath,
      "structure",
    );

    const mapping = new Map<string, string>();
    for (const match of this.matches) mapping.set(match.freshId, match.previousId);

    const matchedPrevious = new Set(this.matches.map((match) => match.previousId));
    const matchedFresh = new Set(this.matches.map((match) => match.freshId));

    return {
      mapping,
      matches: this.matches,
      removed: this.previous.nodes
        .filter((node) => !matchedPrevious.has(node.id))
        .map((node) => node.id),
      added: this.fresh.nodes.filter((node) => !matchedFresh.has(node.id)).map((node) => node.id),
      reserved: this.previous.nodes.map((node) => node.id),
    };
  }

  private bind(previous: WorkflowNode, fresh: WorkflowNode, step: IdentityMatchStep): void {
    this.boundPrevious.add(previous.id);
    this.boundFresh.add(fresh.id);
    this.matches.push({ previousId: previous.id, freshId: fresh.id, step });
  }

  private freePrevious(nodes: readonly WorkflowNode[]): WorkflowNode[] {
    return nodes.filter((node) => !this.boundPrevious.has(node.id));
  }

  private freeFresh(nodes: readonly WorkflowNode[]): WorkflowNode[] {
    return nodes.filter((node) => !this.boundFresh.has(node.id));
  }

  /* ---------------------------------------------------------------------- */
  /* step 0 — provenance                                                     */
  /* ---------------------------------------------------------------------- */

  private applyProvenance(provenance: ProvenanceMap): void {
    for (const [previousId, target] of Object.entries(provenance)) {
      const previous = this.previousById.get(previousId);
      if (previous === undefined || this.boundPrevious.has(previousId)) continue;

      const resolved = this.resolveProvenanceTarget(target);
      if (resolved === "removed") {
        // Explicitly deleted by the patch: never rebind it heuristically.
        this.boundPrevious.add(previousId);
        continue;
      }
      // A target the patch engine named but the fresh graph does not have is a
      // bug on the caller's side, not a licence to guess: fall through to the
      // heuristic steps rather than binding something arbitrary.
      if (resolved === null) continue;
      this.bind(previous, resolved, "provenance");
    }
  }

  private resolveProvenanceTarget(target: ProvenanceTarget): WorkflowNode | null | "removed" {
    if (typeof target === "string") return this.freshByPathUnbound(target);
    if (target.removed === true) return "removed";
    if (target.semanticPath !== undefined) {
      const byPath = this.freshByPathUnbound(target.semanticPath);
      if (byPath !== null) return byPath;
    }
    if (target.range !== undefined) return this.freshByRange(target.range);
    return null;
  }

  private freshByPathUnbound(path: string): WorkflowNode | null {
    const node = this.freshByPath.get(path);
    if (node === undefined || this.boundFresh.has(node.id)) return null;
    return node;
  }

  /** Smallest unbound fresh node whose range covers the patched range. */
  private freshByRange(range: { start: number; end: number }): WorkflowNode | null {
    let best: WorkflowNode | null = null;
    let bestWidth = Number.POSITIVE_INFINITY;
    for (const node of this.fresh.nodes) {
      if (this.boundFresh.has(node.id)) continue;
      const start = node.source.start.offset;
      const end = node.source.end.offset;
      if (start > range.start || end < range.end) continue;
      const width = end - start;
      if (width < bestWidth) {
        best = node;
        bestWidth = width;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------------- */
  /* step 1 — sibling-group alignment                                        */
  /* ---------------------------------------------------------------------- */

  private alignScopes(previousScope: string, freshScope: string): void {
    const key = `${previousScope} ${freshScope}`;
    if (this.visitedScopes.has(key)) return;
    this.visitedScopes.add(key);

    const previous = this.freePrevious(this.previousByScope.get(previousScope) ?? []);
    const fresh = this.freeFresh(this.freshByScope.get(freshScope) ?? []);
    if (previous.length === 0 || fresh.length === 0) return;

    const pairs = this.alignGroup(previous, fresh);
    for (const [previousNode, freshNode] of pairs) {
      for (const suffix of SCOPE_SUFFIXES) {
        this.alignScopes(
          `${previousNode.source.semanticPath}${suffix}`,
          `${freshNode.source.semanticPath}${suffix}`,
        );
      }
    }
  }

  /**
   * Align one sibling group.
   *
   * Pass A pairs nodes with identical fingerprints, matching the n-th such
   * previous node with the n-th such fresh node. This is deliberately *not*
   * order-constrained: swapping two calls of the same tool with different
   * arguments must resolve each to its own node (§5.2), which an order
   * preserving pass alone cannot do.
   *
   * Pass B runs an order-preserving (LCS) alignment over what is left, using the
   * weak rule. Order preservation is what makes "insert a call before an
   * existing one" read as *the old one slid down* instead of a rebind.
   */
  private alignGroup(
    previous: readonly WorkflowNode[],
    fresh: readonly WorkflowNode[],
  ): Array<[WorkflowNode, WorkflowNode]> {
    const pairs: Array<[WorkflowNode, WorkflowNode]> = [];

    const buckets = new Map<string, WorkflowNode[]>();
    for (const node of fresh) push(buckets, strongKey(node), node);

    const previousRest: WorkflowNode[] = [];
    for (const node of previous) {
      const bucket = buckets.get(strongKey(node));
      const candidate = bucket?.shift();
      if (candidate === undefined) {
        previousRest.push(node);
        continue;
      }
      this.bind(node, candidate, "sibling-fingerprint");
      pairs.push([node, candidate]);
    }

    const freshRest = fresh.filter((node) => !this.boundFresh.has(node.id));
    for (const [previousNode, freshNode] of longestCommonSubsequence(previousRest, freshRest)) {
      this.bind(previousNode, freshNode, "sibling-signature");
      pairs.push([previousNode, freshNode]);
    }
    return pairs;
  }

  /* ---------------------------------------------------------------------- */
  /* steps 2–4 — global fallbacks                                            */
  /* ---------------------------------------------------------------------- */

  private matchGlobalFingerprints(): void {
    const buckets = new Map<string, WorkflowNode[]>();
    for (const node of this.freeFresh(this.fresh.nodes)) push(buckets, strongKey(node), node);
    for (const node of this.freePrevious(this.previous.nodes)) {
      const candidate = buckets.get(strongKey(node))?.shift();
      if (candidate !== undefined) this.bind(node, candidate, "fingerprint");
    }
  }

  /**
   * Bind only pairs that are each other's *sole* candidate. Ambiguity here is
   * exactly the situation §5.2 tells us to resolve as removed+added.
   */
  private matchMutuallyUnique(
    predicate: (previous: WorkflowNode, fresh: WorkflowNode) => boolean,
    step: IdentityMatchStep,
  ): void {
    const previous = this.freePrevious(this.previous.nodes);
    const fresh = this.freeFresh(this.fresh.nodes);
    if (previous.length === 0 || fresh.length === 0) return;

    const candidates = new Map<string, WorkflowNode[]>();
    const reverse = new Map<string, WorkflowNode[]>();
    for (const previousNode of previous) {
      for (const freshNode of fresh) {
        if (!predicate(previousNode, freshNode)) continue;
        push(candidates, previousNode.id, freshNode);
        push(reverse, freshNode.id, previousNode);
      }
    }

    for (const previousNode of previous) {
      const forward = candidates.get(previousNode.id);
      if (forward === undefined || forward.length !== 1) continue;
      const freshNode = forward[0];
      const backward = reverse.get(freshNode.id);
      if (backward === undefined || backward.length !== 1) continue;
      if (this.boundPrevious.has(previousNode.id) || this.boundFresh.has(freshNode.id)) continue;
      this.bind(previousNode, freshNode, step);
    }
  }
}

/** Order-preserving alignment under the weak rule (03 §5.2 step 1). */
function longestCommonSubsequence(
  previous: readonly WorkflowNode[],
  fresh: readonly WorkflowNode[],
): Array<[WorkflowNode, WorkflowNode]> {
  const rows = previous.length;
  const columns = fresh.length;
  if (rows === 0 || columns === 0) return [];

  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      table[i * width + j] = weakEqual(previous[i], fresh[j])
        ? table[(i + 1) * width + (j + 1)] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const pairs: Array<[WorkflowNode, WorkflowNode]> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (weakEqual(previous[i], fresh[j])) {
      pairs.push([previous[i], fresh[j]]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Resolve which fresh node is which previous node. `fresh` must be a **cold**
 * analysis of the new source; this function never mutates either graph.
 */
export function resolveIdentity(
  previous: WorkflowGraph,
  fresh: WorkflowGraph,
  options: ResolveIdentityOptions = {},
): IdentityResolution {
  return new Resolver(previous, fresh).resolve(options);
}

/**
 * Rewrite a cold graph so matched nodes carry their previous ids.
 *
 * Ids stay unique and are never recycled: a fresh node that inherits nothing
 * keeps its cold id unless that id is already spoken for by the previous graph
 * (including ids of removed nodes), in which case it gets a deterministic
 * disambiguated one — the id is an opaque handle, so this is free (§5.0).
 * `data.parentId` and every edge endpoint are remapped with the nodes, and edge
 * ids are recomputed from their endpoints (§5.0: edges need no resolution).
 */
export function applyIdentity(
  fresh: WorkflowGraph,
  resolution: IdentityResolution,
): WorkflowGraph {
  const taken = new Set<string>(resolution.reserved);
  const idMap = new Map<string, string>();

  for (const node of fresh.nodes) {
    const carried = resolution.mapping.get(node.id);
    if (carried === undefined) continue;
    idMap.set(node.id, carried);
    taken.add(carried);
  }
  for (const node of fresh.nodes) {
    if (idMap.has(node.id)) continue;
    let id = node.id;
    let salt = 0;
    while (taken.has(id)) {
      salt += 1;
      id = coldNodeId(`${node.source.semanticPath}#${String(salt)}`);
    }
    taken.add(id);
    idMap.set(node.id, id);
  }

  const nodes = fresh.nodes.map((node) => {
    const id = idMap.get(node.id) ?? node.id;
    const parentId = node.data["parentId"];
    const mappedParent = typeof parentId === "string" ? idMap.get(parentId) : undefined;
    const data =
      mappedParent === undefined || mappedParent === parentId
        ? node.data
        : { ...node.data, parentId: mappedParent };
    if (id === node.id && data === node.data) return node;
    return { ...node, id, data };
  });

  const edges = fresh.edges.map((edge) => {
    const source = idMap.get(edge.source) ?? edge.source;
    const target = idMap.get(edge.target) ?? edge.target;
    if (source === edge.source && target === edge.target) return edge;
    return {
      ...edge,
      id: computeEdgeId(source, target, edge.kind, edge.sourcePort, edge.targetPort),
      source,
      target,
    };
  });

  return { ...fresh, nodes, edges };
}
