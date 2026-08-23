/**
 * `<TriggerInputForm>` — "start the flow from *this*".
 *
 * One component, two places: the panel that opens when Run is pressed, and the
 * inspector for the trigger node. 01 §1 makes the flow's first parameter type
 * the trigger, so the trigger node is not merely a reasonable home for this —
 * it is the same object, and rendering it twice from one state is the only
 * arrangement that cannot disagree with itself.
 *
 * The three rules it is written against:
 *
 *  - **the guess is visible and attributed.** Every value the machine chose is
 *    badged `suggested` and carries the sentence explaining what the choice was
 *    based on. A visitor who cannot see why `sourceRoot` points into a temp
 *    directory cannot judge the run they are watching (07 §5);
 *  - **a shape the form cannot express says so.** A union of objects, a
 *    `Record`, a generic, an `unknown` — each gets a JSON editor *and* the
 *    reason there is no control, never a silently-dropped field;
 *  - **a value that contradicts the type blocks Run**, with the same sentence
 *    the inspector uses for the same mistake.
 */

import { useId, type ReactNode } from "react";
import { Badge, Button, Field, FieldHint, FieldLabel, Hint, Input, Modal, Notice, Select, Textarea, cn } from "@codeflow/react";
import { CircleAlert, FolderOpen, Info, Play, Plus, RotateCcw, Sparkles, Trash2, User } from "lucide-react";
import {
  WORKSPACE_TOKEN,
  WORKSPACE_TOKEN_NOTE,
  type FieldSpec,
  type TriggerInputController,
} from "./trigger-input.js";

/* -------------------------------------------------------------------------- */
/* small pieces                                                                */
/* -------------------------------------------------------------------------- */

/** Where this value came from — the whole point of showing the form at all. */
function OriginBadge({ origin }: { origin: "suggested" | "yours" }): ReactNode {
  return origin === "suggested" ? (
    <Badge tone="warn">
      <Sparkles className="size-2.5" />
      suggested
    </Badge>
  ) : (
    <Badge tone="ok">
      <User className="size-2.5" />
      yours
    </Badge>
  );
}

function WorkspaceNote({ value }: { value: unknown }): ReactNode {
  if (typeof value !== "string" || !value.includes(WORKSPACE_TOKEN)) return null;
  return (
    <FieldHint>
      <FolderOpen className="mr-1 inline size-3 align-[-2px]" />
      {WORKSPACE_TOKEN_NOTE}
    </FieldHint>
  );
}

/* -------------------------------------------------------------------------- */
/* one control                                                                 */
/* -------------------------------------------------------------------------- */

