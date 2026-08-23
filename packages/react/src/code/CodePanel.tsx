/**
 * `<CodePanel>` — Monaco source view, the developer level of progressive
 * disclosure (07 §4) and the other half of the two-way selection sync (07 §2):
 * selecting a node highlights its source range, and moving the caret into a
 * range selects the node that owns it.
 *
 * Note (03 §5.2 step 0): typing here is a source edit *without* patch
 * provenance, so identity goes through the heuristic path — unlike an inspector
 * edit, which carries provenance and keeps every id exactly. The editor stays
 * read-only unless the host passes `onChange` and takes on that re-analyze.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Editor, type OnMount } from "@monaco-editor/react";
import { useCodeFlow } from "../context/hooks.js";

type MonacoEditor = Parameters<OnMount>[0];
type MonacoApi = Parameters<OnMount>[1];
type DecorationsCollection = ReturnType<MonacoEditor["createDecorationsCollection"]>;

export interface CodePanelProps {
  /** Source to show. Defaults to the analyzed graph's source document. */
  value?: string;
  onChange?: (value: string) => void;
  language?: string;
  height?: string | number;
  className?: string;
  theme?: "light" | "dark";
}

export function CodePanel(props: CodePanelProps): ReactNode {
  const { graph, focusedRange, selectNodeAtOffset, selectedNodeId } = useCodeFlow();
  const value = props.value ?? graph?.source.content ?? "";

  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const decorationsRef = useRef<DecorationsCollection | null>(null);
  const [ready, setReady] = useState(false);
  /** Set while we move the caret ourselves, so the sync does not echo back. */
  const programmatic = useRef(false);

  // The cursor listener is registered once; keep it pointing at the *current*
  // selector so it never resolves offsets against a stale graph.
  const selectAtOffset = useRef(selectNodeAtOffset);
  selectAtOffset.current = selectNodeAtOffset;

  const onMount = useCallback<OnMount>((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    decorationsRef.current = editor.createDecorationsCollection();
    setReady(true);

    editor.onDidChangeCursorPosition((event) => {
      if (programmatic.current) return;
      // Only a *user* moving the caret is a selection gesture. Replacing the
      // model — which is what a committed patch does — also moves the caret,
      // and treating that as "the user selected nothing" would drop the
      // selection out from under the node that was just edited.
      if (event.reason === monaco.editor.CursorChangeReason.ContentFlush) return;
      if (event.source !== "mouse" && event.source !== "keyboard") return;
      const model = editor.getModel();
      if (model === null) return;
      selectAtOffset.current(model.getOffsetAt(event.position));
    });
  }, []);

  // Canvas → code: reveal and highlight the selected node's range.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const decorations = decorationsRef.current;
    if (editor === null || monaco === null || decorations === null) return;

    if (focusedRange === null) {
      decorations.set([]);
      return;
    }
    const range = new monaco.Range(
      focusedRange.start.line,
      focusedRange.start.column,
      focusedRange.end.line,
      focusedRange.end.column,
    );
    decorations.set([
      {
        range,
        options: { className: "cf-monaco-range", isWholeLine: false, overviewRuler: { color: "#3b82f6", position: 4 } },
      },
    ]);
    programmatic.current = true;
    editor.revealRangeInCenterIfOutsideViewport(range);
    programmatic.current = false;
  }, [focusedRange, selectedNodeId, ready]);

  return (
    <div className={`cf-code ${props.className ?? ""}`}>
      <Editor
        height={props.height ?? "100%"}
        defaultLanguage={props.language ?? "typescript"}
        theme={props.theme === "dark" ? "vs-dark" : "vs"}
        value={value}
        onMount={onMount}
        onChange={(next) => { props.onChange?.(next ?? ""); }}
        options={{
          readOnly: props.onChange === undefined,
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 21,
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          renderWhitespace: "none",
          renderLineHighlight: "none",
          padding: { top: 12, bottom: 12 },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          overviewRulerBorder: false,
          guides: { indentation: false },
        }}
      />
    </div>
  );
}
