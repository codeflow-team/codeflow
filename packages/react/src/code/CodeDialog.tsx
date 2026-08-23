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
import { Button } from "../ui/button.js";
import { Modal } from "../ui/dialog.js";
import { EngineNotice } from "../ui/notice.js";

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
    <Modal
      open
      onOpenChange={(open) => { if (!open) props.onCancel(); }}
      title={props.title}
      {...(props.hint === undefined ? {} : { description: props.hint })}
      className="h-[min(38rem,calc(100dvh-3rem))]"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={props.busy === true || value === props.initialValue}
            title={value === props.initialValue ? "Nothing changed yet" : undefined}
            data-testid="code-dialog-save"
            onClick={() => { props.onSave(value); }}
          >
            {props.busy === true ? "Saving…" : "Save code"}
          </Button>
        </>
      }
    >
      <div className="min-h-0 flex-1 border-y border-line bg-surface-2 py-2">
        <Editor
          height="100%"
          defaultLanguage="typescript"
          theme={props.theme === "dark" ? "vs-dark" : "vs"}
          value={value}
          onChange={(next) => { setValue(next ?? ""); }}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            padding: { top: 10, bottom: 10 },
          }}
        />
      </div>
      {props.error === null || props.error === undefined ? null : (
        <div className="px-4 pt-3">
          <EngineNotice tone="danger" role="alert" data-testid="code-dialog-error" message={props.error} />
        </div>
      )}
    </Modal>
  );
}
