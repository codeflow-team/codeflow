# Hardening suite — catalogue

This directory is the answer to one question: **which ways of breaking CodeFlow
have already been paid for?**

Every case below is either a bug that actually happened (in a build log, an AI
eval run, a browser session, or this pass) or a hazard that was hunted down on
purpose. The rule from [11 §4](../../../../docs/11-testing.md) applies: a real
bug gets a test *first*, and the corpus only ever grows. If you are about to
write a test for something already listed here, read the entry instead — it
says what was wrong and which invariant it belongs to.

The golden-fixture corpus (`../fixtures/`) covers *constructs*. This suite
covers *hazards*: the same construct written in a file that came off a Windows
editor, with a key spelled `"channel"` instead of `channel`, with the caret in
the indentation, or with a sibling that is identical to the byte.

## Layout

| File | What it defends |
|---|---|
| `regression.test.ts` | Bugs already met, one section per incident |
| `encoding.test.ts` | Line endings, BOM, indentation, unicode, escapes |
| `syntax.test.ts` | Call and key spellings; literal layout; templates |
| `control-flow.test.ts` | Nesting, jumps, `finally`, merges |
| `data-flow.test.ts` | Shadowing, multiple writers, destructuring, TDZ |
| `patch-adversarial.test.ts` | Ambiguity, commas, repeated patching, refusals |
| `degradation.test.ts` | The edge of what is recognised, and what it says |
| `helpers.ts` | Shared scaffolding (not collected — no `.test.ts`) |

UI-side hardening lives in `packages/react/test/hardening/`:
`node-at-offset.test.ts`, `inspector-a11y.test.ts`, `changed-nodes.test.ts`.

Totals: **179 passing + 2 `todo`** here, **24 passing + 1 `todo`** in
`@codeflow-team/react`.

---

## 1. Bugs found and fixed in this pass

Each one is a real defect in `src/`, with the fix and the test that locks it.

### 1.1 A leading BOM shifted every source offset by one

*`packages/core/src/parser/ts-morph-parser.ts`* · I1, I3 · **fixed**

ts-morph strips a leading `U+FEFF` from the text it parses (it remembers it for
`save()`). The graph, meanwhile, kept the caller's text — BOM included. So every
AST offset sat one character ahead of the document the offsets indexed into:
node ranges came back one character short (`" await tools…"`), the UI would have
highlighted the wrong span, and **every patch was rejected as unparseable**
(`patch-invalid`), because the edit landed one byte off.

Fix: the parser substitutes a single space for a leading BOM before handing the
text to ts-morph. A BOM is whitespace to the scanner, so not one token changes,
the two coordinate spaces stay identical, and the document the graph carries
(and that patches are applied to) keeps its BOM byte for byte.

Locked by `encoding.test.ts` → "a leading BOM does not shift the coordinate
space" (5 tests, including BOM + CRLF together).

### 1.2 A quoted property key was never matched, and a duplicate was appended

*`packages/core/src/patcher/locate.ts`, `src/analyzer/emit.ts`,
`src/util/property-names.ts` (new)* · I6 · **fixed**

`ts-morph`'s `getName()` returns the *text* of a key, so `{ "channel": "#a" }`
came back as the field `"channel"` — quotes included. Two consequences:

- the inspector showed a field named `"channel"` that matched no field of the
  tool's input schema;
- `patchNode(id, { channel: … })` did not find the property and **appended a
  second `channel`** at the end of the literal. The value on screen stayed
  exactly where it was while a duplicate silently overrode it — the precise
  failure I6 exists to prevent.

Fix: a new `staticPropertyName()` resolves the key JavaScript actually binds —
identifier, `"quoted"`, `'quoted'`, numeric `1`, and the long-way-round
`["channel"]` — and both the analyzer and the patcher use it.

Locked by `syntax.test.ts` → "a property key is matched by what it binds, not
how it is written" (8 tests).

### 1.3 A computed key let a patch override an invisible value

*`packages/core/src/patcher/plan.ts`, `src/patcher/locate.ts`,
`src/analyzer/emit.ts`* · I6 · **fixed**

`{ ["chan" + "nel"]: "#security" }` may well *be* `channel`. The engine appended
a new `channel` after it, which at run time wins — silently replacing a value
the user was looking at. This is the same hazard 06 §1 already forbids next to a
spread, and it now gets the same answer.

