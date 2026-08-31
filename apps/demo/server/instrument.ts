/**
 * Probe insertion — the part of the demo runner that decides *where* a run
 * reports from.
 *
 * The contract is one sentence: **the instrumented program must do exactly what
 * the original program did**, and report while it does it. Everything below is
 * in service of that sentence, and the awkward parts of it are awkward because
 * JavaScript is.
 *
 * ## What gets inserted
 *
 * For every node range the graph hands over, a marker goes immediately before
 * the statement and immediately after it:
 *
 * ```ts
 * __cf.s("n7"); const files = await tools.github.getFiles({ pr }); __cf.f("n7");
 * ```
 *
 * Before *and* after, not just before, because the interesting interval is the
 * one in the middle: a tool call that takes four seconds is four seconds of
 * "this step is running", and a UI can only show that if the runtime says when
 * the step started rather than inferring it from when the next one did.
 *
 * The markers are **synchronous** calls. `await __cf(...)` was the obvious
 * spelling and it is the wrong one: an inserted `await` introduces a microtask
 * boundary that was not in the original program, and a probe that can reorder
 * the thing it observes is not a probe. `__cf.s` / `__cf.f` only push an event
 * onto a queue, so they cannot.
 *
 * ## The statement that has no braces
 *
 * ```ts
 * if (pr.draft) continue;
 * ```
 *
 * There is no block to insert into here — the `continue` *is* the body. Putting
 * a marker before it (`if (pr.draft) __cf.s("n3"); continue;`) silently rewrites
 * the program: the `if` now guards the marker, and the `continue` runs
 * unconditionally. This codebase has already been bitten by exactly this shape
 * once, from the other direction (a delete that let an `if` swallow the next
 * statement), so it gets handled explicitly rather than hoped about:
 *
 *  - **wrap** — an unbraced `if`/`else`/`for`/`while`/`do` body becomes
 *    `{ __cf.s(id); <body> __cf.f(id); }`, which is what the author would have
 *    written and is semantically identical;
 *  - **skip** — the shapes where wrapping is *not* identical are left alone and
 *    reported as skipped, so the UI can say "not traced" instead of pretending
 *    the step never ran (07 §5). Those are: a labelled statement (wrapping it
 *    would detach the label from its loop and break `continue label`), a bare
 *    `var`/function declaration as a body (hoisting differs), and anything
 *    whose parent shape is not on the known list.
 *
 * ## Counting the passes through a loop
 *
 * `__cf.pass(loopId)` goes at the top of every loop body, which is what lets a
 * run say *which* item a step's value came from (`RunEvent.iteration`). A
 * braced body takes the marker straight after its `{`; an unbraced one is
 * wrapped by the same rule as above, and refused by the same rule as above.
 *
 * Where a number cannot be established the marker's absence is not left to be
 * inferred — it is **declared**, because a stack that is missing a level reads
 * as a *different* stack, not as an incomplete one:
 *
 *  - a `parallel` node gets `__cf.unknown(id)` beside its opening marker: its
 *    branches interleave, so no counter is trustworthy while it is in flight;
 *  - a loop whose body could be reached but not wrapped gets `__cf.unknown(id)`
 *    too — scoped to that loop;
 *  - a loop that could not be probed at all makes the whole run unnumbered, via
 *    a bare `__cf.unknown()` at the top of the file.
 *
 * `probe.ts` says why omitting beats guessing; core's `IterationPath` says the
 * same thing from the other side.
 *
 * ## Line numbers
 *
 * Every edit is inline — no inserted newlines, imports blanked with spaces
 * rather than deleted — so a stack trace out of the worker still points at the
 * line the user is looking at.
 */

import ts from "typescript";

/** One node's source range, as `@codeflow-team/core`'s `nodeRanges` produces it. */
export interface ProbeRange {
  nodeId: string;
  start: number;
  end: number;
  type?: string;
  label?: string;
}

export type SkipReason =
  | "no-matching-statement"
  | "labelled-statement"
  | "hoisted-declaration-body"
  | "unknown-parent";

export interface SkippedProbe {
  nodeId: string;
  reason: SkipReason;
  /** Human-readable, shown in the UI next to the node. */
  detail: string;
}

export interface InstrumentOptions {
  /** Name of the probe object in scope. Defaults to `__cf`. */
  probe?: string;
  /**
   * Import specifiers to rewrite instead of blanking, e.g.
   * `{ "@flows/lib": "./lib.ts" }`.
   */
  rewriteImports?: Record<string, string>;
}

