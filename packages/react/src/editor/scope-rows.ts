/**
 * "Available here" — the rows a user can drag into a parameter.
 *
 * The whole node editor rests on one observation: in CodeFlow the connection
 * between two steps **is** the variable reference in the source (03 §6). So the
 * left pane is not a new concept — it is `graph.scopes[nodeId]`, the analyzer's
 * own answer to "what is in scope at this node", turned into rows whose `path`
 * is a TypeScript expression. Dragging a row into a field is then an ordinary
 * field patch (06 §3), with the diff preview and the refusals it already has.
 *
 * Three rules shape every row here:
 *
 * 1. **A name is a fact; a value may be observed, sampled, or absent.** Every
 *    row therefore carries `valueSource` — `observed` (a run produced it),
 *    `sample` (generated from the declared schema by core's `sampleFromSchema`,
 *    deliberately synthetic on sight), or `declared` (nothing but the name and
 *    its type). The label lives in the *data*, not in a caption a later edit
 *    could drop: a component must not be able to render a sample without
 *    knowing it is one (07 §5).
 * 2. **Observed always wins.** A sample is never shown for a binding a run
 *    already answered.
 * 3. **The origin is named, never identified.** A row says which *step* wrote
 *    the value using that step's label (07 §4); node ids stay out of the UI.
 *
 * Pure and DOM-free — this is the unit-test surface of the drag gesture.
 */

import {
  isJsonSchema,
  isNamedFieldsSchema,
  sampleFromSchema,
  type Schema,
  type ScopeBinding,
} from "@codeflow-team/core";

/**
 * Where a row's value came from.
 *
 * Not a boolean, and not a caption: a renderer reads this and must mark
 * `sample` differently from `observed`. `declared` means there is no value at
 * all — the schema named a field and nothing has ever filled it.
 */
export type ValueSource = "observed" | "sample" | "declared";

export interface ScopeRow {
  /**
   * The expression text this row inserts — `pr.title`, `prs[0].number`.
   *
   * This is TypeScript, not a template language (00 §6.7). It is what gets
   * written into the source, and what `{{ }}` displays back.
   */
  path: string;
  /** What the row reads as: the last segment (`title`), or the binding's name. */
  label: string;
  /** 0 for the binding itself, 1 for its fields, and so on. */
  depth: number;
  /** Root binding this row belongs to — what `canDrop` checks against scope. */
  bindingName: string;
  /** `ScopeBinding.kind`, carried through so a UI can filter without guessing. */
  kind: string;
  /** True for the item variable of an enclosing `for…of` — shown first. */
  loopItem: boolean;
  /** True for a parameter of the flow function itself. */
  parameter: boolean;
  valueSource: ValueSource;
  /** False for a `declared` row: there is no value, not even `undefined`. */
  hasValue: boolean;
  /** The value, when `hasValue`. Verbatim — never truncated here. */
  value?: unknown;
  /** The declared type in words, when the schema says one ("string", "File[]"). */
  typeText?: string;
  /** Label of the step that writes this binding — a name, never an id (07 §4). */
  originLabel?: string;
  /** Something true about the row that the path alone does not say. */
  note?: string;
}

