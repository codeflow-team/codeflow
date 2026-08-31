/**
 * `<NodeEditor>` — three panes: what is available here, what this step is set
 * to, and what it produced.
 *
 * The point of this screen is one sentence: **someone who cannot read code can
 * connect the output of one step into a parameter of another, without typing.**
 * Everything else is in service of that.
 *
 * It is a thin wiring layer on purpose. Every decision it makes lives in a pure
 * function next door — `scopeRows` (what can be dragged), `dropInto` (what a
 * drop writes), `canDrop` (whether a row is legal here), `resultItems` /
 * `traceNotice` (what a run is allowed to claim) — because this package's tests
 * run in node, and a decision buried in a component would be the one part of
 * the feature with no deterministic test.
 *
 * Three rules it must never break:
 *
 * - a drop is an **ordinary field patch**: same `changes`, same engine, same
 *   diff-preview-before-commit. The new gesture does not get a shortcut past
 *   the promise the product is built on (06 §4);
 * - a **refusal from the engine is shown verbatim** — core names the offending
 *   identifier and lists what is in scope, and a second wording here would be a
 *   second source of truth;
 * - a value is never shown without saying where it came from: observed, sample,
 *   or merely declared (07 §5).
 */

import { useCallback, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { CornerDownLeft, Database, Info, Layers, Pin, Play } from "lucide-react";
import type { ScopeBinding, WorkflowNode } from "@codeflow-team/core";
import { useCodeFlow } from "../context/hooks.js";
import { humanFieldLabel, splitSpecRefs } from "../copy.js";
import { NodeGlyph } from "../flow/glyphs.js";
import { nodeCaption } from "../flow/summary.js";
import { resolveInspectorFields, type InspectorField } from "../inspector/fields.js";
import {
  changesFor,
  editorSpecFor,
  encodeFieldValue,
  mergeChanges,
  type FieldEditorKind,
} from "../inspector/edit.js";
import { CodeDiff } from "../diff/CodeDiff.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { cn } from "../ui/cn.js";
import { FieldHint, FieldLabel, Input, Textarea } from "../ui/input.js";
import { Modal } from "../ui/dialog.js";
import { Notice } from "../ui/notice.js";
import { canDrop, dropInto, type DropResult } from "./drop.js";
import { PreviewValue } from "./PreviewValue.js";
import {
  declaredOutput,
  observedAt,
  previewOrigin,
  resultItems,
  traceNotice,
  type ResultItem,
} from "./result.js";
import {
  groupScope,
  rowValueText,
  sampleForSchema,
  scopeRows,
  type ScopeRow,
} from "./scope-rows.js";

/* -------------------------------------------------------------------------- */
/* the dialog                                                                  */
/* -------------------------------------------------------------------------- */

export interface NodeEditorProps {
  /** Defaults to the provider's own `editorNodeId`. */
  nodeId?: string | null;
}

export function NodeEditor(props: NodeEditorProps = {}): ReactNode {
  const { editorNodeId, index } = useCodeFlow();
  const nodeId = props.nodeId === undefined ? editorNodeId : props.nodeId;
  const node = nodeId === null ? null : index.nodeById.get(nodeId) ?? null;
  if (node === null) return null;
  // Keyed by node id so opening a different step starts with clean drafts
  // rather than the previous step's half-finished edits.
  return <NodeEditorDialog key={node.id} node={node} />;
}

interface DraftState {
  text: Record<string, string>;
  checked: Record<string, boolean>;
  /** Control a drop moved this field to — `text` becoming `template`, say. */
  kind: Record<string, FieldEditorKind>;
  /** What the last drop did to this field, shown under it. */
  note: Record<string, string | null>;
}

const EMPTY_DRAFT: DraftState = { text: {}, checked: {}, kind: {}, note: {} };

function NodeEditorDialog({ node }: { node: WorkflowNode }): ReactNode {
  const {
    graph,
    registry,
    run,
    closeNodeEditor,
    editingEnabled,
    editingDisabledReason,
    patchNode,
    previewPatch,
    patchError,
  } = useCodeFlow();

  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<ScopeRow | null>(null);
  /** Which item of a repeated step the right pane (and the samples) is showing. */
  const [itemIndex, setItemIndex] = useState<number | null>(null);
  /** Field the user last had the caret in — where a click-to-insert lands. */
  const focused = useRef<{ name: string; caret: number } | null>(null);

  const model = useMemo(() => resolveInspectorFields(node, registry), [node, registry]);
  const specs = useMemo(() => {
    const out = new Map<string, ReturnType<typeof editorSpecFor>>();
    for (const field of model.fields) out.set(field.name, editorSpecFor(field));
    return out;
  }, [model]);

  const state = run?.nodes.get(node.id);
  const items = useMemo(() => resultItems(state), [state]);
  const item: ResultItem | null =
    items.length === 0 ? null : items[Math.min(itemIndex ?? items.length - 1, items.length - 1)];

  const kindOf = (field: InspectorField): FieldEditorKind =>
    draft.kind[field.name] ?? specs.get(field.name)?.kind ?? "text";
  const textOf = (field: InspectorField): string =>
    draft.text[field.name] ?? specs.get(field.name)?.value ?? "";
  const checkedOf = (field: InspectorField): boolean =>
    draft.checked[field.name] ?? specs.get(field.name)?.checked ?? false;

  const dirty = useMemo(
    () =>
      model.fields.filter((field) => {
        const spec = specs.get(field.name);
        if (spec === undefined || field.patch === null || field.blockedReason !== null) return false;
        if ((draft.kind[field.name] ?? spec.kind) !== spec.kind) return true;
        if (spec.kind === "checkbox") return (draft.checked[field.name] ?? spec.checked) !== spec.checked;
        return (draft.text[field.name] ?? spec.value) !== spec.value;
      }),
    [model, specs, draft],
  );

  const build = useCallback(():
    | { ok: true; changes: Record<string, unknown> }
    | { ok: false; message: string } => {
    const exclusive = dirty.filter((field) => field.patch !== "field");
    if (exclusive.length > 0 && dirty.length > 1) {
      return {
        ok: false,
        message: `"${exclusive[0].label}" rewrites its whole construct and cannot be applied together with other settings — apply it on its own (06 §2).`,
      };
    }
    const parts: Record<string, unknown>[] = [];
    for (const field of dirty) {
      const encoded = encodeFieldValue(kindOf(field), textOf(field), checkedOf(field));
      if (!encoded.ok) return { ok: false, message: encoded.message };
      parts.push(changesFor(field, encoded.value));
    }
    return { ok: true, changes: mergeChanges(parts) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, specs, draft]);

  /**
   * The diff, always, whenever something is pending.
   *
   * In the inspector previewing is a checkbox; here it is the default, because
   * this is the surface where an edit is made by dragging rather than by typing
   * — and a gesture that writes code the user never saw would be the one way
   * this editor could become dishonest.
   */
  const built = dirty.length === 0 ? null : build();
  const preview = built === null || !built.ok ? null : previewPatch(node.id, built.changes);

  const apply = async (): Promise<void> => {
    if (built === null) return;
    if (!built.ok) {
      setLocalError(built.message);
      return;
    }
    setLocalError(null);
    setBusy(true);
    const outcome = await patchNode(node.id, built.changes);
    setBusy(false);
    if (outcome.ok) setDraft(EMPTY_DRAFT);
  };

  /* --- the drop itself --------------------------------------------------- */

  const insert = useCallback(
    (row: ScopeRow, fieldName: string, caret?: number) => {
      const field = model.fields.find((candidate) => candidate.name === fieldName);
      if (field === undefined) return;

      const legal = canDrop(row, node.id, graph);
      if (!legal.ok) {
        setLocalError(legal.reason);
        return;
      }

      const result: DropResult = dropInto(field, row, {
        text: draft.text[fieldName] ?? specs.get(fieldName)?.value ?? "",
        ...(caret === undefined ? {} : { caret }),
      });
      if (!result.ok) {
        setLocalError(result.message);
        return;
      }

      setLocalError(null);
      setDraft((current) => ({
        text: { ...current.text, [fieldName]: result.display },
        checked: current.checked,
        kind: { ...current.kind, [fieldName]: result.kind },
        note: { ...current.note, [fieldName]: result.note },
      }));
      focused.current = { name: fieldName, caret: result.caret };
    },
    [model, node.id, graph, draft.text, specs],
  );

  const onDropField = (fieldName: string) => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const row = dragging;
    setDragging(null);
    if (row === null) return;
    const caret = focused.current?.name === fieldName ? focused.current.caret : undefined;
    insert(row, fieldName, caret);
  };

  /** Click-to-insert: the same gesture without a mouse drag, for keyboard use. */
  const insertIntoFocused = (row: ScopeRow): void => {
    const target = focused.current ?? firstOpenField(model.fields);
    if (target === null) {
      setLocalError("Pick a setting on the middle pane first — that is where the value goes.");
      return;
    }
    insert(row, target.name, target.caret);
  };

  const refusal = patchError !== null && patchError.nodeId === node.id ? patchError : null;

  return (
    <Modal
      open
      onOpenChange={(open) => { if (!open) closeNodeEditor(); }}
      className="w-[min(76rem,calc(100vw-2rem))] max-h-[min(48rem,calc(100dvh-3rem))]"
      title={
        <span className="flex items-center gap-2">
          <NodeGlyph node={node} className="size-4" />
          {node.label}
        </span>
      }
      description={nodeCaption(node, "expanded") ?? undefined}
      footer={
        <>
          {dirty.length === 0 ? (
            <span className="mr-auto text-[11.5px] text-ink-faint">
              Drag a value from the left onto a setting — nothing is written until you save.
            </span>
          ) : (
            <span className="mr-auto text-[11.5px] text-ink-dim">
              {dirty.length} setting{dirty.length === 1 ? "" : "s"} changed — the diff above is exactly what will be
              written.
            </span>
          )}
          <Button variant="ghost" onClick={closeNodeEditor}>
            Close
          </Button>
          <Button
            variant="primary"
            data-testid="editor-apply"
            disabled={!editingEnabled || busy || dirty.length === 0}
            onClick={() => { void apply(); }}
          >
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="cf-editor__panes flex-1" data-testid="node-editor">
        <ScopePane
          node={node}
          itemPath={item?.iteration ?? null}
          dragging={dragging}
          onDragStart={setDragging}
          onDragEnd={() => { setDragging(null); }}
          onUse={insertIntoFocused}
        />

        <section className="cf-scroll flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
          <PaneTitle icon={<Pin className="size-3.5" />} title="Configure">
            The settings of this step. Drop a value onto one to fill it in.
          </PaneTitle>

          {!editingEnabled ? (
            <Notice tone="info" title="Read-only">
              {splitSpecRefs(editingDisabledReason).text}
            </Notice>
          ) : null}

          {model.notice === null ? null : (
            <Notice tone="muted" refs={splitSpecRefs(model.notice).refs}>
              {splitSpecRefs(model.notice).text}
            </Notice>
          )}

          {/*
            The engine's own words, unedited.

            Core refuses an expression naming something that is not in scope,
            and its message names the identifier *and* lists what is available
            here. Rewording it would leave two sources of truth for the same
            refusal, and the shorter one would be the one that is wrong.
          */}
          {refusal === null ? null : (
            <Notice tone="danger" role="alert" data-testid="editor-refusal" code={refusal.code}>
              {refusal.message}
            </Notice>
          )}

          {localError === null ? null : (
            <Notice tone="warn" role="alert" data-testid="editor-error" onDismiss={() => { setLocalError(null); }}>
              {splitSpecRefs(localError).text}
            </Notice>
          )}

          {model.fields.length === 0 ? (
            <p className="m-0 text-[12px] leading-relaxed text-ink-dim">
              This step has no settings the patch engine can edit. What it does is written in the code itself — open
              the code view to change it.
            </p>
          ) : (
            model.fields.map((field) => (
              <DropField
                key={field.name}
                field={field}
                kind={kindOf(field)}
                text={textOf(field)}
                checked={checkedOf(field)}
                note={draft.note[field.name] ?? null}
                disabled={!editingEnabled || busy}
                armed={dragging !== null && field.patch !== null && field.blockedReason === null}
                onDrop={onDropField(field.name)}
                onFocus={(caret) => { focused.current = { name: field.name, caret }; }}
                onText={(value, caret) => {
                  focused.current = { name: field.name, caret };
                  setDraft((current) => ({ ...current, text: { ...current.text, [field.name]: value } }));
                }}
                onChecked={(value) => {
                  setDraft((current) => ({ ...current, checked: { ...current.checked, [field.name]: value } }));
                }}
              />
            ))
          )}

          {preview === null ? null : (
            <section data-testid="editor-preview" className="flex flex-col gap-2">
              <h4 className="m-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
                What will change in the code
              </h4>
              {preview.ok ? (
                <CodeDiff patches={preview.patches} />
              ) : (
                <Notice tone="warn" data-testid="editor-preview-refusal">
                  {preview.message}
                </Notice>
              )}
            </section>
          )}
        </section>

        <ResultPane
          node={node}
          items={items}
          item={item}
          onSelectItem={setItemIndex}
        />
      </div>
    </Modal>
  );
}

/** First field a value could go into, for click-to-insert with nothing focused. */
function firstOpenField(fields: readonly InspectorField[]): { name: string; caret: number } | null {
  const field = fields.find((candidate) => candidate.patch !== null && candidate.blockedReason === null);
  return field === undefined ? null : { name: field.name, caret: 0 };
}

/* -------------------------------------------------------------------------- */
/* left — available here                                                       */
/* -------------------------------------------------------------------------- */

function ScopePane({
  node,
  itemPath,
  dragging,
  onDragStart,
  onDragEnd,
  onUse,
}: {
  node: WorkflowNode;
  itemPath: readonly number[] | null;
  dragging: ScopeRow | null;
  onDragStart: (row: ScopeRow) => void;
  onDragEnd: () => void;
  onUse: (row: ScopeRow) => void;
}): ReactNode {
  const { graph, index, run } = useCodeFlow();
  const bindings = (graph?.scopes[node.id] ?? []) as ScopeBinding[];
  const groups = useMemo(() => groupScope(bindings), [bindings]);

  return (
    <section className="cf-scroll flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <PaneTitle icon={<Database className="size-3.5" />} title="Available here">
        Values earlier steps produced. Drag one onto a setting in the middle.
      </PaneTitle>

      {groups.values.length === 0 ? (
        <p className="m-0 text-[12px] leading-relaxed text-ink-dim">
          Nothing is in scope at this step yet — it is the first thing the flow does, or the steps before it produce
          nothing this one can see.
        </p>
      ) : null}

      {groups.values.map((binding) => {
        const origin = binding.origins[0];
        const originNode = origin === undefined ? null : index.nodeById.get(origin.nodeId) ?? null;
        // 07 §4: the *name* of the step, never its id.
        const originLabel = originNode?.label ?? null;
        const observed = origin === undefined ? undefined : observedAt(run?.nodes.get(origin.nodeId), itemPath);
        // A loop item carries the array's item schema, derived by the analyzer
        // (`itemSchemaOf` in analyzer/emit.ts) rather than re-derived here: one
        // implementation, so the tree the UI offers and the names the patch
        // engine accepts can never disagree.
        const rows = scopeRows(binding, {
          ...(observed === undefined ? {} : { observed }),
          ...(originLabel === null ? {} : { originLabel }),
        });
        const sampled = rows.some((row) => row.valueSource === "sample");

        return (
          <div key={binding.name} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-[11.5px] font-semibold text-ink">{binding.name}</span>
              {binding.loopItem === true ? <Badge tone="accent">current item</Badge> : null}
              {binding.parameter === true ? <Badge>flow input</Badge> : null}
              {/*
                Said once per group rather than once per row: repeating it on
                every line crowded the value out of a 17rem column, and the
                rows carry the label in their own styling (muted italic) and in
                their tooltip regardless.
              */}
              {sampled ? (
                <Badge title="Made up from the declared shape — no run produced these">sample data</Badge>
              ) : null}
              {binding.origins.length > 1 ? (
                <span className="text-[10.5px] text-ink-faint">written by {binding.origins.length} steps</span>
              ) : originLabel === null ? null : (
                <span className="truncate text-[10.5px] text-ink-faint">from {originLabel}</span>
              )}
            </div>
            <ul className="m-0 flex list-none flex-col gap-px p-0">
              {rows.map((row) => (
                <ScopeRowItem
                  key={row.path}
                  row={row}
                  active={dragging?.path === row.path}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onUse={onUse}
                />
              ))}
            </ul>
          </div>
        );
      })}

      {groups.other.length === 0 ? null : (
        <details className="group mt-1" data-testid="scope-other">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-ink-faint outline-none hover:text-ink">
            Also in scope ({groups.other.length})
          </summary>
          {/*
            Imports, `tools` and local functions are in scope and are not
            values, so they are not dragged onto a setting. Dropping them from
            the list entirely would make this pane disagree with the analyzer —
            so they are here, one click away, rather than gone.
          */}
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
            {groups.other.map((binding) => (
              <li key={binding.name} className="flex items-baseline gap-2 text-[11px]">
                <code className="font-mono text-ink-dim">{binding.name}</code>
                <span className="text-ink-faint">{binding.kind.replace(/-/g, " ")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ScopeRowItem({
  row,
  active,
  onDragStart,
  onDragEnd,
  onUse,
}: {
  row: ScopeRow;
  active: boolean;
  onDragStart: (row: ScopeRow) => void;
  onDragEnd: () => void;
  onUse: (row: ScopeRow) => void;
}): ReactNode {
  const value = rowValueText(row);
  return (
    <li>
      <div
        draggable
        role="button"
        tabIndex={0}
        data-testid={`scope-row-${row.path}`}
        data-value-source={row.valueSource}
        title={`Insert ${row.path}`}
        onDragStart={(event) => {
          // `text/plain` carries the expression itself, so a drop onto any text
          // field — including one outside this dialog — inserts something true.
          event.dataTransfer.setData("text/plain", row.path);
          event.dataTransfer.effectAllowed = "copy";
          onDragStart(row);
        }}
        onDragEnd={onDragEnd}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onUse(row);
          }
        }}
        onDoubleClick={() => { onUse(row); }}
        className={cn(
          "group flex cursor-grab items-baseline gap-2 rounded-md px-1.5 py-1 outline-none",
          "hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/70",
          active && "bg-accent-soft",
        )}
        style={{ paddingLeft: `${String(6 + row.depth * 12)}px` }}
      >
        <span className="shrink-0 font-mono text-[11px] text-ink">{row.label}</span>
        {row.typeText === undefined ? null : (
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">{row.typeText}</span>
        )}
        {value === null ? null : (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[10.5px]",
              // A sample must never read like an observation: dimmer, italic,
              // and it says so on hover as well as on its group's badge.
              row.valueSource === "observed" ? "text-ink-dim" : "italic text-ink-faint",
            )}
            title={
              row.valueSource === "sample"
                ? `Sample data — made up from the declared shape, not from a run: ${value}`
                : value
            }
          >
            {value}
            {row.note === undefined ? null : <span className="ml-1 text-ink-faint">({row.note})</span>}
          </span>
        )}
        <button
          type="button"
          aria-label={`Insert ${row.path}`}
          className="ml-auto hidden shrink-0 rounded px-1 text-[10px] text-accent group-hover:inline-flex"
          onClick={() => { onUse(row); }}
        >
          <CornerDownLeft className="size-3" />
        </button>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* middle — one field, which is also a drop target                             */
/* -------------------------------------------------------------------------- */

function DropField({
  field,
  kind,
  text,
  checked,
  note,
  disabled,
  armed,
  onDrop,
  onFocus,
  onText,
  onChecked,
}: {
  field: InspectorField;
  kind: FieldEditorKind;
  text: string;
  checked: boolean;
  note: string | null;
  disabled: boolean;
  /** True while something is being dragged and this field could take it. */
  armed: boolean;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onFocus: (caret: number) => void;
  onText: (value: string, caret: number) => void;
  onChecked: (value: boolean) => void;
}): ReactNode {
  const blocked = field.patch === null || field.blockedReason !== null;
  const id = `cf-editor-${field.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const mono = kind === "expression" || kind === "code" || kind === "template";

  return (
    <div
      data-testid={`editor-field-${field.name}`}
      data-drop-armed={armed && !blocked ? "true" : "false"}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border border-transparent p-2 transition-colors",
        armed && !blocked && "border-dashed border-accent/60 bg-accent-soft/40",
      )}
      onDragOver={(event: DragEvent<HTMLElement>) => {
        if (blocked || disabled) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={blocked || disabled ? undefined : onDrop}
    >
      <FieldLabel className="cf-field__label" htmlFor={id}>
        {humanFieldLabel(field.label)}
        {field.missing ? <Badge tone="warn">needs a value</Badge> : null}
        {typeof field.schema === "string" ? (
          <span className="font-mono text-[10.5px] font-normal text-ink-faint">{field.schema}</span>
        ) : null}
        {kind === "template" ? <Badge tone="accent">fills in a value</Badge> : null}
      </FieldLabel>

      {kind === "checkbox" ? (
        <label className="inline-flex cursor-pointer select-none items-center gap-2 text-[12.5px] text-ink-dim">
          <input
            type="checkbox"
            id={id}
            name={field.name}
            data-field={field.name}
            className="size-4 cursor-pointer accent-[color:var(--cf-accent)]"
            disabled={disabled || blocked}
            checked={checked}
            onChange={(event) => { onChecked(event.target.checked); }}
          />
          {checked ? "Yes" : "No"}
        </label>
      ) : kind === "code" ? (
        <Textarea
          mono
          id={id}
          name={field.name}
          data-field={field.name}
          disabled={disabled || blocked}
          value={text}
          rows={Math.min(8, text.split("\n").length + 1)}
          onSelect={(event) => { onFocus(event.currentTarget.selectionStart ?? text.length); }}
          onChange={(event) => { onText(event.target.value, event.target.selectionStart ?? event.target.value.length); }}
        />
      ) : (
        <Input
          mono={mono}
          id={id}
          name={field.name}
          data-field={field.name}
          disabled={disabled || blocked}
          type={kind === "number" ? "number" : "text"}
          value={text}
          placeholder={field.missing ? "Not set yet — drop a value here" : ""}
          onSelect={(event) => { onFocus(event.currentTarget.selectionStart ?? text.length); }}
          onChange={(event) => { onText(event.target.value, event.target.selectionStart ?? event.target.value.length); }}
        />
      )}

      {field.blockedReason === null ? null : (
        <FieldHint tone="warn">{splitSpecRefs(field.blockedReason).text}</FieldHint>
      )}
      {note === null ? null : <FieldHint>{splitSpecRefs(note).text}</FieldHint>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* right — result                                                              */
/* -------------------------------------------------------------------------- */

function ResultPane({
  node,
  items,
  item,
  onSelectItem,
}: {
  node: WorkflowNode;
  items: readonly ResultItem[];
  item: ResultItem | null;
  onSelectItem: (index: number) => void;
}): ReactNode {
  const { run, registry } = useCodeFlow();
  const state = run?.nodes.get(node.id);
  const trace = traceNotice(run?.match ?? "unknown");
  const declared = declaredOutput(node, registry);
  const sample = sampleForSchema(declared.schema);
  const origin = item === null ? null : previewOrigin(state?.preview);

  return (
    <section className="cf-scroll flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <PaneTitle icon={<Play className="size-3.5" />} title="Result">
        What this step produced.
      </PaneTitle>

      {run === null ? (
        <>
          <Notice tone="muted" title="This step has not run" data-testid="result-declared">
            Nothing has been observed here. What follows is the shape the step <em>says</em> it produces, not a value
            it produced.
          </Notice>
          <DeclaredShape name={declared.name} typeText={declared.typeText} />
          {sample === undefined ? null : (
            <div className="flex flex-col gap-1" data-testid="result-sample">
              <span className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-faint">
                Sample data — made up from that shape
              </span>
              <PreviewValue value={sample.value} kind={null} nodeId={node.id} compact {...(declared.schema === undefined ? {} : { schema: declared.schema })} />
            </div>
          )}
        </>
      ) : (
        <>
          {/*
            A run's values are only "what this flow does now" when the trace
            belongs to this graph. `stale` says so; `unknown` says nothing was
            established either way — and neither may be rendered as current.
          */}
          <Notice
            tone={trace.tone === "ok" ? "ok" : trace.tone === "warn" ? "warn" : "muted"}
            title={trace.title}
            data-testid={`result-trace-${trace.current ? "current" : "uncertain"}`}
          >
            {trace.text}
          </Notice>

          {items.length === 0 ? (
            <p className="m-0 text-[12px] leading-relaxed text-ink-dim">
              {run.untraced.has(node.id)
                ? "This step could not be traced without changing what the code does, so the run says nothing about it."
                : run.status === "running"
                  ? "Not reached yet."
                  : "This step was never reached."}
            </p>
          ) : (
            <>
              {items.length > 1 ? (
                <label className="flex items-center gap-2 text-[11.5px] text-ink-dim">
                  <Layers className="size-3.5 shrink-0" />
                  <select
                    className="min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 py-1 text-[11.5px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                    data-testid="result-items"
                    value={items.indexOf(item ?? items[items.length - 1])}
                    onChange={(event) => { onSelectItem(Number(event.target.value)); }}
                  >
                    {items.map((entry, index) => (
                      <option key={entry.key} value={index}>
                        {entry.label}
                        {entry.durationMs === undefined ? "" : ` · ${String(entry.durationMs)}ms`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : item === null ? null : (
                /*
                 * One entry, and its label may well be "latest" — which is not
                 * a euphemism for "item 1". A runtime that cannot count passes
                 * sends no iteration, and inventing a number here would state
                 * something the run never said (07 §5).
                 */
                <span className="text-[11px] text-ink-faint" data-testid="result-single-item">
                  {item.label}
                  {item.durationMs === undefined ? "" : ` · ${String(item.durationMs)}ms`}
                </span>
              )}

              {origin?.tool === undefined ? null : (
                <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                  <code className="font-mono">{origin.tool}</code>
                  <Badge tone={origin.source === "mcp" ? "ok" : "warn"}>
                    {origin.source === "mcp" ? "live MCP" : "sample data"}
                  </Badge>
                </span>
              )}

              {item === null || !item.hasValue ? (
                <p className="m-0 text-[12px] text-ink-dim">This pass reported no value.</p>
              ) : (
                <PreviewValue
                  value={item.value}
                  kind={null}
                  nodeId={node.id}
                  {...(declared.schema === undefined ? {} : { schema: declared.schema })}
                />
              )}
            </>
          )}

          {state?.error === undefined ? null : (
            <Notice tone="danger" title="This step threw">
              {state.error.message}
            </Notice>
          )}

          <EmitList nodeId={node.id} emits={state?.emits ?? []} />
        </>
      )}
    </section>
  );
}

function DeclaredShape({ name, typeText }: { name: string | null; typeText: string | null }): ReactNode {
  if (name === null && typeText === null) {
    return (
      <p className="m-0 text-[12px] leading-relaxed text-ink-dim">
        Nothing declares what this step produces, so its output shape is unknown.
      </p>
    );
  }
  return (
    <dl className="m-0 flex flex-col gap-1.5 text-[11.5px]">
      {name === null ? null : (
        <div className="flex items-baseline gap-3">
          <dt className="w-16 shrink-0 text-ink-faint">Gives</dt>
          <dd className="m-0 min-w-0 flex-1 font-mono text-ink">{name}</dd>
        </div>
      )}
      <div className="flex items-baseline gap-3">
        <dt className="w-16 shrink-0 text-ink-faint">Declared</dt>
        <dd className="m-0 min-w-0 flex-1 font-mono text-ink-dim">{typeText ?? "unknown"}</dd>
      </div>
    </dl>
  );
}

/**
 * What a node said *during* a step — through the renderer seam.
 *
 * An emit is not a lifecycle transition (a log line is not a step finishing),
 * so it is listed on its own and never touches the status shown above it.
 */
function EmitList({ nodeId, emits }: { nodeId: string; emits: readonly { kind: string; payload: unknown; at: number }[] }): ReactNode {
  if (emits.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="result-emits">
      <h4 className="m-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
        Sent while running ({emits.length})
      </h4>
      {emits.map((emit, index) => (
        <div key={`${String(emit.at)}:${String(index)}`} className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[10.5px] text-ink-faint">
            <Info className="size-3" />
            {emit.kind}
          </span>
          <PreviewValue value={emit.payload} kind={emit.kind} nodeId={nodeId} compact />
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function PaneTitle({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="m-0 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
        {icon}
        {title}
      </h3>
      <p className="m-0 text-[11.5px] leading-snug text-ink-dim">{children}</p>
    </div>
  );
}
