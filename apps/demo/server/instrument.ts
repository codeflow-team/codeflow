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
 * ## The value a step produced
 *
 * A marker *after* a statement cannot see what the statement produced — that is
 * the structural reason a run used to have a value for tool calls and for
 * nothing else. But at the moment the closing marker runs, whatever the
 * statement declared **is in scope**, so the marker can simply be handed it:
 *
 * ```ts
 * __cf.s("n7"); const rows = limitRecords(rows, 10, "first"); __cf.f("n7", rows);
 * ```
 *
 * This is deliberately the cheapest thing that could work. It adds an argument
 * to a call that was already there: no wrapper around the expression, no thunk,
 * no `await`, no extra microtask, no change to where the `await` in the
 * statement sits. Reading an already-initialised binding has no observable
 * effect of its own, so the program is the program.
 *
 * `const x = await f()` is the case worth being explicit about, because it is
 * the one that *looks* like it might reorder: it does not. The closing marker is
 * emitted after the whole statement, and a statement containing `await` does not
 * complete until the await has resumed — so by the time `__cf.f("n7", x)` runs,
 * `x` holds the settled value and the suspension it went through is already
 * over. The marker observes the result; it cannot advance it.
 *
 * The same trick names the item of a loop, on the marker that is already at the
 * top of every pass:
 *
 * ```ts
 * for (const ticket of queue) { __cf.pass("n12", ticket); … }
 * ```
 *
 * Binding names come from the **AST**, not from `WorkflowNode.outputs`. The
 * marker inserts an *identifier reference*, so what it needs is the name as the
 * source spells it, and only the source is authoritative about that: a graph
 * port may carry a different string on purpose — for a loop over a destructuring
 * pattern the analyzer sets the port id to the *property* name and the label to
 * the binding (`analyzer/emit.ts`, loop outputs) — and inserting the wrong one
 * of the two would be a `ReferenceError` inside the user's flow. Reading the
 * statement the marker is being attached to cannot disagree with itself.
 *
 * ### Where a value is *not* recorded, and why
 *
 * Every range ends up on exactly one of `valued` / `unvalued`, for the same
 * reason every range ends up on `probed` or `skipped`: silence is what 07 §5
 * forbids, and "this step declares nothing to show" has to be tellable from
 * "this step produced nothing".
 *
 *  - a statement that declares nothing — `await tools.slack.send(…)`, an
 *    assignment, an `if`, a `return`. A tool call is already covered from the
 *    other side, by the tools proxy in `worker.ts`;
 *  - a **decision** — an `if`, a `switch`. Its value is its test expression, and
 *    the only way to read that after the fact is to write it a second time; a
 *    condition is allowed to have side effects, so evaluating it twice to put a
 *    `true` on screen would be the instrumenter breaking its own contract for
 *    decoration;
 *  - a `var` (or `using`) declaration. Reading it after the fact would be safe
 *    enough, but a `var` binding is *not* the step's: it exists before the
 *    statement runs and outlives the block, so a value shown against that step
 *    would be claiming ownership the language does not give it. It is also the
 *    one declaration form every other rule in this file refuses to touch;
 *  - anything not probed at all — a labelled statement, a hoisted body, an
 *    unknown parent. No marker, no value, and it says so with `not-probed`;
 *  - a `return`/`break`/`continue`/`throw`, whose markers both go *in front* of
 *    the statement (see below): there is nothing after it to read, and it
 *    declares nothing either way.
 *
 * A binding whose value is a **promise the statement did not await** is a
 * runtime question, not a syntactic one, so it is handled at the other end:
 * `probe.ts` detects the thenable and records that it did not observe a value,
 * rather than storing `Promise { <pending> }` or awaiting it and changing the
 * program.
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

/** Why a probed node will never report the value it produced. */
export type NoValueReason =
  /** The statement declares no binding — an `await tools.x.y()`, an assignment. */
  | "no-binding"
  /**
   * A decision step, whose value is its test expression.
   *
   * Reading it would mean writing that expression a second time, and a
   * condition is allowed to have side effects (`if (queue.shift())`). Running
   * the user's code twice to put a `true` on screen is exactly the trade this
   * instrumenter refuses everywhere else.
   */
  | "would-re-evaluate"
  /** A `var`/`using` declaration: the binding is not the step's to show. */
  | "var-declaration"
  /** Not probed at all — see the matching entry in `skipped`. */
  | "not-probed";

