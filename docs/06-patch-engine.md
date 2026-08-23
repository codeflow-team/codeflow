# 06 — Patch Engine (Workflow → Code)

## 1. Editable fields

Every node/tool definition declares which part of the source may be edited safely:

```ts
interface EditableField {
  name: string;               // "channel" — a property in the argument object
  label?: string;
  editor?: "text" | "expression" | "select" | "code";
  options?: unknown[];
}

// Shorthand: the string "channel" ≡ { name: "channel" } — normalized when the definition loads
type EditableFieldInput = EditableField | string;
```

Example:

```ts
await tools.slack.send({
  channel: "#security",
  message: `Security PR: ${pr.title}`
});
```

with `editableFields: ["channel", "message"]` the inspector renders:

```text
Channel   [#security            ]
Message   [Security PR: {{ pr.title }}]
```

Changing `channel` may patch only that one property.

**Precondition for editability — the argument must be a "visible" object literal:**

- the argument is a variable (`send(payload)`) → the node still shows, but the fields are **not editable**, plus an info diagnostic ("the argument is a variable — edit it in the code view"); nothing is guessed;
- an object literal with a spread (`{ ...defaults, channel: "#a" }`) → only fields written **after** the spread, and therefore visible, are editable; a field coming from inside the spread is not. **Never** insert a new property after a spread in order to override a value the user cannot see (silently changing behaviour violates I6);
- a shorthand property (`{ channel }`) → editing the value rewrites it to longhand (`channel: "#eng"`) — this is **defined as correct behaviour** (it is the expected diff in the fixture), and the resulting disappearance of the data edge from the `channel` variable is semantically accurate;
- a field whose schema is a TS ref (not JSON Schema) → the inspector cannot build a validating form, so it uses the **expression editor** ([03-data-model.md](03-data-model.md) §11).

## 2. Supported edits (MVP)

- primitive arguments (string/number/boolean literals);
- object properties inside the argument object (add/change/remove a property belonging to `inputSchema`);
- expressions (see §3);
- the condition expression of an `if` and of a `while`;
- the iterable expression of a `for...of`;
- deleting a `jump` node (`break`/`continue`) and the `output` node of an early return (deleting the statement — also through the dependency check, like every delete);
- **changing the tool** of a tool node to a compatible one — compatible means: the input fields the user has configured map onto the new tool (same name + type), and the new tool's output type is assignable to the current variable given its downstream uses (verified by a type check after the patch). Not compatible → the UI still allows the change, but as a "replace & reconfigure" (the node returns to needs-configuration). The node's identity survives through patch provenance ([03-data-model.md](03-data-model.md) §5.2 step 0) even though its semantic path/fingerprint change;
- **adding a new node** from the palette — a tool or a library function. The full flow:
  1. the user picks an **insertion point** on the canvas (a "+" affordance on the control edge between two nodes, or at the end of a branch);
  2. the patcher inserts the statement `const <var> = await tools.x.y({...});` — the variable name is generated from the tool name (camelCase, with a numeric suffix on collision: `files`, `files2`); for a library function it also adds the `import` from `modulePath` if it is not there yet;
  3. required input fields with no value → filled with the schema default if there is one, otherwise the node comes up in the **needs-configuration** state (warning diagnostic + a badge on the node, and the inspector opens itself) — the code still parses, and the user completes it in the inspector;
- creating/promoting a library function ("Save to library" — writes to `FunctionLibraryStore` and replaces the local function with an import);
- **deleting a node** — with a dependency check: if the statement's output binding is still used by a downstream node (a data edge, which core already tracks), the delete is refused and the blocking node is named ("Slack Send is using `files` — delete or edit that node first"). Never silently emit code that does not compile;
- editing the body of a custom function through Monaco (replacing the whole body — the region is opaque, so the "minimal patch" is the whole region);
- editing an **inline code node** through Monaco (replacing the opaque statement region, same mechanism).

**Not supported in the MVP** (and the UI must say "not supported" rather than quietly doing the wrong thing): dragging a node out of an `if`/`for`/`try` or into one, wrapping/unwrapping a `try` around an existing node, reordering nodes that have a data dependency, and every other structural edit. This is an important boundary — structural editing is the hardest part of the problem and is not needed for the first loop of value.

## 3. Expressions — display syntax, not a language

How the value of an editable field is displayed: a **literal** is shown verbatim; a **TypeScript expression** is wrapped in `{{ }}`:

```text
"#security"                    →  #security                        (string literal)
`Security PR: ${pr.title}`     →  Security PR: {{ pr.title }}      (template literal:
                                                                    each interpolation wrapped
                                                                    on its own)
pr                             →  {{ pr }}                          (identifier expression)
files.length                   →  {{ files.length }}               (any expression)
```