Fix: a key that cannot be resolved without running code is recorded as
`argumentsHaveOpaqueKey` and kept out of `data.arguments`; adding a property to
such a literal is refused with `patch-not-editable`. Editing the *other*,
statically named properties still works — only insertion is blocked.

Locked by `syntax.test.ts` → "refuses to add a field next to a computed key it
cannot resolve" and "still edits the sibling fields it CAN see next to a
computed key".

### 1.4 Deleting a brace-less body handed the body to the next statement

*`packages/core/src/patcher/plan.ts`, `src/patcher/statement-edits.ts`* ·
I6, O2 · **fixed** — the most serious find of this pass

Deleting a `jump`/`output`/`tool` node whose statement *is* the brace-less body
of an `if`/`else`/`for`/`while` removed the statement's text and left the head
dangling, so the **next** statement became the body:

```ts
// before                                  // after deleting the `continue`
if (pr.draft) continue;                    if (pr.draft)
await tools.slack.send({ … });             await tools.slack.send({ … });
```

The result parses, type-checks, and sends the message only for draft PRs. A
patch that changes meaning while claiming to delete one step is the worst
outcome the engine has, and nothing caught it: the candidate parsed, the flow
contract held, and a delete has no "edited node must survive" check.

Fix: such a statement is replaced with `{ }` rather than removed — exactly what
deleting the only statement of a *braced* body already produced. The brace-less
`else` case, which used to fail with an unhelpful `patch-invalid`, now works too.

Locked by `patch-adversarial.test.ts` → "deleting the brace-less body of a
construct leaves an empty block" (9 tests, covering `if`/`else`/`for`/`while`,
jumps, returns and tool calls).

### 1.5 Nested destructuring bound a name nobody could resolve

*`packages/core/src/analyzer/dataflow.ts`* · O1, 03 §6 · **fixed**

`bindingNames()` did not recurse, so `const { a: { b } } = …` produced a binding
literally called `{ b }`. Nothing downstream matched it, so the data edge into
whoever read `b` was **missing** — and with it the delete dependency check
(06 §2), which is built on data edges. Deleting the producer looked safe.

Fix: nested object and array patterns are flattened to the identifiers they
bind. A nested name has no single owning property, so it carries no `property`.

Locked by `data-flow.test.ts` → "binds every name of a nested pattern, not the
pattern's text", plus nested-array and rest-element cases and a delete-refusal
test.

### 1.6 A patched string could carry a raw TAB

*`packages/core/src/patcher/values.ts`* · I3 · **fixed** (minor)

`renderStringLiteral` escaped only what the grammar forces. A tab written into
a value therefore landed in the source as a literal TAB — invisible in an
editor, and exactly the character an editor's trim-on-save rewrites, which would
change the string's *value* behind the user. `\t`, `\b`, `\f`, `\v` and every
other C0 control are now escaped.

Locked by `encoding.test.ts` → "re-escapes a value that contains newlines, tabs,
backslashes and quotes" and "escapes the line/paragraph separators and other
control characters".

### 1.7 The caret at column 1 selected the container, not the step

*`packages/react/src/graph/index.ts`* · 07 §2 · **fixed** (backlog item from
`e2e/report.md`)

Pressing Home on an indented statement moved the selection to the enclosing
`for`. Literally correct — column 1 of an indented line is outside every
statement on it — and exactly the wrong rule: on an unindented statement the
same logic selected *nothing*.

Fix: a caret in a line's leading whitespace resolves forward to the first thing
on that line, and never to something wider than the literal answer.

Locked by `packages/react/test/hardening/node-at-offset.test.ts` (10 tests,
including an exhaustive "snapping never widens the answer" sweep over every
offset in a file).

### 1.8 Inspector form controls had no `id`, `name`, or `<label for>`

*`packages/react/src/inspector/NodeInspector.tsx`* · a11y · **fixed** (backlog
item from `e2e/report.md`)

DevTools reported "a form field element should have an id or name attribute" on
every input. The controls were wrapped in a `<label>`, which associates them
implicitly but leaves the control anonymous: no explicit relationship for
assistive tech, no key for autofill, no stable handle for a test.