export interface InstrumentResult {
  /** The instrumented TypeScript. Same line count, same line numbers. */
  code: string;
  /** Node ids that now have a marker pair. */
  probed: string[];
  /** Node ids that deliberately do not, and why. */
  skipped: SkippedProbe[];
  /** Import specifiers that were blanked (kept for the UI's "what got dropped"). */
  droppedImports: string[];
  /** Loops whose passes this run can count — they carry a `pass` marker. */
  counted: string[];
  /**
   * Steps declared unnumberable, and everything inside them with them.
   *
   * A `parallel` (its branches interleave) or a loop whose body could not be
   * wrapped. Empty is the normal case; `blind` is the worse one.
   */
  uncounted: string[];
  /**
   * True when *no* event in this run may carry an iteration.
   *
   * Set when a loop got no marker at all, which leaves nothing at runtime to
   * hang a scoped `unknown` on. Conservative on purpose: a missing level is
   * indistinguishable from a different number, and only one of the two is safe.
   */
  blind: boolean;
}

interface Edit {
  /** Offset the text is inserted at (or the start of the replaced span). */
  at: number;
  /** End of a replaced span; equal to `at` for a pure insertion. */
  to: number;
  text: string;
  /**
   * Ordering key for two edits at the same offset: lower goes first in the
   * output. A container's opening marker must precede a child's.
   */
  rank: number;
}

const BLOCKISH = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Block,
  ts.SyntaxKind.SourceFile,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.DefaultClause,
  ts.SyntaxKind.ModuleBlock,
]);

/** Parents whose single-statement body can be safely wrapped in braces. */
const WRAPPABLE = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
]);

/**
 * A body that must not be wrapped: `var` and function declarations bind in the
 * enclosing scope, and a block would change where the binding lands.
 */
function hoists(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node)) return true;
  if (ts.isVariableStatement(node)) {
    return (node.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
  }
  return false;
}

/**
 * The body of the loop this statement is, or `undefined` if it is not one.
 *
 * Labels are unwrapped first: the analyzer's range for `outer: for (…) {…}` is
 * the *labelled* statement, and the body being asked about is the loop's.
 * Detection is by syntax rather than by `range.type` so that a loop the graph
 * models as something else — a classic `for` inside a code node — is still
 * counted rather than silently mis-stacked.
 */
function loopBodyOf(statement: ts.Statement): ts.Statement | undefined {
  let inner: ts.Statement = statement;
  while (ts.isLabeledStatement(inner)) inner = inner.statement;
  if (
    ts.isForStatement(inner) ||
    ts.isForInStatement(inner) ||
    ts.isForOfStatement(inner) ||
    ts.isWhileStatement(inner) ||
    ts.isDoStatement(inner)
  ) {
    return inner.statement;
  }
  return undefined;
}

function blankOut(source: string, start: number, end: number): string {
  // Keep newlines so every later line keeps its number.
  return source.slice(start, end).replace(/[^\n]/g, " ");
}

/**
 * Instrument `source` so a run reports on the nodes in `ranges`.
 *
 * Pure: no file system, no execution, no globals. `apps/demo/test/instrument.test.ts`
 * runs the before/after programs against each other and asserts they behave
 * identically, which is the only test that actually matters here.
 */
