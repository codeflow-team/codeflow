/**
 * `<NodePalette>` — everything the registry says can become a step (05, 07 §2),
 * as a command palette: type to search, arrow keys to move, Enter to insert.
 *
 * Tools and library functions sit here as equals, because that is what they are
 * in the registry (05, opening diagram). Inserting one is the `$insert`
 * operation of 06 §2: the patcher writes the statement, names the binding, and
 * adds the import for a library function; required inputs with no value become
 * explicit placeholders and the step comes up **needs-configuration**, which is
 * why a successful insert selects the new step and opens it in the inspector.
 *
 * Placement is chosen before inserting: before or after the selected step, into
 * the body of a container, or at the end of the flow when nothing is selected.
 * Anything else (moving a step between branches, reordering) is a structural
 * edit and is refused out loud elsewhere — the palette simply does not offer it.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { CornerDownLeft, LoaderCircle, Plus, Search, SquareFunction, Wrench } from "lucide-react";
import { useCodeFlow } from "../context/hooks.js";
import { CONTAINER_NODE_TYPES } from "../graph/index.js";
import { RegistryGlyph } from "../flow/glyphs.js";
import { errorHeadline, splitSpecRefs } from "../copy.js";
import { cn } from "../ui/cn.js";
import { Button } from "../ui/button.js";
import { Kbd } from "../ui/badge.js";
import { Modal } from "../ui/dialog.js";
import { Notice } from "../ui/notice.js";
import { Select } from "../ui/select.js";

export type InsertPlacement = "before" | "after" | "into" | "end";

export interface NodePaletteProps {
  className?: string;
  /** Controlled open state; omit to let the palette own its own trigger. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Replaces the default "Add step" button. Pass `null` for no trigger. */
  trigger?: ReactElement | null;
}

interface PaletteEntry {
  kind: "tool" | "function";
  name: string;
  label: string;
  icon: string | undefined;
  description: string | undefined;
}

