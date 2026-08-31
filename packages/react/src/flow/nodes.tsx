/**
 * Custom React Flow nodes — 07 §3 (compact / expanded / developer) and §5
 * (`code` and `unknown` must be unmistakable; diagnostics show on the node they
 * belong to).
 *
 * The node is the product's main object, so it is drawn like one: a tinted icon
 * chip carrying the type, a real title, quiet key/value rows, and status shown
 * as a word rather than a coloured dot. Everything machine-facing — the tool's
 * qualified name, the source text — is held back for the developer level.
 */

import { useCallback, type ReactNode } from "react";
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { ChevronDown, ChevronRight, Shrink, Trash2 } from "lucide-react";
import type { Diagnostic, WorkflowNode } from "@codeflow/core";
import { CONTAINER_SLOTS, worstSeverity } from "../graph/index.js";
import { useOptionalCodeFlow } from "../context/hooks.js";
import { cn } from "../ui/cn.js";
import { NodeGlyph } from "./glyphs.js";
import { developerLines, hasNodeBody, nodeCaption, nodeSummaryRows, nodeTitle } from "./summary.js";
import { isMinorNode } from "../layout/measure.js";
import { insideLabel } from "./collapse.js";
import { slotHandleId, type CodeFlowRFNode } from "./to-react-flow.js";
import { resolveNodeRenderer, type ResolvedNodeRenderer } from "./renderer.js";
import { runBadgeKind } from "./run-badge.js";

/**
 * Renders a display value, giving `{{ … }}` interpolations their own treatment.
 *
 * `{{ }}` is display syntax for a TypeScript expression (06 §3), and showing it
 * as a tinted token is how the user learns that "this part is filled in when the
 * flow runs" without being told.
 */
function Value({ text }: { text: string }): ReactNode {
  const parts = text.split(/(\{\{[\s\S]*?\}\})/g).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("{{") && part.endsWith("}}") ? (
          <span
            key={i}
            className="rounded-[4px] bg-accent-soft px-1 font-mono text-[10.5px] text-accent"
          >
            {part.slice(2, -2).trim()}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/**
 * The chip form of the status badge, for a node drawn small.
 *
 * A "Note" on a code node is the commonest diagnostic in the product — every
 * `code` step carries one — so on a chip it is dropped entirely: a mark that
 * every single one of twenty-one boxes wears tells the reader nothing. A
 * warning or an error still gets a dot, because those are precisely the boxes
 * someone is looking for.
 */
function StatusDot({ diagnostics }: { diagnostics: Diagnostic[] }): ReactNode {
  const severity = worstSeverity(diagnostics);
  if (severity === null || !isWorthMarking(diagnostics)) return null;
  const title = diagnostics.map((d) => `${d.severity}: ${d.message}`).join("\n");
  return (
    <span
      title={title}
      aria-label={`${String(diagnostics.length)} ${severity}`}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        severity === "error" ? "bg-danger" : "bg-warn",
      )}
    />
  );
}

/**
 * True when a node's diagnostics are worth a mark on the canvas.
 *
 * An `info` note is not. The one every `code` node carries — "custom code is
 * kept verbatim" — is a statement about the *kind* of step, already made by the
 * step's dashed border and its "Custom code" caption, and printing NOTE on
 * twenty-one boxes turns a status colour into wallpaper: after the third one
 * nobody looks at the badge again, including on the node that has a real
 * warning. Notes stay in the diagnostics panel and in the step's own details,
 * where they are read on purpose rather than glanced past.
 */
function isWorthMarking(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic) => diagnostic.severity !== "info" || diagnostic.code === "needs-configuration",
  );
}

function StatusBadge({ diagnostics }: { diagnostics: Diagnostic[] }): ReactNode {
  const severity = worstSeverity(diagnostics);
  if (severity === null || !isWorthMarking(diagnostics)) return null;

  const needsSetup = diagnostics.some((diagnostic) => diagnostic.code === "needs-configuration");
  const label = needsSetup
    ? "Needs setup"
    : severity === "error"
      ? diagnostics.length > 1
        ? `${String(diagnostics.length)} problems`
        : "Problem"
      : severity === "warning"
        ? "Check this"
        : "Note";

  const tone = needsSetup || severity === "warning" ? "warn" : severity === "error" ? "danger" : "info";
  const title = diagnostics.map((d) => `${d.severity}: ${d.message}`).join("\n");

  return (
    <span
      title={title}
      aria-label={`${String(diagnostics.length)} ${severity}`}
      className={cn(
        "inline-flex h-[17px] shrink-0 items-center rounded-full px-1.5 text-[9.5px] font-semibold uppercase leading-none tracking-[0.03em]",
        tone === "danger" && "bg-danger-soft text-danger",
        tone === "warn" && "bg-warn-soft text-warn",
        tone === "info" && "bg-info-soft text-info",
      )}
    >
      {label}
    </span>
  );
}