function FieldRow({
  field,
  input,
  idPrefix,
  disabled,
}: {
  field: FieldSpec;
  input: TriggerInputController;
  idPrefix: string;
  disabled: boolean;
}): ReactNode {
  const id = `${idPrefix}-${field.path.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const value = readPath(input.value, field.path);
  const problem = input.problemFor(field.path);
  const origin = input.origin(field.path);

  const label = (
    <FieldLabel htmlFor={id}>
      {field.name}
      <code className="rounded bg-surface-2 px-1 font-mono text-[10.5px] font-normal text-ink-faint">
        {field.typeText}
      </code>
      {field.optional ? <span className="text-[10.5px] font-normal text-ink-faint">optional</span> : null}
      <OriginBadge origin={origin} />
    </FieldLabel>
  );

  const why =
    field.why === undefined || origin !== "suggested" ? null : (
      <FieldHint>
        <Info className="mr-1 inline size-3 align-[-2px]" />
        {field.why}.
      </FieldHint>
    );

  const problemLine = problem === null ? null : (
    <FieldHint tone="danger" className="font-medium">
      {problem}
    </FieldHint>
  );

  switch (field.kind) {
    case "string":
      return (
        <Field>
          {label}
          <Input
            id={id}
            name={field.name}
            mono
            disabled={disabled}
            invalid={problem !== null}
            value={typeof value === "string" ? value : ""}
            data-testid={`trigger-input-${field.path}`}
            onChange={(event) => { input.set(field.path, event.target.value); }}
          />
          {problemLine}
          <WorkspaceNote value={value} />
          {why}
        </Field>
      );

    case "number":
      return (
        <Field>
          {label}
          <Input
            id={id}
            name={field.name}
            mono
            // Deliberately `text`, not `number`: a browser number input silently
            // reports "" for `three`, so the wrong value would never reach the
            // check that is supposed to refuse it.
            inputMode="decimal"
            disabled={disabled}
            invalid={problem !== null}
            value={input.drafts[field.path] ?? (typeof value === "number" ? String(value) : "")}
            data-testid={`trigger-input-${field.path}`}
            onChange={(event) => {
              const text = event.target.value;
              const parsed = Number(text.trim());
              input.setDraft(field.path, text, text.trim() === "" || Number.isNaN(parsed) ? undefined : parsed);
            }}
          />
          {problemLine}
          {why}
        </Field>
      );

    case "boolean":
      return (
        <Field>
          <div className="flex items-center gap-2">
            <input
              id={id}
              name={field.name}
              type="checkbox"
              disabled={disabled}
              checked={value === true}
              data-testid={`trigger-input-${field.path}`}
              className="size-4 shrink-0 accent-[var(--cf-accent,currentColor)]"
              onChange={(event) => { input.set(field.path, event.target.checked); }}
            />
            {label}
          </div>
          {problemLine}
          {why}
        </Field>
      );

    case "enum":
      return (
        <Field>
          {label}
          <Select
            id={id}
            name={field.name}
            disabled={disabled}
            data-testid={`trigger-input-${field.path}`}
            value={value === undefined || value === null ? "" : String(value)}
            options={(field.options ?? []).map((option) => ({ value: String(option.value), label: option.label }))}
            onValueChange={(next) => {
              const match = (field.options ?? []).find((option) => String(option.value) === next);
              input.set(field.path, match?.value ?? next);
            }}
          />
          {problemLine}
          {why}
        </Field>
      );

    case "array": {
      const rows = Array.isArray(value) ? value : [];
      const item = field.item;
      return (
        <Field>
          {label}
          <div className="flex flex-col gap-1.5">
            {rows.length === 0 ? (
              <FieldHint>Empty list — the flow is handed <code className="font-mono">[]</code>.</FieldHint>
            ) : null}
            {rows.map((row, index) => {
              const rowPath = `${field.path}.${String(index)}`;
              const rowProblem = input.problemFor(rowPath);
              return (
                <div key={rowPath} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    {item?.kind === "boolean" ? (
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={row === true}
                        data-testid={`trigger-input-${rowPath}`}
                        className="size-4 shrink-0"
                        onChange={(event) => { input.set(rowPath, event.target.checked); }}
                      />
                    ) : item?.kind === "enum" ? (
                      <Select
                        name={`${field.name}-${String(index)}`}
                        disabled={disabled}
                        className="flex-1"
                        data-testid={`trigger-input-${rowPath}`}
                        value={row === undefined || row === null ? "" : String(row)}
                        options={(item.options ?? []).map((option) => ({ value: String(option.value), label: option.label }))}
                        onValueChange={(next) => {
                          const match = (item.options ?? []).find((option) => String(option.value) === next);
                          input.set(rowPath, match?.value ?? next);
                        }}
                      />
                    ) : (
                      <Input
                        mono
                        disabled={disabled}
                        invalid={rowProblem !== null}
                        aria-label={`${field.name} item ${String(index + 1)}`}
                        data-testid={`trigger-input-${rowPath}`}
                        value={
                          item?.kind === "number"
                            ? (input.drafts[rowPath] ?? (typeof row === "number" ? String(row) : ""))
                            : typeof row === "string"
                              ? row
                              : String(row ?? "")
                        }
                        onChange={(event) => {
                          const text = event.target.value;
                          if (item?.kind === "number") {
                            const parsed = Number(text.trim());
                            input.setDraft(rowPath, text, text.trim() === "" || Number.isNaN(parsed) ? undefined : parsed);
                          } else {
                            input.set(rowPath, text);
                          }
                        }}
                      />
                    )}
                    <Hint label="Remove this row">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={disabled}
                        aria-label={`Remove ${field.name} item ${String(index + 1)}`}
                        data-testid={`trigger-remove-${rowPath}`}
                        onClick={() => {
                          input.set(field.path, rows.filter((_, at) => at !== index));
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </Hint>
                  </div>
                  {rowProblem === null ? null : <FieldHint tone="danger">{rowProblem}</FieldHint>}
                  <WorkspaceNote value={row} />
                </div>
              );
            })}
            <Button
              variant="secondary"
              size="xs"
              className="self-start"
              disabled={disabled}
              data-testid={`trigger-add-${field.path}`}
              onClick={() => {
                const blank = item?.kind === "number" ? 0 : item?.kind === "boolean" ? false : item?.options?.[0]?.value ?? "";
                input.set(field.path, [...rows, blank]);
              }}
            >
              <Plus />
              Add {field.name.replace(/s$/, "")}
            </Button>
          </div>
          {problemLine}
          {why}
        </Field>
      );
    }

    case "object":
      return (
        <fieldset
          className="m-0 flex flex-col gap-3 rounded-lg border border-line bg-surface-2/40 p-3"
          data-testid={`trigger-field-${field.path}`}
        >
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
            {field.name}
          </legend>
          {(field.fields ?? []).map((child) => (
            <FieldRow key={child.path} field={child} input={input} idPrefix={idPrefix} disabled={disabled} />
          ))}
          {problemLine}
        </fieldset>
      );

    case "json":
      return (
        <Field>
          {label}
          <Notice tone="info" data-testid={`trigger-json-reason-${field.path}`}>
            {field.reason ?? "There is no control for this shape — write it as JSON."}
          </Notice>
          <Textarea
            id={id}
            name={field.name}
            mono
            rows={4}
            disabled={disabled}
            data-testid={`trigger-input-${field.path}`}
            value={input.drafts[field.path] ?? ""}
            onChange={(event) => {
              const text = event.target.value;
              try {
                input.setDraft(field.path, text, JSON.parse(text) as unknown);
              } catch {
                input.setDraft(field.path, text);
              }
            }}
          />
          {problemLine}
          {why}
        </Field>
      );
  }
}

function readPath(root: unknown, path: string): unknown {
  let cursor = root;
  for (const step of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = Array.isArray(cursor) ? (cursor as unknown[])[Number(step)] : (cursor as Record<string, unknown>)[step];
  }
  return cursor;
}

/* -------------------------------------------------------------------------- */
/* the form                                                                    */
/* -------------------------------------------------------------------------- */

export interface TriggerInputFormProps {
  input: TriggerInputController;
  /** Rendered in the inspector, where the surrounding chrome is different. */
  compact?: boolean;
  disabled?: boolean;
  className?: string;
}

export function TriggerInputForm(props: TriggerInputFormProps): ReactNode {
  const { input } = props;
  const idPrefix = useId();
  const disabled = props.disabled === true;

  if (input.status === "loading") {
    return (
      <p className={cn("m-0 px-1 py-4 text-[12px] text-ink-faint", props.className)} data-testid="trigger-input-loading">
        Reading the trigger&apos;s type…
      </p>
    );
  }

  if (input.status === "unavailable" || input.spec === null) {
    return (
      <div className={cn("flex flex-col gap-2", props.className)}>
        <Notice tone="warn" data-testid="trigger-input-unavailable">
          {input.unavailable ?? "The flow's input type could not be read."}
        </Notice>
      </div>
    );
  }

  const spec = input.spec;

  if (spec.kind === "none") {
    return (
      <div className={cn("flex flex-col gap-2", props.className)}>
        <Notice tone="muted" data-testid="trigger-input-none">
          This flow&apos;s function takes no parameters, so its trigger carries no payload. There is nothing to fill in
          and the run starts from <code className="font-mono">{"{}"}</code>.
        </Notice>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", props.className)} data-testid="trigger-input-form">
      {props.compact ? null : (
        <p className="m-0 text-[12px] leading-[1.55] text-ink-dim">
          The flow starts from this object — it is the trigger&apos;s payload, and its type is what makes the trigger
          node what it is. Values the demo chose for you are badged{" "}
          <span className="whitespace-nowrap">
            <Sparkles className="inline size-3 align-[-2px]" /> suggested
          </span>
          ; change any of them and the badge follows.
        </p>
      )}

      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] text-ink-dim">
          {spec.paramName}: {spec.typeText ?? "unknown"}
        </code>
        <Hint label="Put every field back to the value the demo suggested">
          <Button variant="ghost" size="xs" disabled={disabled} data-testid="trigger-reset" onClick={input.reset}>
            <RotateCcw />
            Reset to suggested
          </Button>
        </Hint>
      </div>

      {spec.kind === "json" ? (
        <Field>
          <Notice tone="info" data-testid="trigger-json-reason">
            {spec.reason}
          </Notice>
          <Textarea
            mono
            rows={12}
            disabled={disabled}
            aria-label="The flow's input, as JSON"
            data-testid="trigger-input-json"
            value={input.drafts[""] ?? ""}
            onChange={(event) => {
              const text = event.target.value;
              try {
                input.setDraft("", text, JSON.parse(text) as unknown);
              } catch {
                input.setDraft("", text);
              }
            }}
          />
          {input.problemFor("") === null ? null : (
            <FieldHint tone="danger" className="font-medium">
              {input.problemFor("")}
            </FieldHint>
          )}
        </Field>
      ) : (
        <div className="flex flex-col gap-4">
          {spec.fields.map((field) => (
            <FieldRow key={field.path} field={field} input={input} idPrefix={idPrefix} disabled={disabled} />
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* the pre-run panel                                                           */
/* -------------------------------------------------------------------------- */

export interface TriggerInputDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  input: TriggerInputController;
  onRun: () => void;
  flowName: string;
}

export function TriggerInputDialog(props: TriggerInputDialogProps): ReactNode {
  const { input } = props;
  const blocked = !input.valid;

  return (
    <Modal
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Start the flow"
      description={`What ${props.flowName} runs on. Press Run and it goes straight to the runner, exactly as written here.`}
      className="w-[min(38rem,calc(100vw-2rem))]"
      footer={
        <>
          <span className="mr-auto text-[11.5px] text-ink-dim" data-testid="trigger-changed-count">
            {input.status !== "ready"
              ? ""
              : input.changedCount === 0
                ? "Every value is the demo's suggestion."
                : `${String(input.changedCount)} value${input.changedCount === 1 ? "" : "s"} ${input.changedCount === 1 ? "is" : "are"} yours.`}
          </span>
          <Button variant="ghost" onClick={() => { props.onOpenChange(false); }}>
            Cancel
          </Button>
          <Hint label={blocked ? "Fix the values that do not match the type first" : "Run the flow on these values"}>
            <span>
              <Button variant="primary" disabled={blocked} data-testid="trigger-run" onClick={props.onRun}>
                <Play />
                Run
              </Button>
            </span>
          </Hint>
        </>
      }
    >
      <div className="cf-scroll min-h-0 flex-1 overflow-auto px-4 py-4">
        {blocked && input.problems.length > 0 ? (
          <Notice tone="danger" role="alert" title="These values do not match the trigger's type" className="mb-3" data-testid="trigger-blocked">
            <ul className="m-0 list-none space-y-1 p-0">
              {input.problems.map((problem) => (
                <li key={problem.path || "root"} className="flex gap-1.5">
                  <CircleAlert className="mt-0.5 size-3 shrink-0" />
                  <span>{problem.message}</span>
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <TriggerInputForm input={input} />
      </div>
    </Modal>
  );
}
