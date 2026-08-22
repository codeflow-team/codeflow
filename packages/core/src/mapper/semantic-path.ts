/**
 * Semantic path — 03-data-model.md §5.1, 04-analyzer.md.
 *
 * A structural path from the flow root down to a construct, carrying a sibling
 * index so two identical constructs in the same scope stay distinguishable:
 *
 *     flow/for[0]/if[0]/call:slack.send[0]
 *     flow/for[0]/if[0]/call:slack.send[1]
 *
 * Branch scopes add a segment of their own (`.../if[0]/else/if[0]`), synthetic
 * nodes add a role qualifier (`flow/if[0]#merge`, `flow#trigger`), and merged
 * `code` nodes are named by the statement span they cover (`flow/stmt[1..2]`).
 *
 * The index is a *naming* device applied after the fact, never the key used to
 * match nodes across analyses (that is alignment — Phase 3).
 */

export const FLOW_ROOT = "flow";

/**
 * One naming scope: a block whose statements are siblings. Sibling counters are
 * per prefix, so `call:slack.send` and `if` count independently.
 */
export class PathScope {
  private readonly counters = new Map<string, number>();

  constructor(readonly base: string) {}

  /** `<base>/<prefix>[<n>]` with `n` counting prior siblings of the same prefix. */
  next(prefix: string): string {
    const index = this.counters.get(prefix) ?? 0;
    this.counters.set(prefix, index + 1);
    return `${this.base}/${prefix}[${index}]`;
  }

  /** `<base>/stmt[i..j]` — a merged run of unsupported statements (04 §2.11). */
  statements(from: number, to: number): string {
    return `${this.base}/${from === to ? `stmt[${from}]` : `stmt[${from}..${to}]`}`;
  }

  /** A nested naming scope, e.g. the `else` branch or a `catch` clause. */
  child(segment: string): PathScope {
    return new PathScope(`${this.base}/${segment}`);
  }

  /** A nested naming scope whose base is a construct path (loop body, then-branch). */
  static under(path: string): PathScope {
    return new PathScope(path);
  }
}

/** Role qualifier for a synthetic node — `flow/if[0]#merge`, `flow#trigger` (03 §4). */
export function withRole(path: string, role: string): string {
  return `${path}#${role}`;
}

/** Path segment prefix for a call node: `call:slack.send`, `call:isAuthChange`. */
export function callSegment(name: string): string {
  return `call:${name}`;
}