/**
 * Delete affordance on the selected node (06 §2). The refusal path matters more
 * than the happy one: a blocked delete comes back as `patch-dependency` naming
 * the node that still reads the binding, and the inspector shows it — the button
 * never removes anything quietly, and never leaves code that would not compile.
 */
function DeleteButton({ node, small = false }: { node: WorkflowNode; small?: boolean }): ReactNode {
  const cf = useOptionalCodeFlow();
  if (cf === null || !cf.editingEnabled || !node.capabilities.deletable) return null;
  return (
    <button
      type="button"
      title={`Delete “${node.label}”`}
      aria-label={`Delete ${node.label}`}
      data-testid={`node-delete-${node.id}`}
      className={cn(
        "ml-1 grid shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0",
        // On a chip the affordance matches the 18px glyph well: at 20px it is
        // the tallest thing in the header, and a selected chip would then be
        // two pixels taller than the box layout gave it.
        small ? "size-4.5" : "size-5",
        "text-ink-faint outline-none transition-colors hover:bg-danger-soft hover:text-danger",
        "focus-visible:ring-2 focus-visible:ring-ring/70",
      )}
      onClick={(event) => {
        event.stopPropagation();
        void cf.patchNode(node.id, { $delete: true });
      }}
    >
      <Trash2 className="size-3" />
    </button>
  );
}

/**
 * Puts a hand-resized container back to the size layout worked out for it.
 *
 * Only offered once the box has actually been pulled out of shape, so the
 * header stays clean the rest of the time.
 */
function FitButton({ nodeId, width, height }: { nodeId: string; width: number; height: number }): ReactNode {
  const { setNodes } = useReactFlow();
  const fit = useCallback(() => {
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === nodeId
          ? { ...node, width, height, style: { ...node.style, width, height } }
          : node,
      ),
    );
  }, [setNodes, nodeId, width, height]);

  return (
    <button
      type="button"
      title="Fit the box back to its contents"
      aria-label="Fit the box back to its contents"
      data-testid={`node-fit-${nodeId}`}
      className={cn(
        "ml-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0",
        "text-ink-faint outline-none transition-colors hover:bg-surface-2 hover:text-ink",
        "focus-visible:ring-2 focus-visible:ring-ring/70",
      )}
      onClick={(event) => {
        event.stopPropagation();
        fit();
      }}
    >
      <Shrink className="size-3" />
    </button>
  );
}

/**
 * The fold control on a `for` / `while` / `try`.
 *
 * Always on the header, never only on hover or only when selected: on a big
 * flow the folded boxes are what the reader is navigating by, and a control you
 * have to discover is a control most readers never find. It states the number
 * it is about to reveal — "open the 12 steps inside" — so the click is never a
 * jump into an unknown amount of diagram.
 */