export interface UnvaluedProbe {
  nodeId: string;
  reason: NoValueReason;
  /** Human-readable, so a UI can say why instead of showing nothing. */
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
  /**
   * Node ids whose markers carry the value the step produced.
   *
   * A statement's declared binding (`__cf.f(id, rows)`), a loop's item
   * (`__cf.pass(id, ticket)`), or a `Promise.all` element, whose settled value
   * `__cf.p` already observes.
   */
  valued: string[];
  /**
   * Node ids that will report no value of their own, and why.
   *
   * Together with `valued` this covers every range, so a UI can say "this step
   * declares nothing to show" instead of leaving "no value" to mean both that
   * and "it produced nothing".
   */
  unvalued: UnvaluedProbe[];
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

/* -------------------------------------------------------------------------- */
/* what a statement declares                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every name a binding pattern introduces, in source order.
 *
 * `const rows` → `["rows"]`; `const { a, b: { c }, ...rest }` → `["a","c","rest"]`;
 * `const [x, , y]` → `["x","y"]`. Holes contribute nothing because they bind
 * nothing, and a default (`{ a = 1 }`) contributes its name and not its default.
 */
function bindingNamesOf(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    bindingNamesOf(element.name, out);
  }
}

/**
 * The names a `const`/`let` list binds, or `null` for anything else.
 *
 * `var` and `using` are `null` on purpose — see the header. The flag test is
 * the same one `hoists()` uses, so the two rules cannot drift apart: a
 * declaration form that is not lexical is not one this file reasons about.
 */
