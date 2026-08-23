/**
 * `<RunPanel>` — what actually happened, in the order it happened.
 *
 * The canvas answers "where is it now"; this answers "how did it get there".
 * They are different questions and a run needs both: a node lit green tells you
 * nothing about the four seconds it spent inside a tool call, or that the loop
 * body ran twelve times, or that the value it produced was `{ entities: [] }`
 * which is why the next branch was not taken.
 *
 * Two rules it does not break:
 *
 *  - **Say where a value came from.** Every step that called a tool is tagged
 *    `live` or `sample`. A viewer who cannot tell a real MCP answer from a
 *    schema-shaped placeholder has been misled, and this feature's whole claim
 *    is that what you are watching is real.
 *  - **Clicking a row selects that step**, which pans the canvas and opens the
 *    inspector — the same selection every other panel drives.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Hint, NodeGlyph, cn, useCodeFlow } from "@codeflow/react";
import type { WorkflowNode } from "@codeflow/core";
import { CircleAlert, CircleCheck, FolderOpen, LoaderCircle, Play, Square, X } from "lucide-react";
import type { RunSnapshot } from "./run.js";

export interface RunPanelProps {
  run: RunSnapshot;
  onStart: () => void;
  onStop: () => void;
  onClose?: () => void;
}

function shortPreview(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    const inner = (value as { value?: unknown }).value;
    return inner === undefined ? null : shortPreview(inner);
  }
  if (typeof value === "object" && "__truncated" in (value as Record<string, unknown>)) {
    return String((value as { text?: string }).text ?? "");
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return null;
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function sourceOf(preview: unknown): "mcp" | "sample" | null {
  if (typeof preview !== "object" || preview === null) return null;
  const source = (preview as { source?: unknown }).source;
  return source === "mcp" ? "mcp" : source === "sample" ? "sample" : null;
}

export function RunPanel(props: RunPanelProps): ReactNode {
  const { run } = props;
  const { graph, selectNode, selectedNodeId } = useCodeFlow();
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);

  const byId = useMemo(() => {
    const map = new Map<string, WorkflowNode>();
    for (const node of graph?.nodes ?? []) map.set(node.id, node);
    return map;
  }, [graph]);

  // Only the steps starting and ending — the `started` line for a step that
  // finishes in under a frame is noise, so a completed step collapses to one
  // row carrying its duration.
  const rows = useMemo(() => {
    const out: {
      key: string;
      nodeId: string;
      phase: string;
      at: number;
      durationMs?: number;
      preview?: unknown;
      error?: { message: string };
    }[] = [];
    for (const [i, event] of run.events.entries()) {
      if (event.phase === "started") {
        const closed = run.events
          .slice(i + 1)
          .some((later) => later.nodeId === event.nodeId && later.phase !== "started");
        if (closed) continue;
      }
      out.push({ key: `${String(i)}:${event.nodeId}`, nodeId: event.nodeId, phase: event.phase, at: event.at, durationMs: event.durationMs, preview: event.preview, error: event.error });
    }
    return out;
  }, [run.events]);

  useEffect(() => {
    if (!follow) return;
    const list = listRef.current;
    if (list === null) return;
    list.scrollTop = list.scrollHeight;
  }, [rows.length, follow]);

  const running = run.status === "running" || run.status === "starting";
  const stepsRun = run.nodes.size;
  const totalSteps = (run.plan?.probed.length ?? 0) + (run.plan?.skipped.length ?? 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface font-sans" data-testid="run-panel">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        {running ? (
          <LoaderCircle className="size-3.5 animate-spin text-accent" />
        ) : run.status === "failed" || run.status === "timeout" ? (
          <CircleAlert className="size-3.5 text-danger" />
        ) : run.status === "ok" ? (
          <CircleCheck className="size-3.5 text-ok" />
        ) : (
          <Play className="size-3.5 text-ink-faint" />
        )}
        <h2 className="m-0 text-[12px] font-semibold tracking-[-0.005em] text-ink">Run</h2>
        <span className="text-[11px] text-ink-faint" data-testid="run-progress">
          {run.status === "idle"
            ? "not started"
            : `${String(stepsRun)}/${String(totalSteps)} steps · ${String(run.elapsedMs)}ms`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {running ? (
            <Button variant="secondary" size="sm" data-testid="run-stop" onClick={props.onStop}>
              <Square />
              Stop
            </Button>
          ) : (
            <Button variant="secondary" size="sm" data-testid="run-restart" onClick={props.onStart}>
              <Play />
              Run again
            </Button>
          )}
          {props.onClose === undefined ? null : (
            <button
              type="button"
              aria-label="Hide the run log"
              onClick={props.onClose}
              className="grid size-6 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-ink-faint hover:bg-surface-2 hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </header>

      {/* --- where the data came from ------------------------------------- */}
      {run.plan === null ? null : (
        <div className="shrink-0 border-b border-line px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5" data-testid="run-bindings">
            {run.plan.bindings.map((binding) => (
              <Hint
                key={binding.namespace}
                label={
                  binding.mode === "mcp"
                    ? `${String(binding.server)} — running for real. ${String(binding.safety ?? "")}`
                    : `${String(binding.reason ?? "No server behind this one.")} Results are generated from the tool's output schema.`
                }
              >
                <span>
                  <Badge tone={binding.mode === "mcp" ? "ok" : "warn"}>
                    tools.{binding.namespace} ·{" "}
                    {binding.mode === "mcp"
                      ? `live MCP${binding.tools === undefined ? "" : ` (${String(binding.tools)})`}`
                      : "sample data"}
                  </Badge>
                </span>
              </Hint>
            ))}
          </div>
          {run.plan.skipped.length === 0 ? null : (
            <p className="m-0 mt-1.5 text-[11px] leading-4 text-ink-faint">
              {run.plan.skipped.length} step{run.plan.skipped.length === 1 ? "" : "s"} could not be traced
              without changing what the code does — {run.plan.skipped.length === 1 ? "it is" : "they are"}{" "}
              marked <em>not traced</em> rather than reported as unreached.
            </p>
          )}
          <p className="m-0 mt-1.5 flex items-center gap-1 text-[11px] leading-4 text-ink-faint">
            <FolderOpen className="size-3" />
            <code className="truncate font-mono text-[10.5px]">{run.plan.workspace}</code>
          </p>
        </div>
      )}

      {/* --- the log ------------------------------------------------------- */}
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
        }}
      >
        {rows.length === 0 ? (
          <p className="m-0 px-3 py-6 text-center text-[12px] text-ink-faint">
            {run.status === "idle" ? "Press Run to watch this flow execute." : "Waiting for the first step…"}
          </p>
        ) : (
          <ol className="m-0 list-none p-0">
            {rows.map((row) => {
              const node = byId.get(row.nodeId);
              const source = sourceOf(row.preview);
              const value = shortPreview(row.preview);
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    data-testid={`run-row-${row.nodeId}`}
                    onClick={() => { selectNode(row.nodeId); }}
                    className={cn(
                      "flex w-full cursor-pointer items-start gap-2 border-0 border-b border-line/60 bg-transparent px-3 py-1.5 text-left",
                      "hover:bg-surface-2",
                      selectedNodeId === row.nodeId && "bg-accent-soft",
                    )}
                  >
                    <span className="w-11 shrink-0 pt-0.5 text-right font-mono text-[10px] tabular-nums text-ink-faint">
                      {row.at}ms
                    </span>
                    {node === undefined ? null : <NodeGlyph node={node} className="mt-0.5 size-3.5 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12px] leading-4 text-ink">
                          {node?.label ?? row.nodeId}
                        </span>
                        {row.phase === "started" ? (
                          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-accent">
                            running
                          </span>
                        ) : row.phase === "failed" ? (
                          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-danger">
                            failed
                          </span>
                        ) : row.durationMs === undefined ? null : (
                          <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">
                            {row.durationMs}ms
                          </span>
                        )}
                        {source === null ? null : (
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-1.5 text-[9px] font-semibold uppercase leading-[15px] tracking-wide",
                              source === "mcp" ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn",
                            )}
                          >
                            {source === "mcp" ? "live" : "sample"}
                          </span>
                        )}
                      </span>
                      {row.error !== undefined ? (
                        <span className="mt-0.5 block break-words font-mono text-[10.5px] leading-4 text-danger">
                          {row.error.message}
                        </span>
                      ) : value === null ? null : (
                        <span className="mt-0.5 block truncate font-mono text-[10.5px] leading-4 text-ink-faint">
                          {value}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* --- outcome ------------------------------------------------------- */}
      {run.status === "idle" || running ? null : (
        <footer className="shrink-0 border-t border-line px-3 py-2" data-testid="run-outcome">
          {run.error === undefined ? (
            <>
              <p className="m-0 text-[11.5px] font-semibold text-ink">
                {run.status === "cancelled" ? "Stopped" : "Finished"} in {run.elapsedMs}ms
              </p>
              {run.result === undefined ? null : (
                <pre className="m-0 mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-4 text-ink-dim">
                  {JSON.stringify(run.result, null, 2)}
                </pre>
              )}
            </>
          ) : (
            <>
              <p className="m-0 text-[11.5px] font-semibold text-danger">
                {run.status === "timeout" ? "Timed out" : "Stopped by an error"}
              </p>
              <p className="m-0 mt-0.5 break-words text-[11.5px] leading-4 text-ink-dim">{run.error.message}</p>
            </>
          )}
        </footer>
      )}
    </div>
  );
}