function FoldButton({ nodeId, inner, folded }: { nodeId: string; inner: number; folded: boolean }): ReactNode {
  const cf = useOptionalCodeFlow();
  if (cf === null || inner === 0) return null;
  return (
    <button
      type="button"
      title={folded ? `Open the ${insideLabel(inner)}` : "Fold these steps into one box"}
      aria-label={folded ? `Open the ${insideLabel(inner)}` : `Fold ${insideLabel(inner)} into one box`}
      aria-expanded={!folded}
      data-testid={`node-fold-${nodeId}`}
      className={cn(
        "grid size-5 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0",
        "text-ink-faint outline-none transition-colors hover:bg-surface-2 hover:text-ink",
        "focus-visible:ring-2 focus-visible:ring-ring/70",
      )}
      onClick={(event) => {
        event.stopPropagation();
        cf.toggleCollapsed(nodeId);
      }}
    >
      {folded ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
    </button>
  );
}

/**
 * The one line a folded box owes the reader: how much is behind it.
 *
 * The count is every step inside, counted recursively — not the direct children
 * — because "12 steps inside" has to survive being checked against the outline.
 */
function FoldedSummary({ nodeId, inner }: { nodeId: string; inner: number }): ReactNode {
  const cf = useOptionalCodeFlow();
  return (
    <button
      type="button"
      data-testid={`node-open-${nodeId}`}
      className={cn(
        // `mb-3` is the card's bottom padding: on a folded box this button is
        // the last block, so it is the one that owes the reader the same air
        // under it that the header has above it.
        "mx-3 mb-3 flex cursor-pointer items-center gap-1.5 rounded-md border-0 px-1.5 py-1 text-left",
        "bg-[color:color-mix(in_srgb,var(--node)_10%,transparent)] text-[11.5px] font-medium leading-4",
        "text-ink-dim transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/70",
      )}
      onClick={(event) => {
        event.stopPropagation();
        cf?.toggleCollapsed(nodeId);
      }}
    >
      <ChevronRight className="size-3 shrink-0" />
      {insideLabel(inner)}
    </button>
  );
}

function NodeHeader({
  data,
  selected,
  before,
  last = false,
}: {
  data: CodeFlowRFNode["data"];
  selected: boolean;
  /** Extra affordance shown left of the delete button (container "fit"). */
  before?: ReactNode;
  /**
   * True when nothing is drawn under this header, which makes it the block that
   * owes the card its bottom padding (`pb-3` rather than the 8px block gap).
   */
  last?: boolean;
}): ReactNode {
  const caption = nodeCaption(data.node, data.mode);
  const compact = data.mode === "compact";
  const minor = isMinorNode(data.node, data.mode);
  const { badge } = useRunMark(data.node.id);
  /*
   * A decision's title is the `if` expression, which at the beginner level is
   * the least welcoming thing on the canvas. `nodeTitle` renders the shapes it
   * can translate exactly and leaves the rest alone — and either way the raw
   * expression stays one hover away, because a friendlier label must never cost
   * the reader the literal truth.
   */
  const title = nodeTitle(data.node, data.mode);
  return (
    <header
      className={cn(
        "flex items-center px-3",
        /*
         * `pt-3` at the top and `pb-3` under the last block are the card's own
         * padding and are deliberately the same number. The `pb-2` case is not
         * padding at all — it is the gap down to the body, which carries the
         * `pb-3` instead. `measure.ts` mirrors exactly this.
         */
        minor
          ? "gap-1.5 px-2 py-1.5"
          : compact
            ? "gap-2.5 py-2.5"
            : cn("gap-2.5 pt-3", last ? "pb-3" : "pb-2"),
      )}
    >
      <span className="cf-node__chip">
        <NodeGlyph node={data.node} className={minor ? "size-3" : "size-3.5"} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate tracking-[-0.005em]",
            // `leading-4` has to come *after* the size: `cn` merges through
            // tailwind-merge, which treats a font-size as overriding any
            // line-height set before it. Written the other way round the
            // leading is silently dropped and the title line grows to the
            // canvas default — which is how the header came to be 3px taller
            // than anything had measured it at.
            minor ? "text-[11px] font-medium text-ink-dim" : "text-[13px] font-semibold text-ink",
            "leading-4",
          )}
          title={title === data.node.label ? data.node.label : `${data.node.label}\n(shown as: ${title})`}
        >
          {title}
        </span>
        {/*
         * The caption line, held open at the badge height whether or not a
         * badge is on it.
         *
         * The status word rides here rather than with the title: a long step
         * name should run out of room before a badge does. Reserving the line
         * is what keeps the card the size ELK measured — a diagnostic, or a run
         * writing `142ms ×12` onto every step, must not make the box taller
         * than the one it was laid out in.
         */}
        {compact ? null : (
          <span className="flex h-[17px] min-w-0 items-center gap-1.5">
            {caption === null ? null : (
              <span
                className={cn(
                  "truncate text-[10.5px] leading-none text-ink-faint",
                  data.mode === "developer" && "font-mono",
                )}
              >
                {caption}
              </span>
            )}
            <StatusBadge diagnostics={data.diagnostics} />
            {badge}
          </span>
        )}
      </span>
      {/* At the beginner level there is no caption to ride with, so the marks
          sit beside the title — where they cost the header no height at all,
          the chip being taller than any of them. */}
      {compact ? (
        <>
          {minor ? (
            <StatusDot diagnostics={data.diagnostics} />
          ) : (
            <StatusBadge diagnostics={data.diagnostics} />
          )}
          {badge}
        </>
      ) : null}
      {before}
      {selected ? <DeleteButton node={data.node} small={minor} /> : null}
    </header>
  );
}

