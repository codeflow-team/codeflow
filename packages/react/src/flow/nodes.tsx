/**
 * Custom React Flow nodes — 07-ui.md §3 (compact / expanded / developer) and
 * §5 (code and unknown nodes must look visibly different; diagnostics show as a
 * badge on the node they belong to).
 */

import type { ReactNode } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Diagnostic, WorkflowNode } from "@codeflow/core";
import { CONTAINER_SLOTS, worstSeverity } from "../graph/index.js";
import { useOptionalCodeFlow } from "../context/hooks.js";
import { developerLines, nodeIcon, nodeKindLabel, nodeSummaryRows } from "./summary.js";
import { slotHandleId, type CodeFlowRFNode } from "./to-react-flow.js";

function DiagnosticBadge({ diagnostics }: { diagnostics: Diagnostic[] }): ReactNode {
  const severity = worstSeverity(diagnostics);
  if (severity === null) return null;
  const glyph = severity === "error" ? "!" : severity === "warning" ? "!" : "i";
  const title = diagnostics.map((d) => `${d.severity}: ${d.code} — ${d.message}`).join("\n");
  return (
    <span className={`cf-badge cf-badge--${severity}`} title={title} aria-label={`${String(diagnostics.length)} ${severity}`}>
      {glyph}
      {diagnostics.length > 1 ? <span className="cf-badge__count">{diagnostics.length}</span> : null}
    </span>
  );
}

function NodeBody({ data }: { data: CodeFlowRFNode["data"] }): ReactNode {
  if (data.mode === "compact") return null;

  if (data.mode === "developer") {
    return (
      <pre className="cf-node__code">
        {developerLines(data.node).map((line, i) => (
          <span className="cf-node__code-line" key={i}>
            {line}
          </span>
        ))}
      </pre>
    );
  }

  const rows = nodeSummaryRows(data.node);
  if (rows.length === 0) return null;
  return (
    <dl className="cf-node__rows">
      {rows.map((row) => (
        <div className="cf-node__row" key={row.key}>
          <dt className="cf-node__row-key">{row.key}</dt>
          <dd className="cf-node__row-value">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function NodeHeader({ data, selected }: { data: CodeFlowRFNode["data"]; selected: boolean }): ReactNode {
  return (
    <header className="cf-node__header">
      <span className="cf-node__icon" aria-hidden="true">
        {nodeIcon(data.node)}
      </span>
      <span className="cf-node__label" title={data.node.label}>
        {data.node.label}
      </span>
      {data.mode !== "compact" ? <span className="cf-node__kind">{nodeKindLabel(data.node)}</span> : null}
      <DiagnosticBadge diagnostics={data.diagnostics} />
      {selected ? <DeleteButton node={data.node} /> : null}
    </header>
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
      className="cf-node__delete"
      title={`Delete “${node.label}”`}
      aria-label={`Delete ${node.label}`}
      data-testid={`node-delete-${node.id}`}
      onClick={(event) => {
        event.stopPropagation();
        void cf.patchNode(node.id, { $delete: true });
      }}
    >
      ×
    </button>
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
  return (
    <div
      className={[
        "cf-node",
        `cf-node--${type}`,
        `cf-node--${data.mode}`,
        selected === true ? "is-selected" : "",
      ]
        .filter(Boolean)
        .join(" ") + changed}
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
export function CodeFlowContainerNode({ id, data, selected }: NodeProps<CodeFlowRFNode>): ReactNode {
  const type = data.node.type;
  const changed = useChangedClass(id);
  return (
    <div
      className={[
        "cf-container",
        `cf-container--${type}`,
        `cf-node--${data.mode}`,
        selected === true ? "is-selected" : "",
      ]
        .filter(Boolean)
        .join(" ") + changed}
      data-node-type={type}
    >
      <Handle type="target" position={Position.Top} className="cf-handle" />
      <div className="cf-container__header">
        <NodeHeader data={data} selected={selected === true} />
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
          style={{ top: 42, bottom: "auto", left: `${String(35 + i * 15)}%` }}
        />
      ))}
      <Handle type="source" position={Position.Bottom} className="cf-handle" />
    </div>
  );
}
