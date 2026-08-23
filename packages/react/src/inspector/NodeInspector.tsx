/**
 * `<NodeInspector>` — the power-user level of progressive disclosure (07 §4),
 * and the place edits are made (07 §5).
 *
 * Three rules from the specs shape every control here:
 *
 * - an edit is applied **relative to the form the value has** (06 §3), so the
 *   control a field gets follows its current AST form, and `{{ }}` typed into a
 *   plain string is refused with an explicit "make it a template" instead of
 *   being silently promoted;
 * - an unsupported operation is **said out loud** (07 §5) — fields the patch
 *   engine has no edit for render disabled with the reason next to them, never
 *   as a control that quietly does nothing;
 * - a refusal from the patch engine is **state, not a toast**: `patch-*` errors
 *   stay on screen with their code until the user acts on them.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { WorkflowNode } from "@codeflow/core";
import { useCodeFlow } from "../context/hooks.js";
import { nodeIcon, nodeKindLabel } from "../flow/summary.js";
import { CodeDiff } from "../diff/CodeDiff.js";
import { CodeDialog } from "../code/CodeDialog.js";
import { localFunctionBody, nodeRegionText } from "../code/region.js";
import { useDebounced } from "../util/use-debounced.js";
import { resolveInspectorFields, type InspectorField } from "./fields.js";
import {
  IMPLICIT_TEMPLATE_REFUSAL,
  changesFor,
  editorSpecFor,
  encodeAsTemplate,
  encodeFieldValue,
  hasInterpolation,
  mergeChanges,
  type FieldEditorSpec,
} from "./edit.js";

export interface NodeInspectorProps {
  /** Defaults to the provider's current selection. */
  nodeId?: string | null;
  className?: string;
  theme?: "light" | "dark";
}

interface DraftState {
  text: Record<string, string>;
  checked: Record<string, boolean>;
  /** Fields the user explicitly promoted from string literal to template (06 §3). */
  template: Record<string, boolean>;
}

const EMPTY_DRAFT: DraftState = { text: {}, checked: {}, template: {} };

/**
 * DOM id for one form control of this inspector.
 *
 * Every control gets an `id` **and** a `name`, and its visible label points at
 * it with `htmlFor`. Wrapping a control in a `<label>` associates the two
 * implicitly, but it leaves the control itself anonymous — which is what the
 * browser reports as "a form field element should have an id or name
 * attribute", and what costs assistive tech the explicit relationship, autofill
 * a key, and tests an addressable handle. Ids are scoped by node id so two
 * inspectors on one page never collide, and the name is sanitised because a
 * field name comes from a tool's schema, not from us.
 */