function NodeBody({
  data,
  tight = false,
  custom = null,
}: {
  data: CodeFlowRFNode["data"];
  tight?: boolean;
  /** Host renderer for this node type, when the registry declares one. */
  custom?: ResolvedNodeRenderer | null;
}): ReactNode {
  if (data.mode === "compact") return null;

  /*
   * A host-registered renderer draws the body instead of the summary rows —
   * `NodeDefinition.renderer` (05 §1), resolved through `flow/renderer.ts`.
   *
   * The inner box is exactly the height the renderer declared (the height
   * `measureNode` was told about), and it clips: a card is drawn inside the box
   * ELK was given, so a renderer that overflows loses the overflow rather than
   * pushing the card past its own frame.
   */
  if (custom !== null) {
    const Body = custom.component;
    return (
      <div className={cn("px-3", tight ? "pb-2" : "pb-3")} data-node-renderer="custom">
        <div className="overflow-hidden" style={{ height: custom.height }}>
          <Body node={data.node} mode={data.mode} />
        </div>
      </div>
    );
  }

  // `pb-3` is the card's bottom padding, matched to the header's `pt-3`; `pb-2`
  // is what the body takes when something else (a folded box's summary) is the
  // last block and owes the padding instead.
  const pad = tight ? "pb-2" : "pb-3";

  if (data.mode === "developer") {
    return (
      <pre
        className={cn(
          "m-0 flex flex-col overflow-hidden whitespace-pre px-3 font-mono text-[11px] leading-4 text-ink-dim",
          pad,
        )}
      >
        {developerLines(data.node).map((line, i) => (
          <span key={i}>{line}</span>
        ))}
      </pre>
    );
  }

  const rows = nodeSummaryRows(data.node, data.links);
  if (rows.length === 0) return null;
  return (
    <dl className={cn("m-0 flex flex-col gap-0.5 px-3", pad)}>
      {rows.map((row) => (
        /*
         * A `takes` row is the written form of a data edge the canvas is not
         * drawing — "rows ← Read Text File". It reads a step quieter and a
         * shade smaller than the step's own settings, because it is a fact
         * about somewhere else.
         */
        <div
          className={cn(
            "flex items-baseline gap-2",
            row.kind === "takes" ? "cf-node__takes text-[10.5px] leading-[17px]" : "text-[11.5px] leading-5",
          )}
          key={row.id ?? row.key}
        >
          <dt className="shrink-0 text-ink-faint">{row.key}</dt>
          {/* A value wider than the card is truncated, never wrapped — a row
              that wrapped would be a row the layout did not measure. The full
              text stays one hover away, on every row and not just the
              provenance ones. */}
          <dd className="m-0 min-w-0 flex-1 truncate text-ink-dim" title={row.value}>
            <Value text={row.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Nodes the last patch touched keep a marker until the next one (07 §5). */
function useChangedClass(nodeId: string): string {
  const cf = useOptionalCodeFlow();
  return cf !== null && cf.changedNodeIds.has(nodeId) ? " is-changed" : "";
}

/**
 * How a run marks a node — 09 §1.
 *
 * Four states, and the fourth is the one that keeps the picture honest:
 *
 *  - **running** — the step executing right now. Exactly one node can be in
 *    this state, which is what makes it worth looking at.
 *  - **ran** — finished, with the time it took, and `×n` when a loop put it
 *    through more than once.
 *  - **failed** — threw, or was still open when something inside it threw.
 *  - **untraced** — the runtime said it could not report on this step (an
 *    unbraced body it would have had to rewrite). Dimming it as "not reached"
 *    would be a lie, so it says so instead.
 *
 * A node with no state at all during a run is simply not reached, and is dimmed
 * — the absence is the message.
 */
interface RunMark {
  className: string;
  badge: ReactNode;
}

function useRunMark(nodeId: string): RunMark {
  const cf = useOptionalCodeFlow();
  const run = cf?.run ?? null;
  if (run === null) return { className: "", badge: null };
  // Owns no code, so the run has nothing to say about it either way.
  if (run.tracked !== null && !run.tracked.has(nodeId)) return { className: "", badge: null };

  if (run.untraced.has(nodeId)) {
    return {
      className: " cf-run--untraced",
      badge: (
        <span
          className="cf-run-badge cf-run-badge--untraced"
          title="This step could not be traced without changing what the code does, so the run says nothing about it."
        >
          not traced
        </span>
      ),
    };
  }

  const state = run.nodes.get(nodeId);
  if (state === undefined) {
    return { className: run.status === "running" ? " cf-run--waiting" : " cf-run--missed", badge: null };
  }

  const runs = state.runs > 1 ? <span className="cf-run-badge__count">×{state.runs}</span> : null;

  // The branch itself lives in `run-badge.ts` so it can be tested without a DOM
  // — see that module for why the two "nothing was reported" states exist.
  switch (runBadgeKind(state, nodeId === run.activeNodeId)) {
    case "emitted-only":
    case "reported-nothing": {
      const emitted = (state.emits?.length ?? 0) > 0;
      return {
        className: " cf-run--reported",
        badge: (
          <span
            className="cf-run-badge cf-run-badge--untraced"
            title={
              emitted
                ? "This step sent something while the flow ran, but the run never reported the step itself starting or finishing."
                : "The run mentions this step without saying whether it started or finished."
            }
          >
            {emitted ? "sent output" : "no run reported"}
          </span>
        ),
      };
    }

    case "skipped":
      // The runtime saying it will not report on this step — not that the step
      // did nothing. This used to fall through to the duration badge below and
      // draw as a completed step that took 0ms.
      return {
        className: " cf-run--untraced",
        badge: (
          <span
            className="cf-run-badge cf-run-badge--untraced"
            title="The run said it could not report on this step, which is not the same as the step not running."
          >
            not traced{runs}
          </span>
        ),
      };

    case "running":
      return {
        className: " cf-run--running",
        badge: (
          <span className="cf-run-badge cf-run-badge--running" title="Running now">
            running{runs}
          </span>
        ),
      };

    case "failed":
      return {
        className: " cf-run--failed",
        badge: (
          <span className="cf-run-badge cf-run-badge--failed" title={state.error?.message ?? "This step failed."}>
            failed{runs}
          </span>
        ),
      };

    case "container":
      // Started, not finished, but something deeper is the active step — a
      // container waiting on its own body.
      return {
        className: " cf-run--running cf-run--container",
        badge: (
          <span className="cf-run-badge cf-run-badge--running" title="Waiting on the steps inside it">
            in progress{runs}
          </span>
        ),
      };

    case "ok": {
      const ms = state.runs > 1 ? state.totalMs : state.durationMs ?? state.totalMs;
      return {
        className: " cf-run--ok",
        badge: (
          <span
            className="cf-run-badge cf-run-badge--ok"
            title={state.runs > 1 ? `${String(state.runs)} runs, ${String(ms)}ms in total` : `${String(ms)}ms`}
          >
            {ms < 1 ? "<1ms" : `${String(ms)}ms`}
            {runs}
          </span>
        ),
      };
    }
  }
}

/** Leaf node — every non-container type. */
export function CodeFlowNode({ id, data, selected }: NodeProps<CodeFlowRFNode>): ReactNode {
  const type = data.node.type;
  const changed = useChangedClass(id);
  const { className: runClass } = useRunMark(id);
  const cf = useOptionalCodeFlow();
  const custom = resolveNodeRenderer(cf?.registry, String(type));
  const attention = data.diagnostics.some((diagnostic) => diagnostic.code === "needs-configuration");
  return (
    <div
      className={
        [
          "cf-node",
          `cf-node--${type}`,
          `cf-node--${data.mode}`,
          isMinorNode(data.node, data.mode) ? "is-minor" : "",
          selected === true ? "is-selected" : "",
          attention ? "is-attention" : "",
        ]
          .filter(Boolean)
          .join(" ") + changed + runClass
      }
      data-node-type={type}
    >
      <Handle type="target" position={Position.Top} className="cf-handle" />
      <NodeHeader
        data={data}
        selected={selected === true}
        last={custom === null && !hasNodeBody(data.node, data.mode, data.links)}
      />
      <NodeBody data={data} custom={custom} />
      <Handle type="source" position={Position.Bottom} className="cf-handle" />
    </div>
  );
}

/**
 * Container node — `loop` / `try`. React Flow renders children on top of it, so
 * the body is only a header plus the slot handles the child edges attach to.
 */
export function CodeFlowContainerNode({ id, data, selected, width, height }: NodeProps<CodeFlowRFNode>): ReactNode {
  const type = data.node.type;
  const changed = useChangedClass(id);
  const { className: runClass } = useRunMark(id);
  const cf = useOptionalCodeFlow();
  const inner = cf?.collapse.innerCount.get(id) ?? 0;
  const folded = data.collapsedInner !== null;
  // Pulled out of shape by hand: offer the way back.
  const resized =
    !folded && ((width ?? 0) > data.autoWidth + 1 || (height ?? 0) > data.autoHeight + 1);

  /*
   * Folded, this is a card, not a frame.
   *
   * No resizer and no slot handles: both exist to serve children, and a folded
   * box has none on the canvas. Everything else — the type colour, the run
   * ring, the changed marker, the selection ring — is the same shell, because
   * a folded `for each` is still that `for each` and must look like it.
   */
  if (folded) {
    return (
      <div
        className={
          ["cf-container", "is-collapsed", `cf-container--${type}`, `cf-node--${data.mode}`, selected === true ? "is-selected" : ""]
            .filter(Boolean)
            .join(" ") + changed + runClass
        }
        data-node-type={type}
        data-collapsed="true"
      >
        <Handle type="target" position={Position.Top} className="cf-handle" />
        <NodeHeader
          data={data}
          selected={selected === true}
          before={<FoldButton nodeId={id} inner={data.collapsedInner ?? inner} folded />}
        />
        {/* The summary is the last block here, so the body gives the bottom
            padding back to it. */}
        <NodeBody data={data} tight />
        <FoldedSummary nodeId={id} inner={data.collapsedInner ?? inner} />
        <Handle type="source" position={Position.Bottom} className="cf-handle" />
      </div>
    );
  }

  return (
    <div
      className={
        ["cf-container", `cf-container--${type}`, `cf-node--${data.mode}`, selected === true ? "is-selected" : ""]
          .filter(Boolean)
          .join(" ") + changed + runClass
      }
      data-node-type={type}
    >
      {/*
        A `for` / `while` / `try` can be dragged bigger.

        Layout sizes a container to exactly what fits, which is right for the
        picture as a whole and wrong for the one box someone is trying to read:
        when a branch is crowded, being able to pull the frame open is the
        difference between guessing the structure and seeing it. It can only
        grow — the layout size is the floor, so no drag can ever clip the body —
        and it is as unpersisted as position is (03 §8): the next layout run
        gives the box back its computed size.
      */}
      <NodeResizer
        isVisible={selected === true}
        minWidth={data.autoWidth}
        minHeight={data.autoHeight}
        lineClassName="!border-transparent"
        handleClassName="!size-2.5 !rounded-[3px] !border-2 !border-[color:var(--cf-surface)] !bg-[color:var(--node,var(--cf-accent))]"
      />
      <Handle type="target" position={Position.Top} className="cf-handle" />
      <div className="cf-container__header rounded-t-[calc(var(--radius-node)-1px)]">
        <NodeHeader
          data={data}
          selected={selected === true}
          last={!hasNodeBody(data.node, data.mode, data.links)}
          before={
            <>
              {selected === true && resized ? (
                <FitButton nodeId={id} width={data.autoWidth} height={data.autoHeight} />
              ) : null}
              <FoldButton nodeId={id} inner={inner} folded={false} />
            </>
          }
        />
        <NodeBody data={data} />
      </div>
      {/*
        One source handle per slot, sitting just under the container header, so a
        `body`/`error` edge drops straight into the first child instead of
        looping around the outside of the box.
      */}
      {CONTAINER_SLOTS.map((slot, i) => (
        <Handle
          key={slot}
          id={slotHandleId(slot)}
          type="source"
          position={Position.Bottom}
          className="cf-handle cf-handle--slot"
          style={{ top: 46, bottom: "auto", left: `${String(35 + i * 15)}%` }}
        />
      ))}
      <Handle type="source" position={Position.Bottom} className="cf-handle" />
    </div>
  );
}
