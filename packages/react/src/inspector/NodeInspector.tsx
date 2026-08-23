/**
 * `<NodeInspector>` — the power-user level of progressive disclosure (07 §4),
 * and the place edits are made (07 §5).
 *
 * It is written as a product form, not a debug panel: a step has a name, its
 * settings have labels and helper text, and "Apply" is the one primary action on
 * screen. What is machine-facing — the qualified tool name, the source range,
 * the raw node record — is folded into the levels that ask for it.
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
import {
  ArrowRightLeft,
  ChevronRight,
  Code,
  MousePointerClick,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import type { WorkflowNode } from "@codeflow/core";
import { useCodeFlow } from "../context/hooks.js";
import { nodeCaption } from "../flow/summary.js";
import { NodeGlyph, nodeVisual } from "../flow/visual.js";
import { diagnosticHeadline, errorHeadline, splitSpecRefs } from "../copy.js";
import { cn } from "../ui/cn.js";
import { Button } from "../ui/button.js";
import { Badge } from "../ui/badge.js";
import { Field, FieldHint, FieldLabel, Input, Textarea } from "../ui/input.js";
import { Notice } from "../ui/notice.js";
import { Select } from "../ui/select.js";
import { Hint } from "../ui/tooltip.js";
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
  /** Renders a close affordance — set when the panel is shown as an overlay. */
  onClose?: () => void;
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

