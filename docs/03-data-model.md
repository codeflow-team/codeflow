# 03 — Data Model

## 1. WorkflowGraph

```ts
interface WorkflowGraph {
  id: string;
  version: number;            // incremented on every re-analyze
  source: SourceDocument;     // file path + content + content hash
  registryHash: string;       // fingerprint of the registry at analyze time — the graph
                              // is a function of (source, registry), so staleness has to
                              // be checked against BOTH
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  diagnostics: Diagnostic[];
}
```

## 2. WorkflowNode

```ts
interface WorkflowNode {
  id: string;                 // stable identity — see §5
  type: NodeType;
  label: string;

  source: SourceMapping;      // every node maps back to source — see §4

  inputs: NodePort[];
  outputs: NodePort[];

  // node-type-specific data: tool name, editable field values,
  // condition expression, loop variable, code snippet...
  data: Record<string, unknown>;

  capabilities: NodeCapabilities;  // editable? deletable? expandable?
}

interface NodePort {
  id: string;
  label: string;
  schema?: Schema;            // from the registry or from the TS type
}
```

## 3. NodeType

```ts
type CoreNodeType =
  | "trigger"      // synthetic — from the flow function signature + TriggerMetadata (§9)
  | "tool"         // await tools.<ns>.<fn>(...)
  | "function"     // library function OR local function — called as a statement
  | "condition"    // if / else
  | "loop"         // for...of OR while — body is a subgraph; data.kind: "forOf" | "while"
  | "try"          // try/catch(/finally) — body/catch/finally are subgraphs;
                   //   control edge "error" from body to catch
  | "jump"         // break | continue — terminal node in the loop subgraph;
                   //   data.kind: "break" | "continue"; data.label?: string (labeled jump)
  | "parallel"     // Promise.all
  | "merge"        // synthetic — the join point after a parallel/condition
  | "code"         // fallback: an UNSUPPORTED construct — source kept verbatim
  | "output"       // the flow's return — both the final return and early returns
                   //   (one output node per return statement, 1:1 with the source)
  | "unknown";     // a RECOGNIZED construct whose resolution FAILED
                   // (e.g. a call shaped like tools.x.y where the tool is not in the registry)

// Open to plugins: new node types are registered through the registry, no core changes
type NodeType = CoreNodeType | (string & {});
```

`code` vs `unknown`: `code` means "CodeFlow is not trying to understand this; it is a legitimate opaque region" (info). `unknown` means "this looks like something supported but resolution failed — it may be a bug" (accompanied by an error/warning diagnostic).

## 4. Source Mapping

Every node maps back to a source region:

```ts
interface SourceMapping {
  file: string;
  start: SourcePosition;      // line, column, offset
  end: SourcePosition;
  semanticPath: string;       // see §5
  fingerprint: string;        // normalized hash of the AST subtree (trivia/formatting dropped)
}
```

Source mapping never relies on line numbers alone — the line number is the first thing to break when code changes.

