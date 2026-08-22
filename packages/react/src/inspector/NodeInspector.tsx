/**
 * `<NodeInspector>` — the power-user level of progressive disclosure (07 §4).
 *
 * Phase 6a is read-only. Every control renders **disabled** with an explicit
 * reason rather than silently doing nothing: 07 §5 requires the UI to say when
 * an operation is unsupported, never to fail quietly or approximate.
 */

import type { ReactNode } from "react";
import type { WorkflowNode } from "@codeflow/core";
import { useCodeFlow } from "../context/provider.js";
import { nodeIcon, nodeKindLabel } from "../flow/summary.js";
import { resolveInspectorFields, type InspectorField } from "./fields.js";

export interface NodeInspectorProps {
  /** Defaults to the provider's current selection. */
  nodeId?: string | null;
  className?: string;
}

export function NodeInspector(props: NodeInspectorProps): ReactNode {
  const { index, registry, selectedNodeId, nodeDiagnostics, editingDisabledReason, focusRange } = useCodeFlow();
  const nodeId = props.nodeId === undefined ? selectedNodeId : props.nodeId;
  const node = nodeId === null ? null : index.nodeById.get(nodeId) ?? null;

  if (node === null) {
    return (
      <aside className={`cf-inspector ${props.className ?? ""}`}>
        <p className="cf-empty">Select a node to inspect it.</p>
      </aside>
    );
  }

  const model = resolveInspectorFields(node, registry);
  const diagnostics = nodeDiagnostics.get(node.id) ?? [];

  return (
    <aside className={`cf-inspector ${props.className ?? ""}`}>
      <header className="cf-inspector__header">
        <span className="cf-inspector__icon" aria-hidden="true">
          {nodeIcon(node)}
        </span>
        <div>
          <h2 className="cf-inspector__title">{node.label}</h2>
          <p className="cf-inspector__kind">{nodeKindLabel(node)}</p>
        </div>
      </header>

      <button type="button" className="cf-link" onClick={() => { focusRange(node.source); }}>
        {`${node.source.file}:${String(node.source.start.line)}:${String(node.source.start.column)}`}
      </button>

      {diagnostics.length > 0 ? (
        <ul className="cf-inspector__diagnostics">
          {diagnostics.map((diagnostic, i) => (
            <li key={i} className={`cf-diagnostic cf-diagnostic--${diagnostic.severity}`}>
              <code>{diagnostic.code}</code> {diagnostic.message}
            </li>
          ))}
        </ul>
      ) : null}

      {model.notice !== null ? <p className="cf-notice">{model.notice}</p> : null}

      <p className="cf-notice cf-notice--pending" title={editingDisabledReason}>
        Read-only — {editingDisabledReason}.
      </p>

      {model.fields.length > 0 ? (
        <div className="cf-fields">
          {model.fields.map((field) => (
            <FieldRow key={field.name} field={field} disabledReason={editingDisabledReason} />
          ))}
        </div>
      ) : null}

      {model.code !== null ? (
        <pre className="cf-inspector__code">
          <code>{model.code}</code>
        </pre>
      ) : null}

      <PortList title="Inputs" node={node} which="inputs" />
      <PortList title="Outputs" node={node} which="outputs" />

      <details className="cf-inspector__raw">
        <summary>Node data</summary>
        <pre>
          <code>{JSON.stringify({ id: node.id, type: node.type, capabilities: node.capabilities, data: node.data }, null, 2)}</code>
        </pre>
      </details>
    </aside>
  );
}

function FieldRow({ field, disabledReason }: { field: InspectorField; disabledReason: string }): ReactNode {
  const reason = field.blockedReason ?? disabledReason;
  const value = field.missing ? "" : field.display.text;
  const placeholder = field.missing ? "not set — needs configuration" : "";

  return (
    <label className={`cf-field${field.display.friendly ? "" : " cf-field--code"}`}>
      <span className="cf-field__label">
        {field.label}
        {field.schema !== undefined && typeof field.schema === "string" ? (
          <span className="cf-field__schema">{field.schema}</span>
        ) : null}
        {!field.declaredEditable ? <span className="cf-field__tag">not declared editable</span> : null}
        {!field.display.friendly ? <span className="cf-field__tag">code mode</span> : null}
      </span>
      {field.editor === "code" || !field.display.friendly ? (
        <textarea className="cf-input cf-input--code" value={value} placeholder={placeholder} readOnly disabled title={reason} rows={Math.min(6, value.split("\n").length)} />
      ) : (
        <input className="cf-input" type="text" value={value} placeholder={placeholder} readOnly disabled title={reason} />
      )}
      {field.blockedReason !== null ? <span className="cf-field__hint">{field.blockedReason}</span> : null}
    </label>
  );
}

function PortList({ title, node, which }: { title: string; node: WorkflowNode; which: "inputs" | "outputs" }): ReactNode {
  const ports = node[which];
  if (ports.length === 0) return null;
  return (
    <section className="cf-ports">
      <h3 className="cf-ports__title">{title}</h3>
      <ul>
        {ports.map((port) => (
          <li key={port.id}>
            <code>{port.label}</code>
            {typeof port.schema === "string" ? <span className="cf-ports__schema">{port.schema}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