function lexicalNamesOf(list: ts.VariableDeclarationList): string[] | null {
  if ((list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) return null;
  // `using x = …` is `Using`, `await using x = …` is `Const | Using`; both
  // dispose at the end of the block — a different lifetime from the statement,
  // so they are left alone with `var`. (`AwaitUsing` is not a bit of its own:
  // it is `Const | Using`, so testing against it would also reject `const`.)
  if ((list.flags & ts.NodeFlags.Using) !== 0) return null;
  const names: string[] = [];
  for (const declaration of list.declarations) bindingNamesOf(declaration.name, names);
  return names;
}

/**
 * The expression a marker is handed for a set of names.
 *
 * One name is passed as itself, which is what the step produced. Several are
 * reassembled into an object literal — `{ a, b }` — which is the honest
 * reconstruction of what a destructuring statement bound: it names exactly the
 * bindings that came out of it, and claims nothing about whatever else was on
 * the right-hand side.
 */
function referenceFor(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return `{ ${names.join(", ")} }`;
}

/**
 * What the item of one pass through this loop is called, if anything.
 *
 * `for…of` / `for…in` name the item directly; a classic `for` names its
 * counter, which is the same fact about a pass. `while`/`do…while` bind
 * nothing, and a loop that assigns into an existing member expression
 * (`for (obj.k of …)`) has no reference this can safely insert either.
 */
function loopItemReference(statement: ts.Statement): string | null {
  let inner: ts.Statement = statement;
  while (ts.isLabeledStatement(inner)) inner = inner.statement;

  if (ts.isForOfStatement(inner) || ts.isForInStatement(inner)) {
    const initializer = inner.initializer;
    if (ts.isVariableDeclarationList(initializer)) {
      const names = lexicalNamesOf(initializer);
      return names === null ? null : referenceFor(names);
    }
    // `for (item of items)` — an existing binding, assigned before the body
    // runs, so reading it at the top of the pass is reading the item.
    return ts.isIdentifier(initializer) ? initializer.text : null;
  }

  if (ts.isForStatement(inner)) {
    const initializer = inner.initializer;
    if (initializer === undefined || !ts.isVariableDeclarationList(initializer)) return null;
    const names = lexicalNamesOf(initializer);
    return names === null ? null : referenceFor(names);
  }

  return null;
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
  const valued: string[] = [];
  const unvalued: UnvaluedProbe[] = [];
  let blind = false;

  const noValue = (nodeId: string, reason: NoValueReason, detail: string): void => {
    unvalued.push({ nodeId, reason, detail });
  };

  /**
   * Put `__cf.pass(nodeId)` — or `__cf.pass(nodeId, item)` — at the top of
   * `body`.
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
  const placePass = (nodeId: string, body: ts.Statement, depth: number, item: string | null): void => {
    const marker =
      item === null
        ? `${probe}.pass(${JSON.stringify(nodeId)});`
        : `${probe}.pass(${JSON.stringify(nodeId)}, ${item});`;
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
        // `p` observes the promise it was handed settling, so this node reports
        // its value without a binding to read.
        valued.push(range.nodeId);
        continue;
      }

      skipped.push({
        nodeId: range.nodeId,
        reason: "no-matching-statement",
        detail: "No statement matches this node's source range exactly.",
      });
      noValue(range.nodeId, "not-probed", "This step has no marker at all, so nothing can read its value.");
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
    if (opaque) uncounted.push(range.nodeId);

    /** The item of one pass, when this range is a loop that names one. */
    const loopItem = loopBody === undefined ? null : loopItemReference(first);

    /**
     * Called once the range is known to be probed: it has a frame at runtime,
     * so a `pass` marker has something to count on. Answers whether it placed
     * one, which is also whether the loop's item can be reported.
     */
    const countLoop = (depth: number): boolean => {
      if (loopBody === undefined || stubbornLoop) return false;
      placePass(range.nodeId, loopBody, depth, loopItem);
      counted.push(range.nodeId);
      return true;
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
     * What this range declares, and therefore what its closing marker can be
     * handed. A code node spans a run of sibling statements, so every lexical
     * declaration in the run counts: what such a region produced is everything
     * it left behind, not only its last line.
     *
     * `transfers` is excluded because both of its markers run *before* the
     * statement — there is no "after" to read anything in.
     */
    const declared: string[] = [];
    /** A `var`/`using`/function declaration was seen and deliberately passed over. */
    let sawUnownedDeclaration = false;
    if (!transfers) {
      const siblings = (parent as { statements?: ts.NodeArray<ts.Statement> }).statements;
      const from = siblings === undefined ? -1 : siblings.indexOf(first);
      const to = siblings === undefined ? -1 : siblings.indexOf(last);
      const region: readonly ts.Statement[] =
        siblings === undefined || from === -1 || to === -1 ? [first] : siblings.slice(from, to + 1);
      for (const statement of region) {
        if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
          sawUnownedDeclaration = true;
          continue;
        }
        if (!ts.isVariableStatement(statement)) continue;
        const names = lexicalNamesOf(statement.declarationList);
        if (names === null) {
          sawUnownedDeclaration = true;
          continue;
        }
        declared.push(...names);
      }
    }
    const bindingRef = referenceFor(declared);
    const close = bindingRef === null ? `${probe}.f(${id});` : `${probe}.f(${id}, ${bindingRef});`;

    /**
     * Put this range on `valued` or on `unvalued` — never on neither.
     *
     * `numbered` is whether a pass marker was placed, because a loop reports its
     * item through that marker and through nothing else.
     */
    const accountValue = (numbered: boolean): void => {
      if (bindingRef !== null || (numbered && loopItem !== null)) {
        valued.push(range.nodeId);
        return;
      }
      if (transfers) {
        noValue(
          range.nodeId,
          "no-binding",
          "A `return`/`break`/`continue`/`throw` declares nothing, and both of its markers run in front of it.",
        );
        return;
      }
      if (loopBody !== undefined && loopItem === null) {
        noValue(
          range.nodeId,
          "no-binding",
          "This loop names no item — a `while`, or a `for` whose head declares nothing this can read.",
        );
        return;
      }
      if (
        first === last &&
        // A `while`/`do` is a decision too, but it is a *loop* node here and
        // the branch above has already answered for it.
        (ts.isIfStatement(first) || ts.isSwitchStatement(first))
      ) {
        noValue(
          range.nodeId,
          "would-re-evaluate",
          "A decision's value is its test, and reading it would mean evaluating that expression a second time — which a condition with a side effect would notice.",
        );
        return;
      }
      if (sawUnownedDeclaration) {
        noValue(
          range.nodeId,
          "var-declaration",
          "A `var`/`using`/function binding outlives the step, so a value shown against this step would claim ownership the language does not give it.",
        );
        return;
      }
      noValue(
        range.nodeId,
        "no-binding",
        "This step declares no binding, so its closing marker has nothing in scope to read. A tool call is reported from the other side, by the call itself.",
      );
    };

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
        accountValue(false);
        continue;
      }
      edits.push({ at: start, to: start, text: open, rank: depth });
      edits.push({ at: end, to: end, text: close, rank: -depth });
      probed.push(range.nodeId);
      accountValue(countLoop(depth));
      continue;
    }

    if (ts.isLabeledStatement(parent)) {
      skipped.push({
        nodeId: range.nodeId,
        reason: "labelled-statement",
        detail: "Wrapping a labelled statement would break `continue`/`break` to its label.",
      });
      noValue(range.nodeId, "not-probed", "This step has no marker at all, so nothing can read its value.");
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
        noValue(range.nodeId, "not-probed", "This step has no marker at all, so nothing can read its value.");
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
      accountValue(countLoop(depth));
      continue;
    }

    skipped.push({
      nodeId: range.nodeId,
      reason: "unknown-parent",
      detail: `Statement sits directly inside a ${ts.SyntaxKind[parent.kind]}, which this runner will not rewrite.`,
    });
    noValue(range.nodeId, "not-probed", "This step has no marker at all, so nothing can read its value.");
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

  return { code: out, probed, skipped, droppedImports, counted, uncounted, blind, valued, unvalued };
}
