/**
 * `<CodeDialog>` — Monaco over one opaque region (07 §4 developer level).
 *
 * The regions a node can hand over whole are the ones 06 §2 calls opaque: an
 * inline `code` node, an unresolved call, or the body of a local function. The
 * "minimal patch" for such a region *is* the whole region, so the dialog edits
 * exactly the text `$code` replaces — no reconstruction, no reprinting.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Editor } from "@monaco-editor/react";

export interface CodeDialogProps {
  title: string;
  /** The exact source of the region being replaced. */
  initialValue: string;
  /** Explains what the region is, above the editor. */
  hint?: string;
  busy?: boolean;
  /** Refusal from the patch engine, shown without dismissing the dialog. */
  error?: string | null;
  theme?: "light" | "dark";
  onSave: (value: string) => void;
  onCancel: () => void;
}

export function CodeDialog(props: CodeDialogProps): ReactNode {
  const [value, setValue] = useState(props.initialValue);

  // Re-opening on another node starts from that node's text.
  useEffect(() => { setValue(props.initialValue); }, [props.initialValue]);

  return (
    <div className="cf-dialog" role="dialog" aria-modal="true" aria-label={props.title}>
      <div className="cf-dialog__panel">
        <header className="cf-dialog__header">
          <h2>{props.title}</h2>
          <button type="button" className="cf-icon-button" onClick={props.onCancel} aria-label="Close">
            ×
          </button>
        </header>
        {props.hint === undefined ? null : <p className="cf-dialog__hint">{props.hint}</p>}
        <div className="cf-dialog__editor">
          <Editor
            height="100%"
            defaultLanguage="typescript"
            theme={props.theme === "dark" ? "vs-dark" : "vs"}
            value={value}
            onChange={(next) => { setValue(next ?? ""); }}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
            }}
          />
        </div>
        {props.error === null || props.error === undefined ? null : (
          <p className="cf-alert cf-alert--error" data-testid="code-dialog-error">
            {props.error}
          </p>
        )}
        <footer className="cf-dialog__footer">
          <button type="button" className="cf-button" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="cf-button cf-button--primary"
            disabled={props.busy === true || value === props.initialValue}
            title={value === props.initialValue ? "Nothing changed yet" : undefined}
            data-testid="code-dialog-save"
            onClick={() => { props.onSave(value); }}
          >
            {props.busy === true ? "Applying…" : "Apply code"}
          </button>
        </footer>
      </div>
    </div>
  );
}
