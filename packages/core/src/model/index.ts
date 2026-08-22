export type {
  SourcePosition,
  SourceDocument,
  SourceMapping,
  TextChange,
  TextPatch,
} from "./source.js";

export type { JsonSchema, TsTypeRef, NamedFieldsSchema, Schema } from "./schema.js";
export { isTsTypeRef, isJsonSchema, isNamedFieldsSchema } from "./schema.js";

export type { Diagnostic, DiagnosticSeverity } from "./diagnostic.js";

export type {
  CoreNodeType,
  NodeType,
  NodePort,
  NodeCapabilities,
  WorkflowNode,
  EdgeKind,
  WorkflowEdge,
  WorkflowGraph,
  GraphChange,
} from "./graph.js";

export type { TriggerMetadata, AnalyzeOptions } from "./trigger.js";

export type { EditableField, EditableFieldEditor, EditableFieldInput } from "./editable.js";

export type {
  AstNode,
  Binding,
  BindingKind,
  AnalyzeContext,
  PatchContext,
  SemanticAnalyzer,
  NodePatcher,
  NodeRenderer,
} from "./plugin.js";

export type { SyntaxTree, Parser } from "./parser.js";

export type { PatchResult } from "./patch.js";

export type {
  FunctionLibraryStore,
  SaveFunctionOptions,
  RemoveFunctionOptions,
} from "./library.js";

export type {
  GeneratedFile,
  PromptSection,
  GenerationContext,
  BuildGenerationContextOptions,
  ConformanceLevel,
  ValidationResult,
} from "./generation.js";
