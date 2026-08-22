/**
 * Patch provenance — 03-data-model.md §5.2 step 0.
 *
 * A patch produced by the patch engine (06-patch-engine.md) knows exactly what
 * it inserted, edited or deleted, so it can hand identity resolution an
 * authoritative `oldNodeId → new location` map. That path uses **no heuristic**:
 * every edit made through the inspector/palette keeps identity absolutely, even
 * when it inserts a call byte-identical to one already there, and even when it
 * changes a node's tool (the id is an opaque handle — §5.0).
 *
 * Editing the source directly (Monaco included) has no provenance and goes down
 * the heuristic path 1–4 like any other outside change.
 */

/** Where a previous node ended up in the freshly analyzed graph. */
export type ProvenanceTarget =
  /** Semantic path of the node in the fresh graph. */
  | string
  | {
      /** Semantic path of the node in the fresh graph — checked first. */
      semanticPath?: string;
      /** Offsets in the *new* source; the smallest node covering it wins. */
      range?: { start: number; end: number };
      /** The patch deleted this node — never rebind it heuristically. */
      removed?: boolean;
    };

/** `oldNodeId → new location`, supplied by the patch engine. */
export type ProvenanceMap = Readonly<Record<string, ProvenanceTarget>>;