function controlId(nodeId: string, name: string): string {
  return `cf-${nodeId}-${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function NodeInspector(props: NodeInspectorProps): ReactNode {
  const {
    graph,
    index,
    registry,
    selectedNodeId,
    nodeDiagnostics,
    focusRange,
    editingEnabled,
    editingDisabledReason,
    sourceDirty,
    patchNode,
    previewPatch,
    patchError,
    clearPatchError,
    lastPatch,
    changedNodeIds,
    requestReanalyze,
    canReanalyze,
  } = useCodeFlow();

  const nodeId = props.nodeId === undefined ? selectedNodeId : props.nodeId;
  const node = nodeId === null ? null : index.nodeById.get(nodeId) ?? null;

  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toolTarget, setToolTarget] = useState<string | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);

  // A patch (or a new selection) replaces the values the drafts were relative
  // to, so the drafts go with it.
  const version = graph?.version ?? 0;
  useEffect(() => {
    setDraft(EMPTY_DRAFT);
    setLocalError(null);
    setConfirmDelete(false);
    setToolTarget(null);
    setCodeOpen(false);
  }, [nodeId, version]);

  const model = useMemo(() => (node === null ? null : resolveInspectorFields(node, registry)), [node, registry]);

  const specs = useMemo(() => {
    const out = new Map<string, FieldEditorSpec>();
    for (const field of model?.fields ?? []) out.set(field.name, editorSpecFor(field));
    return out;
  }, [model]);

  const editableFields = useMemo(
    () => (model?.fields ?? []).filter((field) => field.patch !== null && field.blockedReason === null),
    [model],
  );

  const dirty = useMemo(
    () =>
      editableFields.filter((field) => {
        const spec = specs.get(field.name);
        if (spec === undefined) return false;
        if (spec.kind === "checkbox") return (draft.checked[field.name] ?? spec.checked) !== spec.checked;
        return (draft.text[field.name] ?? spec.value) !== spec.value;
      }),
    [editableFields, specs, draft],
  );

  /** `changes` for every dirty field, or the reason the UI refuses to build it. */
  const build = useCallback((): { ok: true; changes: Record<string, unknown> } | { ok: false; message: string } => {
    const exclusive = dirty.filter((field) => field.patch !== "field");
    if (exclusive.length > 0 && dirty.length > 1) {
      return {
        ok: false,
        message: `"${exclusive[0].label}" rewrites its whole construct and cannot be applied together with other fields — apply it on its own (06 §2).`,
      };
    }

    const parts: Record<string, unknown>[] = [];
    for (const field of dirty) {
      const spec = specs.get(field.name);
      if (spec === undefined) continue;
      const text = draft.text[field.name] ?? spec.value;
      const checked = draft.checked[field.name] ?? spec.checked;

      if (spec.kind === "text" && hasInterpolation(text)) {
        if (draft.template[field.name] !== true) return { ok: false, message: IMPLICIT_TEMPLATE_REFUSAL };
        parts.push(changesFor(field, encodeAsTemplate(text)));
        continue;
      }

      const encoded = encodeFieldValue(spec.kind, text, checked);
      if (!encoded.ok) return { ok: false, message: encoded.message };
      parts.push(changesFor(field, encoded.value));
    }
    return { ok: true, changes: mergeChanges(parts) };
  }, [dirty, specs, draft]);

  const apply = useCallback(async () => {
    if (node === null) return;
    const built = build();
    if (!built.ok) {
      setLocalError(built.message);
      return;
    }
    setLocalError(null);
    setBusy(true);
    await patchNode(node.id, built.changes);
    setBusy(false);
  }, [node, build, patchNode]);

  /* --- preview ----------------------------------------------------------- */

  const debouncedDraft = useDebounced(draft, 200);
  const previewResult = useMemo(() => {
    if (!preview || node === null || dirty.length === 0) return null;
    void debouncedDraft; // recompute once typing settles
    const built = build();
    if (!built.ok) return { ok: false as const, code: "unknown" as const, message: built.message };
    return previewPatch(node.id, built.changes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, node, dirty.length, debouncedDraft, previewPatch]);

  if (node === null || model === null) {
    return (
      <aside className={`cf-inspector ${props.className ?? ""}`}>
        <p className="cf-empty">Select a node to inspect it.</p>
      </aside>
    );
  }

  const diagnostics = nodeDiagnostics.get(node.id) ?? [];
  const error = patchError !== null && patchError.nodeId === node.id ? patchError : null;
  const success = lastPatch !== null && lastPatch.nodeIds.includes(node.id) ? lastPatch : null;
  const changed = changedNodeIds.has(node.id);

  const codeEditText =
    model.codeEdit === null || graph === null
      ? null
      : model.codeEdit.kind === "region"
        ? nodeRegionText(graph, node)
        : localFunctionBody(graph.source.content, model.codeEdit.functionName);

  const runPatch = async (changes: Record<string, unknown>, after?: () => void): Promise<void> => {
    setLocalError(null);
    setBusy(true);
    const outcome = await patchNode(node.id, changes);
    setBusy(false);
    if (outcome.ok) after?.();
  };

  return (
    <aside className={`cf-inspector ${props.className ?? ""}`} data-node-id={node.id}>
      <header className="cf-inspector__header">
        <span className="cf-inspector__icon" aria-hidden="true">
          {nodeIcon(node)}
        </span>
        <div>
          <h2 className="cf-inspector__title">
            {node.label}
            {changed ? (
              <span className="cf-tag cf-tag--changed" title="Updated by the last patch">
                updated
              </span>
            ) : null}
          </h2>
          <p className="cf-inspector__kind">{nodeKindLabel(node)}</p>
        </div>
      </header>

      <button type="button" className="cf-link" onClick={() => { focusRange(node.source); }}>
        {`${node.source.file}:${String(node.source.start.line)}:${String(node.source.start.column)}`}
      </button>

      {diagnostics.length > 0 ? (
        <ul className="cf-inspector__diagnostics">
          {diagnostics.map((diagnostic, i) => (
            <li key={i} className={`cf-diagnostic cf-diagnostic--${diagnostic.severity}`}>
              <code>{diagnostic.code}</code> {diagnostic.message}
            </li>
          ))}
        </ul>
      ) : null}

      {model.notice !== null ? <p className="cf-notice">{model.notice}</p> : null}

      {!editingEnabled ? (
        <p className="cf-notice cf-notice--pending" data-testid="editing-disabled">
          Read-only — {editingDisabledReason}
        </p>
      ) : null}

      {editingEnabled && sourceDirty ? (
        <p className="cf-notice cf-notice--stale" data-testid="source-dirty">
          The editor holds source this graph was not built from. An edit is still checked against the file first and
          refused if this node moved (06 §5).
          {canReanalyze ? (
            <button type="button" className="cf-button cf-button--small" onClick={requestReanalyze}>
              Re-analyze
            </button>
          ) : null}
        </p>
      ) : null}

      {error !== null ? (
        <div className={`cf-alert cf-alert--error`} data-testid="patch-error" role="alert">
          <div className="cf-alert__head">
            <code>{error.code}</code>
            <button type="button" className="cf-icon-button" onClick={clearPatchError} aria-label="Dismiss">
              ×
            </button>
          </div>
          <p className="cf-alert__message">{error.message}</p>
          {error.code === "patch-conflict" && canReanalyze ? (
            <button type="button" className="cf-button cf-button--small" onClick={requestReanalyze}>
              Re-analyze the flow
            </button>
          ) : null}
        </div>
      ) : null}

      {localError !== null ? (
        <div className="cf-alert cf-alert--warning" data-testid="edit-error" role="alert">
          <p className="cf-alert__message">{localError}</p>
        </div>
      ) : null}

      {success !== null && error === null ? (
        <div className="cf-alert cf-alert--ok" data-testid="patch-applied">
          <p className="cf-alert__message">
            Applied — {success.patches.length} source range{success.patches.length === 1 ? "" : "s"} changed.
          </p>
          {success.diagnostics.length > 0 ? (
            <ul className="cf-alert__list">
              {success.diagnostics.map((diagnostic, i) => (
                <li key={i}>
                  <code>{diagnostic.code}</code> {diagnostic.message}
                </li>
              ))}
            </ul>
          ) : null}
          <CodeDiff patches={success.patches} />
        </div>
      ) : null}

      {model.fields.length > 0 ? (
        <div className="cf-fields">
          {model.fields.map((field) => {
            const spec = specs.get(field.name);
            if (spec === undefined) return null;
            return (
              <FieldRow
                key={field.name}
                nodeId={node.id}
                field={field}
                spec={spec}
                text={draft.text[field.name] ?? spec.value}
                checked={draft.checked[field.name] ?? spec.checked}
                template={draft.template[field.name] === true}
                disabled={!editingEnabled || busy}
                disabledReason={editingEnabled ? null : editingDisabledReason}
                onText={(value) => {
                  setDraft((current) => ({ ...current, text: { ...current.text, [field.name]: value } }));
                }}
                onChecked={(value) => {
                  setDraft((current) => ({ ...current, checked: { ...current.checked, [field.name]: value } }));
                }}
                onTemplate={(value) => {
                  setDraft((current) => ({ ...current, template: { ...current.template, [field.name]: value } }));
                }}
              />
            );
          })}
        </div>
      ) : null}

      {editableFields.length > 0 ? (
        <div className="cf-actions">
          <button
            type="button"
            className="cf-button cf-button--primary"
            disabled={!editingEnabled || busy || dirty.length === 0}
            title={dirty.length === 0 ? "Nothing changed yet" : undefined}
            data-testid="apply"
            onClick={() => { void apply(); }}
          >
            {busy ? "Applying…" : `Apply${dirty.length > 1 ? ` (${String(dirty.length)})` : ""}`}
          </button>
          <button
            type="button"
            className="cf-button"
            disabled={dirty.length === 0}
            onClick={() => { setDraft(EMPTY_DRAFT); setLocalError(null); }}
          >
            Revert
          </button>
          <label className="cf-checkbox" htmlFor={controlId(node.id, "preview")}>
            <input
              type="checkbox"
              id={controlId(node.id, "preview")}
              name="preview"
              checked={preview}
              onChange={(event) => { setPreview(event.target.checked); }}
            />
            Preview diff
          </label>
        </div>
      ) : null}

      {preview && previewResult !== null ? (
        <section className="cf-preview" data-testid="preview">
          <h3 className="cf-preview__title">Preview — not applied yet</h3>
          {previewResult.ok ? (
            <>
              <CodeDiff patches={previewResult.patches} />
              {previewResult.diagnostics.length > 0 ? (
                <ul className="cf-alert__list">
                  {previewResult.diagnostics.map((diagnostic, i) => (
                    <li key={i}>
                      <code>{diagnostic.code}</code> {diagnostic.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="cf-alert cf-alert--warning cf-alert__message">{previewResult.message}</p>
          )}
        </section>
      ) : null}

      {model.toolChange !== null && registry !== null ? (
        <section className="cf-section" data-testid="tool-change">
          <label className="cf-section__title" htmlFor={controlId(node.id, "tool")}>
            Tool
          </label>
          <select
            className="cf-select"
            id={controlId(node.id, "tool")}
            name="tool"
            value={toolTarget ?? model.toolChange.current}
            disabled={!editingEnabled || busy}
            onChange={(event) => { setToolTarget(event.target.value); }}
          >
            {registry.getTool(model.toolChange.current) === undefined ? (
              <option value={model.toolChange.current}>{model.toolChange.current} (not in registry)</option>
            ) : null}
            {registry.listTools().map((tool) => (
              <option key={tool.name} value={tool.name}>
                {tool.icon === undefined ? "" : `${tool.icon} `}
                {tool.label} — {tool.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="cf-button"
            disabled={!editingEnabled || busy || toolTarget === null || toolTarget === model.toolChange.current}
            data-testid="change-tool"
            onClick={() => { void runPatch({ $tool: toolTarget }); }}
          >
            Change tool
          </button>
          <p className="cf-field__hint">
            Incompatible fields are not reinterpreted: they are dropped and the node comes back as
            “replace &amp; reconfigure” with a warning (06 §2).
          </p>
        </section>
      ) : null}

      {model.codeEdit !== null ? (
        <section className="cf-section" data-testid="code-edit">
          <h3 className="cf-section__title">Code</h3>
          {codeEditText === null ? (
            <p className="cf-notice">
              This node&apos;s code region could not be located in the current source — edit it in the code panel
              (06 §2).
            </p>
          ) : (
            <button
              type="button"
              className="cf-button"
              disabled={!editingEnabled || busy}
              data-testid="edit-code"
              onClick={() => { setCodeOpen(true); }}
            >
              {model.codeEdit.label}
            </button>
          )}
        </section>
      ) : null}

      {model.code !== null ? (
        <pre className="cf-inspector__code">
          <code>{model.code}</code>
        </pre>
      ) : null}

      <section className="cf-section">
        <h3 className="cf-section__title">Node</h3>
        {node.capabilities.deletable ? (
          confirmDelete ? (
            <>
              <button
                type="button"
                className="cf-button cf-button--danger"
                disabled={!editingEnabled || busy}
                data-testid="confirm-delete"
                onClick={() => { void runPatch({ $delete: true }, () => { setConfirmDelete(false); }); }}
              >
                Confirm delete
              </button>
              <button type="button" className="cf-button" onClick={() => { setConfirmDelete(false); }}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="cf-button cf-button--danger"
              disabled={!editingEnabled || busy}
              data-testid="delete-node"
              onClick={() => { setConfirmDelete(true); clearPatchError(); }}
            >
              Delete node
            </button>
          )
        ) : (
          <p className="cf-field__hint">
            This node is synthetic — it has no statement of its own to delete (03 §4).
          </p>
        )}
      </section>

      <PortList title="Inputs" node={node} which="inputs" />
      <PortList title="Outputs" node={node} which="outputs" />

      <details className="cf-inspector__raw">
        <summary>Node data</summary>
        <pre>
          <code>
            {JSON.stringify({ id: node.id, type: node.type, capabilities: node.capabilities, data: node.data }, null, 2)}
          </code>
        </pre>
      </details>

      {codeOpen && codeEditText !== null && model.codeEdit !== null ? (
        <CodeDialog
          title={`${model.codeEdit.label} — ${node.label}`}
          hint="The whole region is replaced in one patch: an opaque region has no smaller edit (06 §2)."
          initialValue={codeEditText}
          busy={busy}
          error={error === null ? null : error.message}
          {...(props.theme === undefined ? {} : { theme: props.theme })}
          onCancel={() => { setCodeOpen(false); }}
          onSave={(value) => { void runPatch({ $code: value }, () => { setCodeOpen(false); }); }}
        />
      ) : null}
    </aside>
  );
}

interface FieldRowProps {
  /** Owning node — scopes the control ids so two inspectors never collide. */
  nodeId: string;
  field: InspectorField;
  spec: FieldEditorSpec;
  text: string;
  checked: boolean;
  template: boolean;
  disabled: boolean;
  disabledReason: string | null;
  onText: (value: string) => void;
  onChecked: (value: boolean) => void;
  onTemplate: (value: boolean) => void;
}

function FieldRow(props: FieldRowProps): ReactNode {
  const { field, spec } = props;
  const blocked = field.patch === null || field.blockedReason !== null;
  const reason = field.blockedReason ?? props.disabledReason;
  const disabled = blocked || props.disabled;
  const placeholder = field.missing ? "not set — needs configuration" : "";
  const wantsTemplate = spec.kind === "text" && hasInterpolation(props.text);

  const inputClass = `cf-input${spec.kind === "expression" || spec.kind === "code" ? " cf-input--code" : ""}`;
  const title = reason ?? undefined;
  const id = controlId(props.nodeId, `field-${field.name}`);

  return (
    <div className={`cf-field${field.display.friendly ? "" : " cf-field--code"}`}>
      <label className="cf-field__label" htmlFor={id}>
        {field.label}
        {field.schema !== undefined && typeof field.schema === "string" ? (
          <span className="cf-field__schema">{field.schema}</span>
        ) : null}
        {!field.declaredEditable ? <span className="cf-field__tag">not declared editable</span> : null}
        {!field.display.friendly ? <span className="cf-field__tag">code mode</span> : null}
        {field.patch !== null && field.patch !== "field" ? <span className="cf-field__tag">{field.patch}</span> : null}
      </label>

      {spec.kind === "checkbox" ? (
        <input
          type="checkbox"
          className="cf-checkbox__box"
          id={id}
          name={field.name}
          data-field={field.name}
          disabled={disabled}
          title={title}
          checked={props.checked}
          onChange={(event) => { props.onChecked(event.target.checked); }}
        />
      ) : spec.kind === "code" ? (
        <textarea
          className={inputClass}
          id={id}
          name={field.name}
          data-field={field.name}
          disabled={disabled}
          title={title}
          value={props.text}
          placeholder={placeholder}
          rows={Math.min(8, props.text.split("\n").length + 1)}
          onChange={(event) => { props.onText(event.target.value); }}
        />
      ) : (
        <input
          className={inputClass}
          id={id}
          name={field.name}
          data-field={field.name}
          disabled={disabled}
          title={title}
          type={spec.kind === "number" ? "number" : "text"}
          value={props.text}
          placeholder={placeholder}
          onChange={(event) => { props.onText(event.target.value); }}
        />
      )}

      {wantsTemplate ? (
        <span className="cf-field__convert" data-testid={`convert-${field.name}`}>
          {props.template ? (
            <>
              Will be written as a template literal.{" "}
              <button type="button" className="cf-link" onClick={() => { props.onTemplate(false); }}>
                keep it a plain string
              </button>
            </>
          ) : (
            <>
              {IMPLICIT_TEMPLATE_REFUSAL}{" "}
              <button type="button" className="cf-link" onClick={() => { props.onTemplate(true); }}>
                Make it a template
              </button>
            </>
          )}
        </span>
      ) : null}

      {field.blockedReason !== null ? <span className="cf-field__hint">{field.blockedReason}</span> : null}
      {field.blockedReason === null && spec.hint !== null ? (
        <span className="cf-field__hint">{spec.hint}</span>
      ) : null}
    </div>
  );
}

function PortList({ title, node, which }: { title: string; node: WorkflowNode; which: "inputs" | "outputs" }): ReactNode {
  const ports = node[which];
  if (ports.length === 0) return null;
  return (
    <section className="cf-ports">
      <h3 className="cf-ports__title">{title}</h3>
      <ul>
        {ports.map((port) => (
          <li key={port.id}>
            <code>{port.label}</code>
            {typeof port.schema === "string" ? <span className="cf-ports__schema">{port.schema}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