/** A titled block in the panel body. */
function Section({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  testId?: string;
}): ReactNode {
  return (
    <section className="flex flex-col gap-3 border-t border-line px-4 py-4" data-testid={testId}>
      <div>
        <h3 className="m-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">{title}</h3>
        {description === undefined ? null : (
          <p className="m-0 mt-1 text-[11.5px] leading-snug text-ink-dim">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

export function NodeInspector(props: NodeInspectorProps): ReactNode {
  const {
    graph,
    index,
    registry,
    selectedNodeId,
    nodeDiagnostics,
    focusRange,
    mode,
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
    /**
     * Nothing selected is still a state worth filling: it answers "what am I
     * looking at?" with what the flow starts from and how big it is, so the
     * panel is never a blank column waiting to be earned.
     */
    const trigger = graph?.nodes.find((candidate) => candidate.type === "trigger") ?? null;
    const steps = graph?.nodes.filter((candidate) => candidate.type !== "trigger" && candidate.type !== "output").length ?? 0;
    const problems = graph?.diagnostics.filter((diagnostic) => diagnostic.severity !== "info").length ?? 0;

    return (
      <aside className={cn("flex h-full flex-col bg-surface font-sans", props.className)}>
        {graph === null ? null : (
          <div className="flex flex-col gap-3 border-b border-line px-4 pb-4 pt-4">
            <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">This flow</h2>
            <dl className="m-0 flex flex-col gap-2.5">
              <div className="flex items-baseline gap-3">
                <dt className="w-20 shrink-0 text-[12px] text-ink-faint">Starts with</dt>
                <dd className="m-0 min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
                  {trigger?.label ?? "—"}
                </dd>
              </div>
              <div className="flex items-baseline gap-3">
                <dt className="w-20 shrink-0 text-[12px] text-ink-faint">Steps</dt>
                <dd className="m-0 text-[12.5px] font-medium text-ink">{steps}</dd>
              </div>
              <div className="flex items-baseline gap-3">
                <dt className="w-20 shrink-0 text-[12px] text-ink-faint">Needs work</dt>
                <dd className="m-0 text-[12.5px] font-medium">
                  {problems === 0 ? (
                    <span className="text-ok">Nothing</span>
                  ) : (
                    <span className="text-warn">{problems} step{problems === 1 ? "" : "s"}</span>
                  )}
                </dd>
              </div>
            </dl>
          </div>
        )}
        <div className="grid flex-1 place-items-center p-8">
          <div className="flex max-w-[15rem] flex-col items-center gap-3 text-center">
            <span className="grid size-11 place-items-center rounded-2xl bg-surface-2 text-ink-faint ring-1 ring-line">
              <MousePointerClick className="size-5" />
            </span>
            <div>
              <p className="m-0 text-[13.5px] font-semibold text-ink">Nothing selected</p>
              <p className="m-0 mt-1 text-[12px] leading-relaxed text-ink-dim">
                Pick a step in the diagram to see what it does and change its settings.
              </p>
            </div>
          </div>
        </div>
      </aside>
    );
  }

  const diagnostics = nodeDiagnostics.get(node.id) ?? [];
  const error = patchError !== null && patchError.nodeId === node.id ? patchError : null;
  const success = lastPatch !== null && lastPatch.nodeIds.includes(node.id) ? lastPatch : null;
  const changed = changedNodeIds.has(node.id);
  const advanced = mode !== "compact";
  const visual = nodeVisual(node);

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

  const noticeSplit = model.notice === null ? null : splitSpecRefs(model.notice);

  return (
    <aside
      className={cn("flex h-full min-h-0 flex-col bg-surface font-sans text-ink", props.className)}
      data-node-id={node.id}
    >
      {/* ---------------------------------------------------------------- */}
      {/* identity                                                          */}
      {/* ---------------------------------------------------------------- */}
      <header className="flex items-start gap-3 px-4 pb-3 pt-4">
        <span className={cn("mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl", visual.chipClass)}>
          <NodeGlyph node={node} className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 flex items-center gap-2 text-[15px] font-semibold leading-tight tracking-[-0.01em]">
            <span className="truncate">{node.label}</span>
            {changed ? (
              <Badge tone="ok" title="Updated by the last change">
                updated
              </Badge>
            ) : null}
          </h2>
          <p className="m-0 mt-1 text-[12px] leading-none text-ink-dim">{nodeCaption(node, "expanded") ?? node.type}</p>
        </div>
        {props.onClose === undefined ? null : (
          <Button variant="ghost" size="icon-sm" aria-label="Close panel" onClick={props.onClose}>
            <X />
          </Button>
        )}
      </header>

      <div className="cf-scroll min-h-0 flex-1 overflow-y-auto pb-4">
        {/* -------------------------------------------------------------- */}
        {/* what the flow says about this step                              */}
        {/* -------------------------------------------------------------- */}
        {diagnostics.length > 0 ||
        noticeSplit !== null ||
        !editingEnabled ||
        sourceDirty ||
        error !== null ||
        localError !== null ||
        success !== null ? (
          <div className="flex flex-col gap-2 px-4 pb-4">
            {diagnostics.map((diagnostic, i) => {
              const split = splitSpecRefs(diagnostic.message);
              return (
                <Notice
                  key={i}
                  tone={diagnostic.severity === "error" ? "danger" : diagnostic.severity === "warning" ? "warn" : "info"}
                  title={diagnosticHeadline(diagnostic.code)}
                  code={diagnostic.code}
                  refs={split.refs}
                >
                  {split.text}
                </Notice>
              );
            })}

            {noticeSplit === null ? null : (
              <Notice tone="muted" refs={noticeSplit.refs}>
                {noticeSplit.text}
              </Notice>
            )}

            {!editingEnabled ? (
              <Notice tone="info" title="Read-only" data-testid="editing-disabled">
                {splitSpecRefs(editingDisabledReason).text}
              </Notice>
            ) : null}

            {editingEnabled && sourceDirty ? (
              <Notice
                tone="warn"
                title="The code has been edited since this diagram was drawn"
                data-testid="source-dirty"
                actions={
                  canReanalyze ? (
                    <Button variant="secondary" size="xs" onClick={requestReanalyze}>
                      Refresh the diagram
                    </Button>
                  ) : undefined
                }
              >
                Your change is still checked against the file first, and refused if this step moved.
              </Notice>
            ) : null}

            {error !== null ? (
              <Notice
                tone="danger"
                role="alert"
                data-testid="patch-error"
                title={errorHeadline(error.code)}
                code={error.code}
                refs={splitSpecRefs(error.message).refs}
                onDismiss={clearPatchError}
                actions={
                  error.code === "patch-conflict" && canReanalyze ? (
                    <Button variant="secondary" size="xs" onClick={requestReanalyze}>
                      Refresh the diagram
                    </Button>
                  ) : undefined
                }
              >
                {splitSpecRefs(error.message).text}
              </Notice>
            ) : null}

            {localError !== null ? (
              <Notice
                tone="warn"
                role="alert"
                data-testid="edit-error"
                refs={splitSpecRefs(localError).refs}
                onDismiss={() => { setLocalError(null); }}
              >
                {splitSpecRefs(localError).text}
              </Notice>
            ) : null}

            {success !== null && error === null ? (
              <Notice
                tone="ok"
                data-testid="patch-applied"
                title={`Saved — ${String(success.patches.length)} place${success.patches.length === 1 ? "" : "s"} in the code changed`}
              >
                {/* The patch's own diagnostics are deliberately not repeated
                    here: they are already on this step, above, as the notices
                    the user has to act on. Saying it twice makes both quieter. */}
                <details className="group">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11.5px] font-medium text-ink-dim outline-none hover:text-ink">
                    <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
                    See what changed
                  </summary>
                  <CodeDiff patches={success.patches} className="mt-2" />
                </details>
              </Notice>
            ) : null}
          </div>
        ) : null}

        {/* -------------------------------------------------------------- */}
        {/* settings                                                        */}
        {/* -------------------------------------------------------------- */}
        {model.fields.length > 0 ? (
          <div className="flex flex-col gap-4 border-t border-line px-4 py-4">
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
                  advanced={advanced}
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

        {preview && previewResult !== null ? (
          <section className="border-t border-line px-4 py-4" data-testid="preview">
            <h3 className="m-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
              Preview — not saved yet
            </h3>
            {previewResult.ok ? (
              <>
                <CodeDiff patches={previewResult.patches} className="mt-2" />
                {previewResult.diagnostics.length > 0 ? (
                  <ul className="m-0 mt-2 list-none space-y-1 p-0 text-[11.5px] text-ink-dim">
                    {previewResult.diagnostics.map((diagnostic, i) => (
                      <li key={i}>{splitSpecRefs(diagnostic.message).text}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <Notice tone="warn" className="mt-2">
                {splitSpecRefs(previewResult.message).text}
              </Notice>
            )}
          </section>
        ) : null}

        {/* -------------------------------------------------------------- */}
        {/* what this step is running (developer level)                      */}
        {/* -------------------------------------------------------------- */}
        {model.code !== null ? (
          <Section title="Code">
            <pre className="cf-scroll m-0 overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-[11.5px] leading-[1.6] text-ink">
              <code>{model.code}</code>
            </pre>
          </Section>
        ) : null}

        {model.codeEdit !== null ? (
          <Section title="Custom code" testId="code-edit">
            {codeEditText === null ? (
              <Notice tone="warn">
                This step&apos;s code could not be found in the file as it is now — open the code view to edit it.
              </Notice>
            ) : (
              <Button
                variant="secondary"
                disabled={!editingEnabled || busy}
                data-testid="edit-code"
                onClick={() => { setCodeOpen(true); }}
              >
                <Code />
                {model.codeEdit.label}
              </Button>
            )}
          </Section>
        ) : null}

        {/* -------------------------------------------------------------- */}
        {/* swap the tool — power user and above                             */}
        {/* -------------------------------------------------------------- */}
        {advanced && model.toolChange !== null && registry !== null ? (
          <Section
            title="Which action"
            description={
              toolTarget === null || toolTarget === model.toolChange.current
                ? undefined
                : "Settings the new action does not have are dropped rather than guessed at, and the step comes back asking to be set up."
            }
            testId="tool-change"
          >
            <Field>
              <FieldLabel htmlFor={controlId(node.id, "tool")}>Action</FieldLabel>
              <Select
                id={controlId(node.id, "tool")}
                name="tool"
                value={toolTarget ?? model.toolChange.current}
                disabled={!editingEnabled || busy}
                onValueChange={setToolTarget}
                options={[
                  ...(registry.getTool(model.toolChange.current) === undefined
                    ? [
                        {
                          value: model.toolChange.current,
                          label: model.toolChange.current,
                          description: "not in this workspace",
                        },
                      ]
                    : []),
                  ...registry.listTools().map((tool) => ({
                    value: tool.name,
                    label: tool.label,
                    description: tool.name,
                  })),
                ]}
              />
            </Field>
            <Button
              variant="secondary"
              disabled={!editingEnabled || busy || toolTarget === null || toolTarget === model.toolChange.current}
              data-testid="change-tool"
              onClick={() => { void runPatch({ $tool: toolTarget }); }}
            >
              <ArrowRightLeft />
              Swap action
            </Button>
          </Section>
        ) : null}

        {/* -------------------------------------------------------------- */}
        {/* what this step hands on                                          */}
        {/* -------------------------------------------------------------- */}
        {advanced ? <PortList title="Passes on" node={node} which="outputs" /> : null}
        {/* Inputs repeat the settings above for a tool, so they are only worth
            their space at the level that wants the types too. */}
        {mode === "developer" ? <PortList title="Takes" node={node} which="inputs" /> : null}

        {/* -------------------------------------------------------------- */}
        {/* remove                                                           */}
        {/* -------------------------------------------------------------- */}
        <Section title="Remove">
          {node.capabilities.deletable ? (
            confirmDelete ? (
              <div className="flex flex-col gap-2">
                <p className="m-0 text-[12px] text-ink-dim">
                  Remove “{node.label}” from the flow? If a later step still needs what it produces, the change is
                  refused and nothing is lost.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="danger-solid"
                    disabled={!editingEnabled || busy}
                    data-testid="confirm-delete"
                    onClick={() => { void runPatch({ $delete: true }, () => { setConfirmDelete(false); }); }}
                  >
                    <Trash2 />
                    Yes, remove it
                  </Button>
                  <Button variant="ghost" onClick={() => { setConfirmDelete(false); }}>
                    Keep it
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="danger"
                disabled={!editingEnabled || busy}
                data-testid="delete-node"
                onClick={() => { setConfirmDelete(true); clearPatchError(); }}
                className="self-start"
              >
                <Trash2 />
                Remove this step
              </Button>
            )
          ) : (
            <FieldHint>
              This step is not written anywhere in the code — it is drawn from the shape of the flow, so there is
              nothing to remove.
            </FieldHint>
          )}
        </Section>

        {/* -------------------------------------------------------------- */}
        {/* developer detail                                                 */}
        {/* -------------------------------------------------------------- */}
        {mode === "developer" ? (
          <Section title="Technical details">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 self-start rounded-md border-0 bg-transparent p-0 font-mono text-[11.5px] text-accent underline decoration-accent/40 underline-offset-2 outline-none hover:decoration-accent focus-visible:ring-2 focus-visible:ring-ring/70"
              onClick={() => { focusRange(node.source); }}
            >
              <Code className="size-3.5" />
              {`${node.source.file}:${String(node.source.start.line)}:${String(node.source.start.column)}`}
            </button>
            <details className="group">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11.5px] font-medium text-ink-dim outline-none hover:text-ink">
                <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
                Node record
              </summary>
              <pre className="cf-scroll m-0 mt-2 max-h-64 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-[11px] leading-[1.6] text-ink-dim">
                <code>
                  {JSON.stringify(
                    { id: node.id, type: node.type, capabilities: node.capabilities, data: node.data },
                    null,
                    2,
                  )}
                </code>
              </pre>
            </details>
          </Section>
        ) : null}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* the one primary action                                            */}
      {/* ---------------------------------------------------------------- */}
      {editableFields.length > 0 ? (
        <footer className="flex items-center gap-2 border-t border-line bg-surface-2 px-4 py-3">
          <Button
            variant="primary"
            size="md"
            disabled={!editingEnabled || busy || dirty.length === 0}
            title={dirty.length === 0 ? "Nothing changed yet" : undefined}
            data-testid="apply"
            onClick={() => { void apply(); }}
          >
            {busy ? "Saving…" : dirty.length > 1 ? `Apply ${String(dirty.length)} changes` : "Apply change"}
          </Button>
          <Hint label="Undo the edits in this panel">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Revert"
              disabled={dirty.length === 0}
              onClick={() => { setDraft(EMPTY_DRAFT); setLocalError(null); }}
            >
              <RotateCcw />
            </Button>
          </Hint>
          <label
            className="ml-auto inline-flex cursor-pointer select-none items-center gap-2 text-[12px] text-ink-dim"
            htmlFor={controlId(node.id, "preview")}
          >
            <input
              type="checkbox"
              id={controlId(node.id, "preview")}
              name="preview"
              className="size-3.5 cursor-pointer accent-[color:var(--cf-accent)]"
              checked={preview}
              onChange={(event) => { setPreview(event.target.checked); }}
            />
            Preview
          </label>
        </footer>
      ) : null}

      {codeOpen && codeEditText !== null && model.codeEdit !== null ? (
        <CodeDialog
          title={`${model.codeEdit.label} — ${node.label}`}
          hint="The whole block is replaced in one go: there is no smaller edit for a piece of custom code."
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
  /** Show the schema type and the patch-operation tag (power user and above). */
  advanced: boolean;
  onText: (value: string) => void;
  onChecked: (value: boolean) => void;
  onTemplate: (value: boolean) => void;
}

/** Field labels come from tool schemas: `channel` reads better as "Channel". */
function humanLabel(label: string): string {
  const spaced = label.replace(/[_-]+/g, " ").replace(/([a-z\d])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function FieldRow(props: FieldRowProps): ReactNode {
  const { field, spec } = props;
  const blocked = field.patch === null || field.blockedReason !== null;
  const reason = field.blockedReason ?? props.disabledReason;
  const disabled = blocked || props.disabled;
  /**
   * An inserted step gets `undefined` written into its required inputs as an
   * explicit placeholder (06 §2). That is honest source, and it is also a value
   * no one typed — so it is shown as "not filled in" rather than as content.
   */
  const unset = field.missing || props.text.trim() === "undefined";
  const placeholder = unset ? "Not set yet" : "";
  const wantsTemplate = spec.kind === "text" && hasInterpolation(props.text);
  const mono = spec.kind === "expression" || spec.kind === "code" || spec.kind === "template";
  const id = controlId(props.nodeId, `field-${field.name}`);
  const title = reason ?? undefined;
  const blockedSplit = field.blockedReason === null ? null : splitSpecRefs(field.blockedReason);
  const hintSplit = spec.hint === null ? null : splitSpecRefs(spec.hint);

  return (
    <Field>
      {/* `cf-field__label` is load-bearing: the a11y suite asserts the visible
          label element is the one carrying the field name. */}
      <FieldLabel className="cf-field__label" htmlFor={id}>
        {humanLabel(field.label)}
        {unset ? (
          <Badge tone="warn" title="This value has to be filled in">
            needs a value
          </Badge>
        ) : null}
        {props.advanced && field.schema !== undefined && typeof field.schema === "string" ? (
          <span className="font-mono text-[10.5px] font-normal text-ink-faint">{field.schema}</span>
        ) : null}
        {props.advanced && !field.declaredEditable ? <Badge>not declared editable</Badge> : null}
        {props.advanced && !field.display.friendly ? <Badge tone="accent">code</Badge> : null}
      </FieldLabel>

      {spec.kind === "checkbox" ? (
        <label className="inline-flex cursor-pointer select-none items-center gap-2 text-[12.5px] text-ink-dim">
          <input
            type="checkbox"
            className="size-4 cursor-pointer accent-[color:var(--cf-accent)] disabled:cursor-not-allowed"
            id={id}
            name={field.name}
            data-field={field.name}
            disabled={disabled}
            title={title}
            checked={props.checked}
            onChange={(event) => { props.onChecked(event.target.checked); }}
          />
          {props.checked ? "Yes" : "No"}
        </label>
      ) : spec.kind === "code" ? (
        <Textarea
          mono
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
        <Input
          mono={mono}
          id={id}
          name={field.name}
          data-field={field.name}
          disabled={disabled}
          title={title}
          invalid={unset}
          type={spec.kind === "number" ? "number" : "text"}
          value={props.text}
          placeholder={placeholder}
          onChange={(event) => { props.onText(event.target.value); }}
        />
      )}

      {wantsTemplate ? (
        <Notice
          tone="warn"
          data-testid={`convert-${field.name}`}
          actions={
            props.template ? (
              <Button variant="ghost" size="xs" onClick={() => { props.onTemplate(false); }}>
                Keep it plain text
              </Button>
            ) : (
              <Button variant="secondary" size="xs" onClick={() => { props.onTemplate(true); }}>
                Yes, insert a value here
              </Button>
            )
          }
        >
          {props.template
            ? "This field will now mix text with values from earlier steps."
            : splitSpecRefs(IMPLICIT_TEMPLATE_REFUSAL).text}
        </Notice>
      ) : null}

      {blockedSplit !== null ? <FieldHint tone="warn">{blockedSplit.text}</FieldHint> : null}
      {blockedSplit === null && unset ? (
        <FieldHint tone="warn">This has to be filled in before the flow can run.</FieldHint>
      ) : null}
      {blockedSplit === null && !unset && hintSplit !== null ? <FieldHint>{hintSplit.text}</FieldHint> : null}
    </Field>
  );
}

function PortList({ title, node, which }: { title: string; node: WorkflowNode; which: "inputs" | "outputs" }): ReactNode {
  const ports = node[which];
  if (ports.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {ports.map((port) => (
          <li key={port.id} className="flex items-baseline gap-2 text-[12px]">
            <code className="rounded-[5px] bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] text-ink">
              {port.label}
            </code>
            {typeof port.schema === "string" ? (
              <span className="truncate font-mono text-[11px] text-ink-faint">{port.schema}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