**Hard constraint:** `{{ }}` is only a way of *displaying* a TypeScript expression — a 1-1 bidirectional mapping that adds no semantics. It must never grow into an expression language of its own (no filters/pipes like `{{ x | upper }}`) — that would be exactly the "second representation" the core principle forbids. A power user who needs more switches to advanced mode and writes the TypeScript expression directly.

**Display is not an encoding — the reverse direction goes through the AST, it never parses the display text.** Each field holds a reference to its original AST form (string literal / template literal / expression). Edits are applied **relative to that original form**:

- editing the text of a string literal → still a string literal (even if the text contains `${` — never silently "upgrade" it to a template literal, because that changes semantics);
- editing the text around an interpolation in a template literal → still a template literal; typing another `{{ expr }}` in the friendly editor adds an interpolation;
- a plain string literal where the user types `{{ expr }}` → the UI asks and converts explicitly to expression mode (turning it into a template literal is a deliberate edit, never implicit);
- a field that is already a bare expression (`{{ pr }}`) → edited in the expression editor, and the result is still an expression; a single-interpolation template (`` `${pr.title}` ``) and a bare expression (`pr.title`) look identical on screen but are **never confused when patching**, because each patches back into its own original form;
- a boolean/number field (known from the JSON Schema) → a typed editor, and the value is written as a literal of the right type; clearing a required field removes the property and puts the node into needs-configuration.

**Escaping/ambiguity:** where the display would stop being 1-1 (a string literal that already contains `{{`/`}}`; an expression containing `}` such as `${ {a: 1} }`, or containing `{{` inside a nested string), the UI **refuses friendly mode for that field** and falls back to code display/editing (inline Monaco). No custom escape syntax is invented — falling back is the standard degradation mechanism, and the case is rare in real flow code.

## 4. Patch pipeline

```text
patchNode(nodeId, changes)
  ↓
Resolve node → source mapping
  ↓
Verify the source region has not changed since the graph was loaded
  ↓
Resolve the AST node (ts-morph)
  ↓
Validate the edit (against the editable field's schema)
  ↓
Compute the patch against a CANDIDATE source (an in-memory copy)
  ↓
Validate the candidate (re-parse; type-check where available —
  on failure → ABORT, the real source does not change by one byte,
  and diagnostics are returned)
  ↓
Commit atomically: apply the patch to the real source
  ↓
Re-analyze → graph diff → UI update
```

**Byte-for-byte constraint (I3)**: the patch is computed by **replacing the text range of the smallest affected AST node** — never by reprinting the parent node (reprinting drags in the printer's quote style/indentation/trailing commas and destroys the surrounding formatting). Quote style, indentation and trailing-comma style for newly inserted text are read from **the current source itself** (a file using single quotes gets single quotes), not from default manipulation settings. Removing a property removes its whole line together with any same-line comment, and adjusts the leftover/missing comma on the neighbouring property to match the existing style. Every one of these behaviours has a fixture with an expected diff ([11-testing.md](11-testing.md) §3.2).

**Transactionality**: every edit — including a "change tool" that needs a downstream type check — is validated on the candidate before it is committed; there is no state in which the source has been written and only then found to be broken. A composite operation (promoting a local function to the library: write the store + delete the declaration + add the import) runs in a safe order: write the store first (a failure stops there, with the source untouched), then patch the flow once (two regions, one commit); if the patch fails, the store entry remains but is harmless (no flow references it yet).

Example:

```ts
const result = await flow.patchNode("node_slack_01", {
  channel: "#security-team"
});
```

```diff
 await tools.slack.send({
-  channel: "#security",
+  channel: "#security-team",
   message: `Security PR: ${pr.title}`
 });
```

The returned result:

```ts
{
  source: string;          // the new source
  patches: TextPatch[];    // the changed regions
  graph: WorkflowGraph;    // the graph after re-analysis
  diagnostics: Diagnostic[];
}
```

## 5. Conflict detection

The MVP assumes **a single user with a single editor at a time** (one UI instance, with an AI/developer possibly editing the file externally). Before patching:

0. compare the graph's `registryHash` against the current registry — if the registry has changed (a tool removed or its schema changed) require a re-analyze before allowing edits;
1. compare the file's content hash against the hash taken when the graph was loaded;
2. if the file has changed → **re-analyze first**, and resolve the node again through identity ([03-data-model.md](03-data-model.md) §5.2);
3. if the node resolves and the **raw text** of its region is unchanged (compared as original text, **not** as a normalized fingerprint — a fingerprint drops trivia and would therefore miss the comment/formatting changes that a whole-region replacement could wipe out) → apply the patch normally;
4. if that region has changed → refuse the patch and tell the UI: "This node has changed since it was loaded — reload the workflow before editing."

Never silently overwrite a change made by the user or the AI. Richer conflict resolution in the UI (review/merge) comes after the MVP.