**Synthetic nodes**: `merge`, `trigger` — and `output` when the flow has no explicit `return` — have no construct of their own in the source. The rule: they map to the source range of the construct **that produced them** (the merge of an `if/else` → the whole if statement; the merge of a `Promise.all` → that statement; the trigger → the flow function's signature; the implicit output → the end of the function body), with a role qualifier in the semantic path: `flow/if[0]#merge`, `flow#trigger`. Several nodes may share one source range, but each range has exactly **one owner node** for editing purposes (synthetic nodes are not directly editable). An `output` from a real `return` statement and a `jump` (`break`/`continue`) map straight to their own statement — they are not synthetic.

## 5. Stable Node Identity

### 5.0 Generating ids, and the two identity modes

`node.id` is an **opaque handle**, created the first time a node appears, and it **does not encode content** (it is not derived from the tool name — which is why changing the tool does not change the id):

- **Cold analyze** (no previous graph): the id is a deterministic hash of the semantic path at creation time → the same (source, registry) always yields the same graph with the same ids (invariant I2). Fixture `expected-graph.json` comparisons run on this path.
- **Session re-analyze** (a `CodeFlowSession` holding a previous graph — see [02-architecture.md](02-architecture.md) §5): ids are **carried across** by the resolution mechanism in §5.2 — an old node keeps its old id, a new node gets a new one. An id inside a session may therefore differ from the id a cold analyze of the same source would produce. That is deliberate: I2 promises determinism for cold analyze; a session promises **continuity**. View state, selection and `GraphChange` are all session-scoped concepts.

`edge.id` = a deterministic hash of (source node id, target node id, kind, ports) — edges never need resolution of their own.

### 5.1 Semantic path

The structural path from the flow root to the construct, **including a sibling index** so that two identical constructs in the same scope stay distinct:

```text
flow/for[0]/if[0]/call:slack.send[0]
flow/for[0]/if[0]/call:slack.send[1]   // second call to the same tool in the same block
```

### 5.2 Identity resolution order

When the source changes, old nodes are resolved onto new nodes:

0. **Patch provenance** — a patch produced by the **patch engine** ([06-patch-engine.md](06-patch-engine.md)) knows in advance what it inserts/edits/deletes, so it carries an exact `oldNodeId → newRange` mapping with it. This path uses **no heuristics** — every edit through the inspector or the palette preserves identity absolutely, even when inserting a call identical to the one already there. **Note**: editing the source directly in Monaco (even though that is CodeFlow's own UI) has **no** provenance — it goes through heuristics 1–4 like any external source change.
1. **Sibling-group alignment** — for changes without provenance, nodes under the same parent are matched by an **order-preserving alignment** (LCS/diff style) in which "equal" is decided in priority order: matching fingerprint → matching call signature. Comparing fingerprints first means that swapping two calls to the same tool with different arguments still matches each to the right counterpart (no cross-assignment). Inserting a new `slack.send` before an existing one → alignment sees the old element shift down and keeps its id. The sibling index in the semantic path (§5.1) is only a **stable naming scheme applied after resolution**, never the matching key. **Acknowledged limitation**: two siblings that are identical *down to the byte* are in principle indistinguishable from a source diff — deleting one of them may report the "wrong one" as removed (the consequence is purely cosmetic: view state/selection). The provenance path (deleting through the UI) is not subject to this.
2. **Fingerprint** match (the node moved within the tree, its content unchanged).
3. **Approximate source range** + matching node type.
4. Surrounding **structural context** (best-effort).

No match → the old node counts as removed and the new node as added (and the graph diff says exactly that). **Safety rule**: reporting removed+added is better than assigning an old id to the wrong node — mis-binding is a more serious failure than losing identity (mandatory test: [11-testing.md](11-testing.md) I5).

### 5.3 What is guaranteed

Identity **is guaranteed** to survive:

- formatting, and adding/removing unrelated lines;
- editing the contents of another node;
- patches produced by the patch engine (including changing the tool — the id is an opaque handle, §5.0).

(Purely visual operations such as pan/zoom/select do not touch the source, so they obviously do not affect identity; the MVP does not persist manual positions — §8.)

Identity is **best-effort only** (losing it is acceptable) when:

- the AI regenerates the whole file — fingerprint matching salvages part of it, the rest is a new graph replacing the old one;
- a large refactor changes both structure and node content.

The v0.1 draft promised that identity survives "source regeneration"; v0.2 withdraws that promise, because it cannot be kept and does not need to be.

## 6. WorkflowEdge

```ts
interface WorkflowEdge {
  id: string;
  source: string;             // node id
  target: string;
  kind: "control" | "data";
  sourcePort?: string;
  targetPort?: string;
  label?: string;             // e.g. "true"/"false" on a condition branch,
                              // or the variable name on a data edge
}
```

- **Control edge**: execution order (sequential, condition branches, loop iteration).
- **Data edge**: tracked through **identifier bindings, resolved by symbol** (not by name — shadowing in a nested scope resolves to the nearest binding). Bindings include: `const`/`let` declarations, the flow function's parameters (`input`), the loop variable (`pr`), and destructured names (`const { data, error } = await tools.x.y()` → the tool node gets output ports `data`, `error`). Using a binding (including a property access such as `input.repository`) → a data edge from the producing node: one binding used in N nodes → N edges from the same port. A `let` that is **reassigned** in several branches → an edge from **each** node that writes it (the union of writers). Same file only; no alias analysis.
- **Acknowledged limitation (mutation)**: a data edge represents a def-use relationship, not mutation ordering. `files.push(x)` inside a code node does not reverse an existing `files` edge; the code node that references the binding still gets a reader edge, so it is present in the chain, and control edges keep the execution order correct — but the graph does not claim "the value was modified by B before it reached C". This is a deliberate MVP trade-off.

## 7. Diagnostics

```ts
interface Diagnostic {
  severity: "info" | "warning" | "error";
  code: string;               // e.g. "unsupported-construct", "unresolved-tool"
  message: string;
  source?: SourceMapping;
}
```

Examples:

- `info` — "Custom code kept verbatim; no semantic projection."
- `warning` — "`hidden-call-in-expression`: a tool call sits inside an expression — hoist it into its own `const` to make it a node." ([04-analyzer.md](04-analyzer.md) §1.4)
- `warning` — "`unbounded-loop-risk`: could not recognise a stopping condition for this `while`."
- `error` — "Cannot resolve tool `github.getFiles` — not in the registry." (node → `unknown`)
- `error` — "`stale-generated-artifacts`: generated/tools.d.ts does not match the current registry — run `codeflow generate`."

## 8. View state — node positions are NOT semantic state

Node positions on the canvas are computed by ELK auto-layout ([07-ui.md](07-ui.md)) — **derived from the graph, never stored in it**. Dragging a node is a purely visual operation: it does not touch the source, so identity obviously stays intact.

If a host app wants to remember user-placed positions, that is **UI-layer view state**, stored outside `WorkflowGraph` (e.g. `Record<nodeId, {x, y}>` keyed by stable node id) and acceptable to lose (cosmetic). This rule is what upholds "no second representation to keep in sync": the semantic graph never carries information that cannot be derived from the code. MVP: always auto-layout, no persisted manual positions.

## 9. AnalyzeOptions and TriggerMetadata

```ts
interface AnalyzeOptions {
  trigger?: TriggerMetadata;    // supplied by the host/runtime — it is not in the code
}

interface TriggerMetadata {
  kind: "webhook" | "cron" | "manual" | (string & {});
  label?: string;
  config?: Record<string, unknown>;   // e.g. a cron expression
}

flow.analyze(source, options?: AnalyzeOptions): Promise<WorkflowGraph>;
```

The trigger node is built from the type of the `input` parameter (always present) plus `TriggerMetadata` when the host supplies it (which makes the label/icon more specific: "⏰ Every day 9am" instead of "⚡ Trigger").

## 10. GraphChange (graph diff)

After each re-analyze, core emits a diff rather than a whole new graph — for incremental UI updates and for debugging:

```ts
interface GraphChange {
  type: "node.added" | "node.removed" | "node.updated"
      | "edge.added" | "edge.removed";
  nodeId?: string;
  edgeId?: string;
  changes?: Record<string, unknown>;
}
```

## 11. Appendix — supporting types

Minimal definitions of the types referenced throughout the specs:

```ts
// Schema — used for ports/inputs/outputs. Three shapes, one union:
// - JSON Schema object (the MCP source; the inspector can render a form and validate)
// - TS type reference string ("File[]", "boolean") — from codegen/TS;
//   the inspector CANNOT build a form from this → such fields use the expression editor
// - Named-fields map ({ files: "File[]" }) — shorthand for an object input,
//   keys are parameter/property names; this is the shape used in the examples in these docs
// Conversion rules: MCP JSON Schema → TS types when generating tools.d.ts
// (json-schema-to-typescript); a TS ref is used verbatim in the .d.ts;
// a named map → an object type / parameter list at codegen time.
type Schema = JsonSchema | TsTypeRef | Record<string, JsonSchema | TsTypeRef>;
type TsTypeRef = string;
type JsonSchema = Record<string, unknown>;  // standard JSON Schema draft — not redefined here

interface SourceDocument {
  file: string;
  content: string;
  contentHash: string;
}

interface SourcePosition {
  line: number;      // 1-based
  column: number;    // 1-based
  offset: number;    // 0-based, the canonical unit for every patch computation
}
// TextChange uses offsets; TextPatch uses SourcePosition (which contains an offset)
// → conversion goes through the offset, line/column exist only for display. When a
// NodePatcher returns several TextPatch values, their ranges MUST NOT overlap — the
// patcher validates this before applying.

interface NodeCapabilities {
  editable: boolean;        // does it have editable fields
  deletable: boolean;
  expandable: boolean;      // does it have a subgraph (loop) or a code view
}

// A text change — the input of Parser.update
interface TextChange {
  start: number;            // offset
  end: number;
  newText: string;
}

// The output of the patch engine — one replaced source region
interface TextPatch {
  range: { start: SourcePosition; end: SourcePosition };
  oldText: string;
  newText: string;
}

// Function library storage — implemented by the host app.
// MVP: the default implementation is file-based over the workspace lib/ directory
// (10-ai-codegen.md §2)
interface FunctionLibraryStore {
  list(): Promise<FunctionDefinition[]>;
  get(name: string): Promise<FunctionDefinition | null>;
  save(def: FunctionDefinition, opts?: { overwrite?: boolean }): Promise<void>;
  // an existing name without overwrite:true → reject (the UI shows a conflict prompt)
  remove(name: string, opts?: { force?: boolean }): Promise<void>;
  // removing/renaming a function that is in use: the UI/CLI must run a usage check
  // (codeflow check, or a scan of the open flows) and warn first — the same safety
  // bar as delete-node in the patch engine; force only after the user confirms.
  rename(oldName: string, newName: string): Promise<void>;
  // rename does NOT rewrite flows importing the old name — that is one patch per
  // flow (codeflow check lists them; the host/user decides whether to run it)
}

// Registry extension points (05-registry.md) — minimal signatures.
// AstNode: a syntax tree node (MVP: a ts-morph Node — opaque to plugins, stable
// behind the interface).
// AnalyzeContext: { source, registry, resolveBinding(...), addDiagnostic(...) }
// PatchContext:   { source, resolveRange(nodeId), addDiagnostic(...) }
// These two contexts are the plugin API surface — details are settled at implementation
// time; the principle is that a plugin never gets write access to the source, it only
// returns TextPatch[].
type SemanticAnalyzer = (ctx: AnalyzeContext, node: AstNode) => WorkflowNode | null;
type NodePatcher = (ctx: PatchContext, node: WorkflowNode,
                    changes: Record<string, unknown>) => TextPatch[];
type NodeRenderer = unknown;  // React component type — defined in @codeflow-team/react,
                              // core only holds an opaque reference

// Default capabilities per node type:
// tool/function/condition/loop-config: editable
// synthetic (merge, trigger*, implicit output): editable=false, deletable=false
// unknown: editable=false, deletable=true (through the dependency check),
//          expandable=false; its output binding IS still tracked for data edges;
//          "replace & reconfigure" to a different tool is allowed (06 §2)
// code: editable through Monaco, deletable (through the dependency check)
```
