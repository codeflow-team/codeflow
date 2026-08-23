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
import { Shrink, Trash2 } from "lucide-react";
import type { Diagnostic, WorkflowNode } from "@codeflow/core";
import { CONTAINER_SLOTS, worstSeverity } from "../graph/index.js";
import { useOptionalCodeFlow } from "../context/hooks.js";
import { cn } from "../ui/cn.js";
import { NodeGlyph } from "./glyphs.js";
import { developerLines, nodeCaption, nodeSummaryRows } from "./summary.js";
import { slotHandleId, type CodeFlowRFNode } from "./to-react-flow.js";

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

function StatusBadge({ diagnostics }: { diagnostics: Diagnostic[] }): ReactNode {
  const severity = worstSeverity(diagnostics);
  if (severity === null) return null;

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
function DeleteButton({ node }: { node: WorkflowNode }): ReactNode {
  const cf = useOptionalCodeFlow();
  if (cf === null || !cf.editingEnabled || !node.capabilities.deletable) return null;
  return (
    <button
      type="button"
      title={`Delete “${node.label}”`}
      aria-label={`Delete ${node.label}`}
      data-testid={`node-delete-${node.id}`}
      className={cn(
        "ml-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0",
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

function NodeHeader({
  data,
  selected,
  before,
}: {
  data: CodeFlowRFNode["data"];
  selected: boolean;
  /** Extra affordance shown left of the delete button (container "fit"). */
  before?: ReactNode;
}): ReactNode {
  const caption = nodeCaption(data.node, data.mode);
  const compact = data.mode === "compact";
  return (
    <header className={cn("flex items-center gap-2.5 px-3", compact ? "py-2.5" : "pb-2 pt-3")}>
      <span className="cf-node__chip">
        <NodeGlyph node={data.node} className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-semibold leading-tight tracking-[-0.005em] text-ink" title={data.node.label}>
          {data.node.label}
        </span>
        {/* The status word rides with the caption rather than the title: a long
            step name should run out of room before a badge does. */}
        {caption === null && data.diagnostics.length === 0 ? null : (
          <span className="flex min-w-0 items-center gap-1.5">
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
          </span>
        )}
      </span>
      {before}
      {selected ? <DeleteButton node={data.node} /> : null}
    </header>
  );
}

function NodeBody({ data }: { data: CodeFlowRFNode["data"] }): ReactNode {
  if (data.mode === "compact") return null;

  if (data.mode === "developer") {
    return (
      <pre className="m-0 flex flex-col overflow-hidden whitespace-pre px-3 pb-2.5 font-mono text-[11px] leading-4 text-ink-dim">
        {developerLines(data.node).map((line, i) => (
          <span key={i}>{line}</span>
        ))}
      </pre>
    );
  }

  const rows = nodeSummaryRows(data.node);
  if (rows.length === 0) return null;
  return (
    <dl className="m-0 flex flex-col gap-0.5 px-3 pb-2.5">
      {rows.map((row) => (
        <div className="flex items-baseline gap-2 text-[11.5px] leading-5" key={row.key}>
          <dt className="shrink-0 text-ink-faint">{row.key}</dt>
          <dd className="m-0 min-w-0 flex-1 truncate text-ink-dim">
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

/** Leaf node — every non-container type. */
export function CodeFlowNode({ id, data, selected }: NodeProps<CodeFlowRFNode>): ReactNode {
  const type = data.node.type;
  const changed = useChangedClass(id);
  const attention = data.diagnostics.some((diagnostic) => diagnostic.code === "needs-configuration");
  return (
    <div
      className={
        ["cf-node", `cf-node--${type}`, `cf-node--${data.mode}`, selected === true ? "is-selected" : "", attention ? "is-attention" : ""]
          .filter(Boolean)
          .join(" ") + changed
      }
      data-node-type={type}
    >
      <Handle type="target" position={Position.Top} className="cf-handle" />
      <NodeHeader data={data} selected={selected === true} />
      <NodeBody data={data} />
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
  // Pulled out of shape by hand: offer the way back.
  const resized = (width ?? 0) > data.autoWidth + 1 || (height ?? 0) > data.autoHeight + 1;
  return (
    <div
      className={
        ["cf-container", `cf-container--${type}`, `cf-node--${data.mode}`, selected === true ? "is-selected" : ""]
          .filter(Boolean)
          .join(" ") + changed
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
          before={
            selected === true && resized ? (
              <FitButton nodeId={id} width={data.autoWidth} height={data.autoHeight} />
            ) : null
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