Fix: every field input, the preview checkbox and the tool `<select>` now carry
an `id` and a `name`, and their visible label points at them with `htmlFor`. Ids
are scoped by node id so two inspectors on one page cannot collide.

Locked by `packages/react/test/hardening/inspector-a11y.test.ts` (8 tests).

---

## 2. Regression locks for bugs met earlier in the project

These pass today. They are here so they keep passing.

| # | Case | Source of the bug | Test |
|---|---|---|---|
| 2.1 | A byte-identical call inserted before an existing one must not steal its id | `NOTES.md` "Phase 3" | `regression.test.ts` §1 |
| 2.2 | Two calls of the same tool swapping places each keep their own id (order-free fingerprint match, not LCS by position) | `NOTES.md` "Phase 3" | `regression.test.ts` §1 |
| 2.3 | A statement added next to a code node → `node.updated`, not removed + added | 04 §2.11, I5 | `regression.test.ts` §2 |
| 2.4 | Hoisted promises (`Promise.all([aP, bP])`) must degrade to a code node, never a fake parallel node, and must not reach L2 | Live AI eval, `NOTES.md` "Phase 5" | `regression.test.ts` §3 |
| 2.5 | `const t = tools` resolves; a hand-made object of the same shape does not; a local `tools` shadow does not | 04 §1.2 | `regression.test.ts` §4 |
| 2.6 | A call hidden in an `if`/`while` condition, a call argument, a `.map()` callback or a template interpolation degrades — and the diagnostic points at the **call**, not the head of the code node | 04 §1.4, I1 | `regression.test.ts` §5 |
| 2.7 | `files.some(isAuthChange)` gets the registry label; `!files.some(…)`, `a && b`, `a \|\| b`, `.filter(fn).length > 0` do not | 04 §2.2b, I6 | `regression.test.ts` §6 |
| 2.8 | `changedNodeIds` is the edited node plus what the patch added — never every `node.updated` | Phase 6b browser session | `react/test/hardening/changed-nodes.test.ts` |

## 3. Hazards hunted in this pass (no bug found — behaviour now pinned)

### Encoding and format — `encoding.test.ts`

CRLF survives a field edit, a property removal, a statement insert and an empty
edit (no stray LF anywhere); a BOM'd CRLF file works; tab indentation with
spaces mixed in is preserved and a new property copies the indentation of the
property above it; a 5000-character line patches at the right column; CJK and
emoji survive in a sibling field and in a comment; a ZWJ family emoji is written
as itself (not surrogates or escapes) and reads back identically; a string
literal is never promoted to a template even when the new text contains `${`; a
string already holding `${`, `}}` and escaped backticks is left alone; the same
file analyzes identically twice in every encoding, and a BOM'd file has a
different content hash from its BOM-free twin.

### Syntax — `syntax.test.ts`

Optional chaining on `tools` degrades with `unsupported-optional-chaining`; a
non-null assertion on a tool call degrades; `as const` and `satisfies` keep the
node but refuse field edits (the argument is not a visible object literal —
06 §1); a two-argument call refuses. Keys: quoted (double and single), numeric,
`["channel"]`, shorthand (rewritten to longhand, data edge correctly
disappearing), before/after a spread. Layout: comments between key and value and
inside the argument list survive; a new property follows the literal's own
trailing-comma habit; a trailing comment on a surviving line stays. Templates: a
template nested inside a template's interpolation is untouched; editing around
an interpolation keeps the template; a bare string against an expression field is
refused with an explicit reason; a one-interpolation template and a bare
expression are never confused.

### Control flow — `control-flow.test.ts`

`try` in a loop in a `try` (both `try` nodes, correct nesting, inner `continue`
and inner body both routed through the inner `finally`, outer `error` edge);
`continue` inside a `try` with a `finally`; labelled `continue`/`break` across
two loop levels (label on the node, in `data`, and no merge invented after the
last `if` of a block); `return` inside a `catch` with a `finally`; five-deep
`else if` (four condition nodes, exactly one merge, five branches into it);
`Promise.all` inside a loop inside a `try` (branch labels, destructured ports on
the merge, loop variable into the right branch); a code node between two tool
nodes that depend on each other (control and data threaded *through* it, and the
delete of the producer refused). Unsupported loop forms — `for (;;)`, `do…while`
— degrade; an unbounded `while` warns.

