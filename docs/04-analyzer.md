# 04 — Semantic Analyzer

The analyzer is the main intelligence layer: it takes a syntax tree + type information + the registry and returns a `WorkflowGraph`. Every rule below applies to the **body of the flow function** as defined by the [contract](01-flow-contract.md).

## 1. Principles

1. **Near-1:1 projection**: each supported construct → exactly one node. No "smart" merging of several statements into one node in the MVP (merging blurs source mapping, makes patching hard, and breaks round-trips easily). Smart merging comes after the MVP.
2. **Resolve by binding, not by name**: a call is a tool call when its property-access chain is **rooted in the binding of the `tools` parameter** (the flow function's second parameter — scope analysis, not string matching: an alias `const t = tools` still resolves, and an unrelated variable that happens to be named `tools` is not mistaken for it). The remaining path (`github.getFiles`) is looked up in the registry: an entry exists → `tool` node; **no entry → `unknown` node + diagnostic** (this is the rule that produces `unknown`). Library functions resolve the same way, through the binding of the import from `modulePath`. This needs only parse + scope analysis — **no full type check** — so it runs fast in the browser too. The TS type checker is an **enrichment** layer (types for ports, type-checking during validation) that runs where conditions allow (Node/CI); it is not a prerequisite for building the graph.
3. **When unsure, fall back**: a construct outside the supported list → custom code node + diagnostic. Never guess.
4. **Never swallow a side-effecting call** (this protects I1 — [11-testing.md](11-testing.md)): every **`await` expression** and every **tool call (rooted in `tools`)** that sits **inside an expression** (the condition of an if/while, an argument to another call, a computed element, a `.map(...)` callback) instead of standing as its own statement degrades **the whole containing statement** to a `code` node plus a `hidden-call-in-expression` diagnostic ("hoist it into its own `const` to make it a node"). One hidden call = one diagnostic (not doubled for `await tools.x.y()`). Examples: `if (await tools.github.hasLabel({pr}))`, `await Promise.all(prs.map(pr => tools.github.getFiles({pr})))` → code node, **never** a pretty condition/parallel node that hides a tool call inside it.
   **Deliberate scope — a synchronous library/local function call does NOT trigger this rule**: `if (isAdmin(user) && pr.draft)` is still a condition node with a raw expression. Reasons: (a) the point of the rule is side-effect visibility, and a synchronous predicate carries no side effect observable at the flow level (the real side effects live behind await/tools, and a function body is already opaque per 01 §4); (b) applying it literally would contradict §2.2b (a negated/compound condition containing a registered function is kept as a condition node) and §2.6 (a `Promise.all` element is allowed to be a single function call). Reference exception: a function *reference* used as a callback (§2.2b) is not a call at all, so it triggers even less. The style guide teaches the AI to hoist await/tool calls into a `const`, so this case is rare in conforming code; the rule is the safety net that keeps the graph from ever lying about side effects.

## 2. Mapping rules

### 2.1 Tool call

```ts
const prs = await tools.github.getNewPRs({ repo: input.repository });
```

→ a `tool` node for `github.getNewPRs`, with label/icon/schema from the registry; output port `prs` (schema from `outputSchema` or from the TS return type); the argument object becomes editable fields according to the definition.

### 2.2 Function call (library / local)

A function call **standing as its own statement** → `function` node:

```ts
const flagged = filterAuthChanges(files);   // library function → function node
```

### 2.2b A function reference inside an expression is NOT its own node

```ts
if (files.some(isAuthChange)) { ... }
```

Here `isAuthChange` is a callback passed to `Array.some` — it produces **no node of its own**. The whole of `files.some(isAuthChange)` is the condition expression of a `condition` node (§2.4). Label sugar applies only when the **entire** condition expression has the shape `fn(args)`, `xs.some(fn)` or `xs.every(fn)` and `fn` resolves **by symbol** to a registered function — then the node uses the label from the registry ("Is Auth Change?"). Any negation (`!files.some(...)`), any combination (`&&`/`||`), or any other shape → show the raw expression and do **not** use the label (a wrong label is failure mode I6 — raw beats wrong). This is purely a display concern; it does not change the graph structure, and the source mapping is still the whole `if`.

### 2.3 Sequential + data flow

```ts
const a = await foo();
const b = await bar(a);
```

→ two nodes joined by a control edge `foo → bar`, plus a data edge `a`. Data dependencies are tracked through bindings/symbols ([03-data-model.md](03-data-model.md) §6 — shadowing resolves correctly, and a `let` with several writers gets an edge from each writer).

### 2.4 Condition

```ts
if (cond) { A } else { B }
```

→ a `condition` node with two control edges labeled `true`/`false` (an `if` without an `else` sends the `false` branch straight to the join point), converging at a `merge` node. The merge rule belongs to **the analyzer and is purely structural** (nothing to do with layout): a merge node is produced **if and only if** there is a further statement in the same block after the branch point. If the branch point is the end of the block (end of a loop body, end of the flow body) → **no** merge node is produced, and both branches point at the block boundary (the loop node / the output). `cond` is an editable expression in the inspector.

An `else if` chain is an `IfStatement` nested in the else branch → projected 1:1 as nested condition nodes (semantic path `flow/if[0]/else/if[0]`), all sharing one merge at the outermost join point. There is no "multi-branch" node in the MVP.

### 2.5 Loop

```ts
for (const item of items) { ...body... }
```

→ a `loop` node ("For Each `item` in `items`"); the body is a **subgraph nested inside the node** (nested layout), not a back edge — easier for non-developers to read.

`for await...of` is handled like `for...of` (`data.kind` records it so the patcher preserves the `await`). Classic `for (;;)` and `do...while` are **not** supported → code node; if the body contains a tool call, the hidden-call rule (§1.4) guarantees a diagnostic rather than silence.

### 2.6 Parallel

```ts
const [a, b, c] = await Promise.all([
  tools.x.foo({}),
  tools.y.bar({}),
  isReady(input)
]);
```

→ a `parallel` fan-out node converging at a `merge`. Rules:

- only an **array literal** is accepted; each element must be **exactly one call** (tool/library/local function — no `await` inside an element, the `await` belongs to `Promise.all`) → that element becomes the node in the corresponding branch;
- an element more complex than a single call (a compound expression, `.map(...)`, a ternary...) → the whole statement degrades under the hidden-call rule (§1.4). `Promise.all(prs.map(...))` — the common dynamic form — is out of MVP scope: code node + diagnostic, and the style guide steers the AI toward `for...of` instead;
- the destructuring `[a, b, c]` → output ports placed on the `merge` node, each port recording which branch it came from (port `a` ← branch 1) so downstream data edges trace back to the right source.

### 2.7 Try / Catch

```ts
try {
  await tools.payment.charge({ amount });
} catch (err) {
  await tools.slack.send({ channel: "#alerts", message: `Charge failed` });
}
```

→ a `try` node: the body is the main subgraph, the catch is a second subgraph, joined by a control edge labeled **`error`** (the error binding `err` becomes a data edge into the catch body; `catch {}` has no binding — legal, it just has no data edge). A `finally` (if present) is a third subgraph, with a control edge from both branches — **and from every `jump`/`output` node inside the body/catch** (a break/return still runs `finally` before leaving; without those edges the graph would lie about side effects in `finally`). After the try node, the flow converges the same way a condition's merge does. Adding or removing a `try` wrapper around an existing node is a structural edit — not supported in the MVP ([06-patch-engine.md](06-patch-engine.md) §2).

### 2.8 While

```ts
let attempts = 0;
while (attempts < 3) {
  ...
  attempts++;
}
```

→ a `loop` node with `data.kind: "while"`, with the condition as an editable expression. **Bound check** (best-effort, not a termination proof): the analyzer recognises the common bounded idioms — a condition comparing a number against a variable updated in the body, or a condition on a variable assigned in the body. When it cannot recognise one → a `warning: "unbounded-loop-risk"` diagnostic on the node (the flow is still valid; whether to block it is the runtime's business, not CodeFlow's).

### 2.9 Return / Break / Continue

- `return` (at the end of the flow, or an early return inside an if/loop) → an `output` node ("End Flow"), one node per return statement, 1:1 with the source; the returned value is shown as an expression.
- `break` / `continue` inside a loop body → a `jump` node (a terminal chip inside the loop subgraph, with the matching `data.kind`): `break` cuts to the point after the loop, `continue` to the next iteration — shown as a label on the node, without drawing a back edge (which keeps the graph flat and readable). A labeled jump (`continue outer;`) → `data.label` holds the label name and the node shows "continue → outer", naming the target loop, so it never looks like a plain `continue`.
- The common guard pattern (`if (!x) continue;`) therefore displays naturally: condition node → `true` branch → jump node.

### 2.10 Trigger and Output

- The `trigger` node is built from the type of the `input` parameter plus `TriggerMetadata` when supplied ([03-data-model.md](03-data-model.md) §9).
- A flow with no explicit `return` → a synthetic `output` node at the end of the function body.

### 2.11 Fallback

Any statement/expression outside the rules above:

```ts
const result = extremelyComplexAlgorithm(data);
```

→ a `code` node that keeps the source verbatim, displayed as:

```text
┌─────────────────────┐
│ </> Custom Code     │
│ extremelyComplex…   │
│ [View Code]         │
└─────────────────────┘
```

Consecutive unsupported statements are merged into **one** code node (this is the only merging in the MVP — merging an opaque region does not affect mapping, because the whole region is a single source range). The semantic path of a code node is `stmt[i..j]`, by position in the block. **Identity of a merged code node**: the node stores a fingerprint **per statement** inside it; on re-analyze, a new code node matches an old one if they share ≥1 statement fingerprint → `node.updated` (the region grew or shrank), not removed+added. That is what keeps identity when a new unsupported statement is added next to an existing code node (invariant I5).

## 3. Function calls outside `tools`

Three cases, all resolved by symbol:

- **Library function** (imported from the function library, [05-registry.md](05-registry.md) §4) → a function node with schema/label/icon from the `FunctionDefinition`; the analyzer never looks inside the function body;
- **Local function** (declared in the flow file) → a function node built from the TS signature (name, params, return type); the body is not projected into the graph in the MVP;
- **Unfamiliar import / unresolvable call** → opaque code node + diagnostic.

## 4. Re-analysis

MVP: each source change → full re-parse + re-analyze + a **graph diff** against the previous graph (based on identity resolution, [03-data-model.md](03-data-model.md) §5.2) → emit `GraphChange[]` for the UI. Real incremental analysis (only the affected region) comes later, behind the same interface.