export interface ScopeRowsOptions {
  /**
   * The value a run observed for this binding's origin, wrapped so that a
   * legitimately `null`/`undefined` observation is distinguishable from "no run
   * happened". Omit it and the rows fall back to a sample, then to declared.
   */
  observed?: { value: unknown };
  /** Label of the step that produced the binding — shown instead of its id. */
  originLabel?: string;
  /** How deep into a schema/value the tree goes. Default 3. */
  maxDepth?: number;
  /** Hard cap on rows for one binding, so a wide object cannot flood the pane. */
  maxRows?: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ROWS = 120;

/**
 * Which bindings can be dragged, and which are merely *in scope*.
 *
 * The draggable list is values and flow parameters — the things that carry
 * data. `tools`, imports and local functions are in scope too, and hiding them
 * outright would make the pane disagree with the analyzer, so they come back in
 * `other` for a disclosure to show. Nothing disappears without a trace.
 */
export interface ScopeGroups {
  values: ScopeBinding[];
  other: ScopeBinding[];
}

export function groupScope(bindings: readonly ScopeBinding[]): ScopeGroups {
  const values: ScopeBinding[] = [];
  const other: ScopeBinding[] = [];
  for (const binding of bindings) {
    if (binding.kind === "value") values.push(binding);
    else other.push(binding);
  }
  // The current item first: inside a loop it is what the user reaches for, and
  // it is the one binding whose meaning depends on *where* the node sits.
  values.sort((a, b) => Number(b.loopItem ?? false) - Number(a.loopItem ?? false));
  return { values, other };
}

/**
 * A schema's type, in the words the schema itself uses.
 *
 * Returns `undefined` rather than a guess when the schema says nothing — an
 * empty type column is honest, "any" would not be.
 */
export function describeSchema(schema: Schema | undefined): string | undefined {
  if (schema === undefined) return undefined;
  if (typeof schema === "string") return schema;
  if (isJsonSchema(schema)) {
    const record = schema as Record<string, unknown>;
    const enumeration = record["enum"];
    if (Array.isArray(enumeration)) return enumeration.map((value) => JSON.stringify(value)).join(" | ");
    const type = record["type"];
    const name = Array.isArray(type) ? type.map(String).join(" | ") : typeof type === "string" ? type : undefined;
    if (name === "array") {
      const items = record["items"];
      const inner = items === undefined ? undefined : describeSchema(items as Schema);
      return `${inner ?? "unknown"}[]`;
    }
    if (name === undefined && record["properties"] !== undefined) return "object";
    return name;
  }
  if (isNamedFieldsSchema(schema)) return "object";
  return undefined;
}


/** `a.b` when the key is an identifier, `a["odd key"]` when it is not. */
function accessorFor(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One node of the tree being walked: a schema and (maybe) a value, together. */
interface Frame {
  path: string;
  label: string;
  depth: number;
  schema: Schema | undefined;
  value: unknown;
  hasValue: boolean;
  note?: string;
}

/**
 * Children of one frame — from the schema when there is one, otherwise from the
 * value that was actually observed.
 *
 * A schema is the better structure because it names fields a particular run may
 * not have produced; an observed value is used when there is no schema, because
 * the keys of a value that exists are facts about it.
 */
function childrenOf(frame: Frame, maxDepth: number): Frame[] {
  if (frame.depth >= maxDepth) return [];
  const schema = frame.schema;

  if (schema !== undefined && typeof schema !== "string") {
    if (isJsonSchema(schema)) {
      const record = schema as Record<string, unknown>;
      const properties = record["properties"];
      if (isRecord(properties)) {
        return Object.entries(properties).map(([key, child]) =>
          childFrame(frame, key, accessorFor(key), child as Schema),
        );
      }
      const items = record["items"];
      if (items !== undefined) return [itemFrame(frame, items as Schema)];
      return [];
    }
    if (isNamedFieldsSchema(schema)) {
      return Object.entries(schema).map(([key, child]) =>
        childFrame(frame, key, accessorFor(key), child as Schema),
      );
    }
  }

  // No schema (or a TS type ref, which cannot be walked without a type
  // checker): fall back to the shape of the value, when there is one.
  if (!frame.hasValue) return [];
  if (Array.isArray(frame.value)) return frame.value.length === 0 ? [] : [itemFrame(frame, undefined)];
  if (isRecord(frame.value)) {
    return Object.keys(frame.value).map((key) => childFrame(frame, key, accessorFor(key), undefined));
  }
  return [];
}

function childFrame(parent: Frame, key: string, accessor: string, schema: Schema | undefined): Frame {
  const present = parent.hasValue && isRecord(parent.value) && key in parent.value;
  return {
    path: `${parent.path}${accessor}`,
    label: key,
    depth: parent.depth + 1,
    schema,
    value: present ? (parent.value as Record<string, unknown>)[key] : undefined,
    hasValue: present,
  };
}

/**
 * The `[0]` step into a list.
 *
 * A list of ten rows is not ten draggable things — it is one shape, and the
 * expression that reaches it has to name an index. `prs[0]` says "the first
 * one", which is exactly what it does when the flow runs; no index is implied
 * that the source does not contain.
 */
function itemFrame(parent: Frame, items: Schema | undefined): Frame {
  const array = parent.hasValue && Array.isArray(parent.value) ? parent.value : null;
  const present = array !== null && array.length > 0;
  return {
    path: `${parent.path}[0]`,
    label: "first item",
    depth: parent.depth + 1,
    schema: items,
    value: present ? array[0] : undefined,
    hasValue: present,
    ...(array === null
      ? {}
      : { note: array.length === 1 ? "the only item" : `first of ${String(array.length)}` }),
  };
}

/**
 * The draggable rows for one binding.
 *
 * Precedence, in one place so nothing else has to re-decide it: a real observed
 * value from the run wins; otherwise a sample generated from the declared
 * schema; otherwise the declared shape alone. A binding with neither a schema
 * nor an observation yields exactly one row — itself — because that is all
 * anybody knows about it.
 */
export function scopeRows(binding: ScopeBinding, options: ScopeRowsOptions = {}): ScopeRow[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;

  const observed = options.observed;
  const sample = observed === undefined ? sampleForSchema(binding.schema) : undefined;
  const source: ValueSource =
    observed !== undefined ? "observed" : sample !== undefined ? "sample" : "declared";

  const root: Frame = {
    path: binding.name,
    label: binding.name,
    depth: 0,
    schema: binding.schema,
    value: observed !== undefined ? observed.value : sample?.value,
    hasValue: observed !== undefined || sample !== undefined,
  };

  const rows: ScopeRow[] = [];
  const emit = (frame: Frame): void => {
    if (rows.length >= maxRows) return;
    rows.push(toRow(frame, binding, source, options.originLabel));
    for (const child of childrenOf(frame, maxDepth)) emit(child);
  };
  emit(root);
  return rows;
}

/**
 * A sample only where a sample means something.
 *
 * `sampleFromSchema` reads JSON Schema. A TypeScript type ref (`"File[]"`) and
 * a named-fields map carry no shape it can fill, and inventing one from a type
 * *name* would be a guess rather than a sample — so those stay `declared`.
 */
export function sampleForSchema(schema: Schema | undefined): { value: unknown } | undefined {
  if (schema === undefined || typeof schema === "string") return undefined;
  if (!isJsonSchema(schema)) return undefined;
  return { value: sampleFromSchema(schema) };
}

function toRow(
  frame: Frame,
  binding: ScopeBinding,
  source: ValueSource,
  originLabel: string | undefined,
): ScopeRow {
  // A field the schema declares but this particular value does not carry is
  // `declared`, whatever the binding as a whole is: the run did not produce it.
  const valueSource: ValueSource = frame.hasValue ? source : "declared";
  const typeText = describeSchema(frame.schema);
  return {
    path: frame.path,
    label: frame.label,
    depth: frame.depth,
    bindingName: binding.name,
    kind: binding.kind,
    loopItem: binding.loopItem === true,
    parameter: binding.parameter === true,
    valueSource,
    hasValue: frame.hasValue,
    ...(frame.hasValue ? { value: frame.value } : {}),
    ...(typeText === undefined ? {} : { typeText }),
    ...(originLabel === undefined ? {} : { originLabel }),
    ...(frame.note === undefined ? {} : { note: frame.note }),
  };
}

/**
 * A short, single-line rendering of a value for a row.
 *
 * Truncation is visible (`…`) and never silent, and the full value is still on
 * the row for anything that wants to show all of it.
 */
export function rowValueText(row: ScopeRow, max = 48): string | null {
  if (!row.hasValue) return null;
  const value = row.value;
  const text =
    typeof value === "string"
      ? value
      : value === undefined
        ? "undefined"
        : JSON.stringify(value) ?? String(value);
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