### Data flow — `data-flow.test.ts`

Three same-named declarations at three depths bind to three different producers;
an inner `const files` does not steal the outer one's readers; a three-level
chain of renamed bindings resolves. A `let` written in a declaration and three
branches has an edge from **each** of the four writers. Destructuring: rename
(`{ data: rows }` → port `data`, label `rows`), nested object, nested array,
rest element. One binding read from a condition, a body and a template gets an
edge to every reader. A name used before its declaration does not crash and does
not get a backwards edge; a hoisted function declaration is fine. `input` is a
producer, including from inside nested constructs.

### Adversarial patching — `patch-adversarial.test.ts`

One of six identical `"#security"` strings changed — the one in the edited
field; a value identical to its sibling's; one of two byte-identical calls; a
value that also appears in another node's template literal; two fields of one
object as two ranges. Commas: removing the first, a middle, the last, the last
with a trailing comma, one from a single-line literal, one with its trailing
comment, and two in one patch. Five patches in a row keep every id and land on
the right bytes; reversing an edit returns the file byte for byte; reversing a
property removal restores the exact text. A seven-case round-trip matrix
(single-line, quoted key, CRLF, BOM, nested in loop-in-try, template sibling,
unicode) asserts: only the edited node changes, no additions or removals, the
same edit again is a no-op, and a cold re-analyze agrees. Refusals — unknown
`$` operation, exclusive operation mixed with a field, a field outside the input
schema, a file that moved, a *comment* inside the node that moved — all leave
the source untouched.

### Degradation — `degradation.test.ts`

`switch`, a tool call inside a nested arrow, `throw`/`debugger`/dynamic import,
two declarators in one statement, unicode identifiers, and a ten-deep nest.
`tools["slack"].send` and `tools.slack["send"]` are **not** resolved (deciding
what a computed key evaluates to has no bottom). A whole-root alias (`const t =
tools`) allows a tool change; a namespace alias (`const gh = tools.github`, or
destructured) refuses it while still allowing field edits. An unresolved tool is
an `unknown` node with an error diagnostic and no editable fields, and becomes a
real tool node the moment the registry learns about it. A registry that moves
under a graph blocks every patch. `$code` replaces an opaque region, accepts
several statements, and refuses text that would not parse.

---

## 4. Deliberately not covered — `todo` entries and why

| Where | Why it is not a test |
|---|---|
| `control-flow.test.ts` → "known over-approximation: the finally's single successor…" | After `return` inside a `catch`, control leaves the function; the flat model draws one exit from the `finally` and it lands on the trailing `return`. Fixing it needs terminal-aware exits out of a `finally`, which is beyond the MVP model of 04 §2.7 — the same section already scopes nested-`try` terminals to their own `finally`. |
| `degradation.test.ts` → "`$code` that drops a binding a later node still reads" | The candidate parses and obeys the flow contract, and core cannot type-check it: the project runs ts-morph with `noLib`/`noResolve` because the analysis path never needs a checker (04 §1.2), and 06 §4 makes the type check conditional on a host that has one. A host with a checker gets the guarantee today; closing it inside core is a design decision above this suite. |
| `react/.../changed-nodes.test.ts` → "DOM-level: … `is-changed`" | Driving the provider's state needs a DOM. `@codeflow-team/react` runs its tests in `environment: "node"` and jsdom is not a dependency (adding one was out of scope for this pass). The rule the provider applies is tested against real `PatchResult` data instead, and the browser checklist (11 §3.5) covers the rendering. |

Two further limits are **behaviour, not gaps**, and are asserted as such rather
than listed as debt: `as const` / `satisfies` arguments are shown but not
editable (`syntax.test.ts`), and a tool reached through a namespace alias cannot
have its tool changed (`degradation.test.ts`). Both are 06 §1/§2 refusals — said
out loud, never approximated.

## 5. Adding to this suite

1. Reproduce the bug as a test **before** fixing it (11 §4).
2. Put it in the file whose theme it matches; add a row to §1 or §3 above.
3. Say in a comment what the *wrong* behaviour was and which invariant it
   violates. A hardening test whose comment only restates the assertion is worth
   half of one that explains what it caught.
4. If the answer is "this is out of scope", make it an `it.todo` with the reason
   and the spec section — never a deleted test.
