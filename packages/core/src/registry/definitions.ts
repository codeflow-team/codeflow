/** Registry definition types — 05-registry.md §1, §4, §5. */

import type { EditableField, EditableFieldInput } from "../model/editable.js";
import type { NodePatcher, NodeRenderer, SemanticAnalyzer } from "../model/plugin.js";
import type { Schema } from "../model/schema.js";

export interface ToolDefinition {
  /** "github.getFiles" — namespace.method */
  name: string;
  /** "Get PR Files" */
  label: string;
  description?: string;
  icon?: string;

  inputSchema: Schema;
  outputSchema?: Schema;

  editableFields?: EditableFieldInput[];

  /** Override how this call is analyzed. */
  analyzer?: SemanticAnalyzer;
  /** Override how this call is patched. */
  patcher?: NodePatcher;
}

export interface FunctionDefinition {
  /**
   * Unique in the library; MUST be a valid TS identifier (no dots — a namespaced
   * name like "github.getFiles" belongs to a TOOL, not a function).
   */
  name: string;
  label: string;
  description?: string;
  icon?: string;

  /**
   * Named-fields map, e.g. `{ files: "File[]" }` — keys MUST match the parameter
   * names in `code`; this is the bridge between named schema and positional args.
   */
  inputSchema: Schema;
  outputSchema: Schema;

  /**
   * TypeScript source. With the default (file-based) store this IS the content of
   * the file in the workspace `lib/` — the file is the only storage.
   */
  code: string;
  /** MVP: a single module, "@flows/lib". */
  modulePath: string;

  editableFields?: EditableFieldInput[];
}

export interface NodeDefinition {
  /** A new NodeType — the union is open (03 §3). */
  type: string;
  label: string;
  description?: string;
  inputSchema?: Schema;
  outputSchema?: Schema;
  editableFields?: EditableFieldInput[];
  /** Custom React component — registered on the @codeflow-team/react side. */
  renderer?: NodeRenderer;
  analyzer?: SemanticAnalyzer;
  patcher?: NodePatcher;
}

/** Stored form: `editableFields` is always normalized to `EditableField[]`. */
export interface RegisteredTool extends Omit<ToolDefinition, "editableFields"> {
  editableFields: EditableField[];
}

export interface RegisteredFunction extends Omit<FunctionDefinition, "editableFields"> {
  editableFields: EditableField[];
}

export interface RegisteredNode extends Omit<NodeDefinition, "editableFields"> {
  editableFields: EditableField[];
}
