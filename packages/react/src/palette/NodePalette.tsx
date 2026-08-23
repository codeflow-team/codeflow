/**
 * `<NodePalette>` — everything the registry says can become a node (05, 07 §2).
 *
 * Tools and library functions sit in the palette as equals, because that is what
 * they are in the registry (05, opening diagram). Inserting one is the `$insert`
 * operation of 06 §2: the patcher writes the statement, names the binding, and
 * adds the import for a library function; required inputs with no value become
 * explicit placeholders and the node comes up **needs-configuration**, which is
 * why a successful insert selects the new node and opens it in the inspector.
 *
 * Placement is chosen before inserting: before or after the selected node, into
 * the body of a container, or at the end of the flow when nothing is selected.
 * Anything else (moving a node between branches, reordering) is a structural
 * edit and is refused out loud elsewhere — the palette simply does not offer it.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useCodeFlow } from "../context/hooks.js";
import { CONTAINER_NODE_TYPES } from "../graph/index.js";

export type InsertPlacement = "before" | "after" | "into" | "end";

export interface NodePaletteProps {
  className?: string;
}

interface PaletteEntry {
  kind: "tool" | "function";
  name: string;
  label: string;
  icon: string;
  description: string | undefined;
}

export function NodePalette(props: NodePaletteProps): ReactNode {
  const { graph, registry, selectedNode, selectNode, editingEnabled, editingDisabledReason, patchNode } = useCodeFlow();

  const [placement, setPlacement] = useState<InsertPlacement>("after");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  const [inserted, setInserted] = useState<string | null>(null);

  const tools = useMemo<PaletteEntry[]>(
    () =>
      (registry?.listTools() ?? []).map((tool) => ({
        kind: "tool",
        name: tool.name,
        label: tool.label,
        icon: tool.icon ?? "▸",
        description: tool.description,
      })),
    [registry],
  );

  const functions = useMemo<PaletteEntry[]>(
    () =>
      (registry?.listFunctions() ?? []).map((definition) => ({
        kind: "function",
        name: definition.name,
        label: definition.label,
        icon: definition.icon ?? "ƒ",
        description: definition.description,
      })),
    [registry],
  );

  const container = selectedNode !== null && CONTAINER_NODE_TYPES.includes(selectedNode.type);
  const trigger = graph?.nodes.find((node) => node.type === "trigger") ?? null;
  /**
   * A synthetic node (merge, trigger, an implicit end) has no statement of its
   * own (03 §4), so "before"/"after" it means nothing. Rather than let the
   * patcher refuse afterwards, the palette only offers what exists: the end of
   * the flow (07 §5).
   */
  const synthetic = selectedNode !== null && !selectedNode.capabilities.deletable;
  const effective: InsertPlacement =
    selectedNode === null || synthetic ? "end" : placement === "into" && !container ? "after" : placement;

  const target =
    effective === "end" ? trigger?.id ?? null : selectedNode?.id ?? null;

  const insert = async (entry: PaletteEntry): Promise<void> => {
    if (target === null) {
      setFailure({
        code: "no-anchor",
        message: "There is no flow to insert into yet — analyze a flow first.",
      });
      return;
    }
    const spec: Record<string, unknown> = entry.kind === "tool" ? { tool: entry.name } : { function: entry.name };
    if (effective === "end") spec["where"] = "append";
    else if (effective === "into") {
      spec["where"] = "append";
      spec["slot"] = "body";
    } else spec["where"] = effective;

    setBusy(entry.name);
    setFailure(null);
    const outcome = await patchNode(target, { $insert: spec });
    setBusy(null);

    if (!outcome.ok) {
      setFailure({ code: outcome.code, message: outcome.message });
      return;
    }
    // needs-configuration: the new node is selected so the inspector opens on
    // the placeholders the patcher just wrote (06 §2).
    const added = outcome.result.changes.find((change) => change.type === "node.added");
    if (added?.nodeId !== undefined) {
      selectNode(added.nodeId);
      setInserted(added.nodeId);
    } else {
      setInserted(null);
    }
  };

  return (
    <section className={`cf-palette ${props.className ?? ""}`} data-testid="palette">
      <header className="cf-palette__header">
        <h2 className="cf-palette__title">Palette</h2>
        <select
          className="cf-select"
          value={effective}
          disabled={!editingEnabled || selectedNode === null || synthetic}
          data-testid="palette-placement"
          onChange={(event) => { setPlacement(event.target.value as InsertPlacement); }}
        >
          {selectedNode === null || synthetic ? (
            <option value="end">End of flow</option>
          ) : (
            <>
              <option value="before">Before “{selectedNode.label}”</option>
              <option value="after">After “{selectedNode.label}”</option>
              {container ? <option value="into">Into “{selectedNode.label}”</option> : null}
              <option value="end">End of flow</option>
            </>
          )}
        </select>
      </header>

      {!editingEnabled ? <p className="cf-notice cf-notice--pending">{editingDisabledReason}</p> : null}

      {selectedNode === null && editingEnabled ? (
        <p className="cf-field__hint">No node selected — a new step is appended at the end of the flow.</p>
      ) : null}

      {synthetic && editingEnabled ? (
        <p className="cf-field__hint" data-testid="palette-synthetic">
          “{selectedNode?.label}” is a synthetic node with no statement of its own (03 §4), so nothing can be inserted
          next to it — a new step goes at the end of the flow.
        </p>
      ) : null}

      {failure !== null ? (
        <div className="cf-alert cf-alert--error" data-testid="palette-error" role="alert">
          <div className="cf-alert__head">
            <code>{failure.code}</code>
            <button type="button" className="cf-icon-button" onClick={() => { setFailure(null); }} aria-label="Dismiss">
              ×
            </button>
          </div>
          <p className="cf-alert__message">{failure.message}</p>
        </div>
      ) : null}

      {inserted !== null && failure === null ? (
        <p className="cf-alert cf-alert--ok cf-alert__message" data-testid="palette-inserted">
          Inserted — the new node is selected; fill in any placeholder fields in the inspector.
        </p>
      ) : null}

      <PaletteGroup
        title="Tools"
        entries={tools}
        busy={busy}
        disabled={!editingEnabled}
        onInsert={(entry) => { void insert(entry); }}
        emptyLabel="No tools registered."
      />
      <PaletteGroup
        title="Functions"
        entries={functions}
        busy={busy}
        disabled={!editingEnabled}
        onInsert={(entry) => { void insert(entry); }}
        emptyLabel="No library functions registered."
      />
    </section>
  );
}

function PaletteGroup(props: {
  title: string;
  entries: PaletteEntry[];
  busy: string | null;
  disabled: boolean;
  emptyLabel: string;
  onInsert: (entry: PaletteEntry) => void;
}): ReactNode {
  return (
    <div className="cf-palette__group">
      <h3 className="cf-palette__group-title">{props.title}</h3>
      {props.entries.length === 0 ? (
        <p className="cf-field__hint">{props.emptyLabel}</p>
      ) : (
        <ul className="cf-palette__list">
          {props.entries.map((entry) => (
            <li key={`${entry.kind}:${entry.name}`}>
              <button
                type="button"
                className="cf-palette__item"
                disabled={props.disabled || props.busy !== null}
                title={entry.description ?? entry.name}
                data-testid={`palette-${entry.name}`}
                onClick={() => { props.onInsert(entry); }}
              >
                <span className="cf-palette__icon" aria-hidden="true">
                  {entry.icon}
                </span>
                <span className="cf-palette__label">{entry.label}</span>
                <span className="cf-palette__name">{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