export function instrument(
  source: string,
  ranges: readonly ProbeRange[],
  options: InstrumentOptions = {},
): InstrumentResult {
  const probe = options.probe ?? "__cf";
  const rewrites = options.rewriteImports ?? {};

  const file = ts.createSourceFile("flow.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

  /* --- index every statement by its exact span ---------------------------- */
  const byStart = new Map<number, ts.Statement[]>();
  const byEnd = new Map<number, ts.Statement[]>();
  /** Call expressions, for the nodes that are not statements at all. */
  const callByStart = new Map<number, ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const start = node.getStart(file);
      // Widest call starting here wins: `a(b(c))` and `b(c)` share a start only
      // when the outer one is what the graph named.
      const existing = callByStart.get(start);
      if (existing === undefined || existing.getEnd() < node.getEnd()) callByStart.set(start, node);
    }
    if (ts.isStatement(node)) {
      const start = node.getStart(file);
      const bucketStart = byStart.get(start);
      if (bucketStart === undefined) byStart.set(start, [node]);
      else bucketStart.push(node);
      const bucketEnd = byEnd.get(node.getEnd());
      if (bucketEnd === undefined) byEnd.set(node.getEnd(), [node]);
      else bucketEnd.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const edits: Edit[] = [];
  const probed: string[] = [];
  const skipped: SkippedProbe[] = [];
  const droppedImports: string[] = [];
  const counted: string[] = [];
  const uncounted: string[] = [];
  let blind = false;

  /**
   * Put `__cf.pass(nodeId)` at the top of `body`.
   *
   * The braced case is an insertion after `{`. The unbraced case is the same
   * wrap the probe markers use — and is refused by the caller for the same
   * shape, a body that binds in the enclosing scope and would move if a block
   * appeared around it.
   *
   * `rank` is the loop's own depth, which is lower than any statement inside
   * it — so at a shared offset (`for (…) {stmt}` with no space) the pass marker
   * lands *before* the inner step's opening marker, and its closing brace lands
   * *after* the inner step's closing one.
   */
  const placePass = (nodeId: string, body: ts.Statement, depth: number): void => {
    const marker = `${probe}.pass(${JSON.stringify(nodeId)});`;
    if (ts.isBlock(body)) {
      const at = body.getStart(file) + 1;
      edits.push({ at, to: at, text: marker, rank: depth });
      return;
    }
    const start = body.getStart(file);
    const end = body.getEnd();
    edits.push({ at: start, to: start, text: `{${marker}`, rank: depth });
    edits.push({ at: end, to: end, text: "}", rank: -depth });
  };

  /* --- imports ------------------------------------------------------------ */
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
    const rewrite = rewrites[specifier];
    if (rewrite !== undefined) {
      const literal = statement.moduleSpecifier;
      edits.push({
        at: literal.getStart(file),
        to: literal.getEnd(),
        text: JSON.stringify(rewrite),
        rank: 0,
      });
      continue;
    }
    // Everything else is a module this runner cannot resolve — a generated
    // `tools.d.ts` that only exists at author time, most of all. Blanked, not
    // deleted, so nothing below it moves.
    droppedImports.push(specifier);
    const start = statement.getStart(file);
    edits.push({ at: start, to: statement.getEnd(), text: blankOut(source, start, statement.getEnd()), rank: 0 });
  }

  /* --- probes ------------------------------------------------------------- */
  // Outermost first, so a container's opening marker outranks its children's.
  const ordered = [...ranges].sort((a, b) => (a.start === b.start ? b.end - a.end : a.start - b.start));

  for (const [depth, range] of ordered.entries()) {
    const first = (byStart.get(range.start) ?? [])
      // Widest statement starting here — a code node spans a run of statements,
      // and its range starts at the first one.
      .slice()
      .sort((a, b) => b.getEnd() - a.getEnd())
      .find((candidate) => candidate.getEnd() <= range.end);
    const last = (byEnd.get(range.end) ?? [])
      .slice()
      .sort((a, b) => a.getStart(file) - b.getStart(file))
      .find((candidate) => candidate.getStart(file) >= range.start);

    if (first === undefined || last === undefined || first.parent !== last.parent) {
      /*
       * Not a statement — almost always an element of `Promise.all([…])`, which
       * the analyzer gives a node of its own (04 §2.6) even though it is an
       * expression sitting in an array literal. There is nowhere to put a
       * statement marker, so the call is wrapped in a thunk instead:
       *
       *     __cf.p("n9", () => tools.fs.readTextFile({ path }))
       *
       * `p` starts the step, invokes the thunk, *attaches* a listener to the
       * promise it returned, and returns that same promise untouched. It never
       * chains — `p.then(…)` would hand back a different promise and add a
       * microtask hop — so the value and the timing the caller sees are exactly
       * what they were.
       */
      const call = callByStart.get(range.start);
      if (call !== undefined && call.getEnd() === range.end && !ts.isAwaitExpression(call.parent)) {
        edits.push({
          at: range.start,
          to: range.start,
          text: `${probe}.p(${JSON.stringify(range.nodeId)}, () => `,
          rank: depth,
        });
        edits.push({ at: range.end, to: range.end, text: ")", rank: -depth });
        probed.push(range.nodeId);
        continue;
      }

      skipped.push({
        nodeId: range.nodeId,
        reason: "no-matching-statement",
        detail: "No statement matches this node's source range exactly.",
      });
      if (range.type === "loop") blind = true;
      continue;
    }

    const parent = first.parent;
    const start = first.getStart(file);
    const end = last.getEnd();
    const id = JSON.stringify(range.nodeId);

    /** Non-undefined exactly when this range is a loop whose passes to count. */
    const loopBody = first === last ? loopBodyOf(first) : undefined;
    /** A loop body that cannot take the marker — see `placePass`. */
    const stubbornLoop = loopBody !== undefined && !ts.isBlock(loopBody) && hoists(loopBody);

    /*
     * A step that makes the counters untrustworthy says so as it opens, and
     * keeps saying it until its closing marker: a `parallel`, whose branches
     * interleave, and a loop whose body the marker cannot reach. The
     * declaration rides inside `open` so it can never be separated from the
     * `s` it qualifies.
     */
    const opaque = range.type === "parallel" || stubbornLoop;
    const open = opaque ? `${probe}.s(${id});${probe}.unknown(${id});` : `${probe}.s(${id});`;
    const close = `${probe}.f(${id});`;
    if (opaque) uncounted.push(range.nodeId);

    /**
     * Called once the range is known to be probed: it has a frame at runtime,
     * so a `pass` marker has something to count on.
     */
    const countLoop = (depth: number): void => {
      if (loopBody === undefined || stubbornLoop) return;
      placePass(range.nodeId, loopBody, depth);
      counted.push(range.nodeId);
    };

    /*
     * A `return` / `break` / `continue` / `throw` never comes back, so a marker
     * placed after it is dead code and the step would hang open forever. Both
     * markers go in front instead. The step is then reported as instantaneous,
     * which for a control transfer it essentially is — the one case that loses
     * information is `return await slow()`, and reporting that as fast is a far
     * smaller lie than reporting it as never finished.
     */
    const transfers =
      first === last &&
      (ts.isReturnStatement(first) ||
        ts.isBreakStatement(first) ||
        ts.isContinueStatement(first) ||
        ts.isThrowStatement(first));

    /*
     * Entering a `catch` is the runtime telling us an exception went past —
     * the only moment a probe can learn that the steps inside the `try` body
     * did not merely stop, they failed. Without it a caught error would be
     * indistinguishable from an early `break`.
     */
    if (ts.isTryStatement(first) && first === last && first.catchClause !== undefined) {
      const block = first.catchClause.block;
      edits.push({
        at: block.getStart(file) + 1,
        to: block.getStart(file) + 1,
        text: `${probe}.x(${JSON.stringify(range.nodeId)});`,
        rank: 1000,
      });
    }

    if (BLOCKISH.has(parent.kind)) {
      if (transfers) {
        edits.push({ at: start, to: start, text: open + close, rank: depth });
        probed.push(range.nodeId);
        continue;
      }
      edits.push({ at: start, to: start, text: open, rank: depth });
      edits.push({ at: end, to: end, text: close, rank: -depth });
      probed.push(range.nodeId);
      countLoop(depth);
      continue;
    }

    if (ts.isLabeledStatement(parent)) {
      skipped.push({
        nodeId: range.nodeId,
        reason: "labelled-statement",
        detail: "Wrapping a labelled statement would break `continue`/`break` to its label.",
      });
      if (loopBody !== undefined) blind = true;
      continue;
    }

    if (WRAPPABLE.has(parent.kind) && first === last) {
      if (hoists(first)) {
        skipped.push({
          nodeId: range.nodeId,
          reason: "hoisted-declaration-body",
          detail: "A `var`/function declaration used as a body binds in the enclosing scope; a block would move it.",
        });
        if (loopBody !== undefined) blind = true;
        continue;
      }
      edits.push({
        at: start,
        to: start,
        text: transfers ? `{${open}${close}` : `{${open}`,
        rank: depth,
      });
      edits.push({ at: end, to: end, text: transfers ? "}" : `${close}}`, rank: -depth });
      probed.push(range.nodeId);
      countLoop(depth);
      continue;
    }

    skipped.push({
      nodeId: range.nodeId,
      reason: "unknown-parent",
      detail: `Statement sits directly inside a ${ts.SyntaxKind[parent.kind]}, which this runner will not rewrite.`,
    });
    if (loopBody !== undefined) blind = true;
  }

  /*
   * One loop went uncounted with nowhere to say so at runtime, so nothing in
   * this run may be numbered. A stack missing a level is not a shorter stack —
   * it is a different one, and a UI reading `[0]` as "the first item" would be
   * reading something the run never said.
   */
  if (blind) edits.push({ at: 0, to: 0, text: `${probe}.unknown();`, rank: -1e9 });

  /* --- apply -------------------------------------------------------------- */
  // Right to left, so no offset has to be adjusted. At a shared offset the
  // higher rank is applied first, which puts it later in the text.
  edits.sort((a, b) => (a.at === b.at ? b.rank - a.rank : b.at - a.at));
  let out = source;
  for (const edit of edits) out = out.slice(0, edit.at) + edit.text + out.slice(edit.to);

  return { code: out, probed, skipped, droppedImports, counted, uncounted, blind };
}