export function NodePalette(props: NodePaletteProps): ReactNode {
  const { graph, registry, selectedNode, selectNode, editingEnabled, editingDisabledReason, patchNode } = useCodeFlow();

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = props.open ?? uncontrolledOpen;
  const setOpen = (next: boolean): void => {
    setUncontrolledOpen(next);
    props.onOpenChange?.(next);
  };

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<InsertPlacement>("after");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const tools = useMemo<PaletteEntry[]>(
    () =>
      (registry?.listTools() ?? []).map((tool) => ({
        kind: "tool",
        name: tool.name,
        label: tool.label,
        icon: tool.icon,
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
        icon: definition.icon,
        description: definition.description,
      })),
    [registry],
  );

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const match = (entry: PaletteEntry): boolean =>
      needle.length === 0 ||
      entry.label.toLowerCase().includes(needle) ||
      entry.name.toLowerCase().includes(needle) ||
      (entry.description ?? "").toLowerCase().includes(needle);
    return [
      { title: "Actions", hint: "Things this flow can do", entries: tools.filter(match) },
      { title: "Functions", hint: "Reusable logic from your library", entries: functions.filter(match) },
    ].filter((group) => group.entries.length > 0);
  }, [tools, functions, query]);

  const flat = useMemo(() => groups.flatMap((group) => group.entries), [groups]);

  useEffect(() => { setActive(0); }, [query, open]);
  useEffect(() => {
    if (!open) { setQuery(""); setFailure(null); }
  }, [open]);

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

  const target = effective === "end" ? trigger?.id ?? null : selectedNode?.id ?? null;

  const insert = async (entry: PaletteEntry): Promise<void> => {
    if (target === null) {
      setFailure({ code: "no-anchor", message: "There is no flow to add to yet — open a flow first." });
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
    // needs-configuration: the new step is selected so the inspector opens on
    // the placeholders the patcher just wrote (06 §2).
    const added = outcome.result.changes.find((change) => change.type === "node.added");
    if (added?.nodeId !== undefined) selectNode(added.nodeId);
    setOpen(false);
  };

  const placementOptions = useMemo(() => {
    if (selectedNode === null || synthetic) return [{ value: "end", label: "At the end of the flow" }];
    return [
      { value: "after", label: `After “${selectedNode.label}”` },
      { value: "before", label: `Before “${selectedNode.label}”` },
      ...(container ? [{ value: "into", label: `Inside “${selectedNode.label}”` }] : []),
      { value: "end", label: "At the end of the flow" },
    ];
  }, [selectedNode, synthetic, container]);

  const defaultTrigger = (
    <Button variant="primary" size="md" disabled={!editingEnabled} title={editingEnabled ? undefined : editingDisabledReason}>
      <Plus />
      Add step
    </Button>
  );

  const triggerNode =
    props.trigger === null
      ? null
      : props.trigger === undefined
        ? defaultTrigger
        : props.trigger;

  return (
    <>
      {triggerNode === null ? null : (
        <span
          className={cn("inline-flex", props.className)}
          data-testid="palette-trigger"
          onClick={() => { setOpen(true); }}
        >
          {triggerNode}
        </span>
      )}

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Add a step"
        description={
          selectedNode === null || synthetic
            ? "New steps are added at the end of the flow."
            : "Choose where it goes, then pick what it should do."
        }
        className="max-h-[min(34rem,calc(100dvh-4rem))] w-[min(38rem,calc(100vw-2rem))]"
        action={
          <div className="w-56 shrink-0" data-testid="palette-placement">
            <Select
              id="cf-insert-placement"
              name="insert-placement"
              aria-label="Where to add the step"
              value={effective}
              disabled={!editingEnabled || selectedNode === null || synthetic}
              onValueChange={(value) => { setPlacement(value as InsertPlacement); }}
              options={placementOptions}
            />
          </div>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col" data-testid="palette">
          <div className="relative border-b border-line">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <input
              autoFocus
              type="text"
              id="cf-palette-search"
              name="palette-search"
              aria-label="Search steps"
              placeholder="Search actions and functions…"
              value={query}
              disabled={!editingEnabled}
              onChange={(event) => { setQuery(event.target.value); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((current) => (flat.length === 0 ? 0 : (current + 1) % flat.length));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((current) => (flat.length === 0 ? 0 : (current - 1 + flat.length) % flat.length));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const entry = flat[active];
                  if (entry !== undefined && busy === null) void insert(entry);
                }
              }}
              className="h-12 w-full appearance-none border-0 bg-transparent pl-11 pr-4 font-sans text-[14px] text-ink outline-none placeholder:text-ink-faint"
            />
          </div>

          {!editingEnabled ? (
            <div className="p-4">
              <Notice tone="info" title="Read-only">
                {splitSpecRefs(editingDisabledReason).text}
              </Notice>
            </div>
          ) : null}

          {failure !== null ? (
            <div className="px-4 pt-4">
              <Notice
                tone="danger"
                role="alert"
                data-testid="palette-error"
                title={errorHeadline(failure.code)}
                code={failure.code}
                refs={splitSpecRefs(failure.message).refs}
                onDismiss={() => { setFailure(null); }}
              >
                {splitSpecRefs(failure.message).text}
              </Notice>
            </div>
          ) : null}

          {synthetic && editingEnabled ? (
            <p className="m-0 px-4 pt-3 text-[11.5px] text-ink-dim" data-testid="palette-synthetic">
              “{selectedNode?.label}” is not written anywhere in the code, so nothing can go next to it — the new step
              goes at the end of the flow.
            </p>
          ) : null}

          <div ref={listRef} className="cf-scroll min-h-0 flex-1 overflow-y-auto p-2">
            {flat.length === 0 ? (
              <p className="m-0 px-2 py-8 text-center text-[12.5px] text-ink-dim">
                {query.trim().length === 0
                  ? "Nothing is registered yet — a host app decides which actions this flow can use."
                  : `Nothing matches “${query.trim()}”.`}
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.title} className="mb-1">
                  <p className="m-0 px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
                    {group.title}
                    <span className="ml-2 font-normal normal-case tracking-normal text-ink-faint/80">{group.hint}</span>
                  </p>
                  {group.entries.map((entry) => {
                    const index = flat.indexOf(entry);
                    return (
                      <button
                        key={`${entry.kind}:${entry.name}`}
                        type="button"
                        disabled={!editingEnabled || busy !== null}
                        data-testid={`palette-${entry.name}`}
                        aria-selected={index === active}
                        onMouseMove={() => { setActive(index); }}
                        onClick={() => { void insert(entry); }}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left",
                          "outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                          index === active ? "bg-surface-2" : "hover:bg-surface-2/60",
                        )}
                      >
                        <span
                          className={cn(
                            "grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4",
                            entry.kind === "tool"
                              ? "bg-node-tool/12 text-node-tool"
                              : "bg-node-function/12 text-node-function",
                          )}
                        >
                          <RegistryGlyph icon={entry.icon} fallback={entry.kind === "tool" ? Wrench : SquareFunction} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-ink">{entry.label}</span>
                          <span className="block truncate text-[11.5px] text-ink-dim">
                            {entry.description ?? entry.name}
                          </span>
                        </span>
                        {busy === entry.name ? (
                          <LoaderCircle className="size-4 shrink-0 animate-spin text-ink-faint" />
                        ) : index === active ? (
                          <CornerDownLeft className="size-3.5 shrink-0 text-ink-faint" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-4 py-2 text-[11px] text-ink-faint">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              to move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd>
              to add
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Kbd>esc</Kbd>
              to close
            </span>
          </div>
        </div>
      </Modal>
    </>
  );
}
