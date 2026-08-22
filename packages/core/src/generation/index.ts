/** AI generation context and output validation — 10-ai-codegen.md. */

export {
  buildGenerationContext,
  estimateTokens,
  renderSystemPrompt,
  LIB_DTS_PATH,
  TOOLS_DTS_PATH,
} from "./context.js";
export type { RenderSystemPromptOptions } from "./context.js";

export {
  DEFAULT_ALLOWED_VALUE_IMPORTS,
  validateFlowSource,
} from "./validate.js";
export type { FlowValidationResult, ValidateFlowOptions } from "./validate.js";

export { renderDiagnosticsFeedback } from "./feedback.js";
export type { RenderDiagnosticsFeedbackOptions } from "./feedback.js";

export {
  CANONICAL_EXAMPLE,
  FLOW_CONTRACT_PROMPT,
  FLOW_STYLE_PROMPT,
  OUTPUT_FORMAT_PROMPT,
  RESILIENCE_EXAMPLE,
} from "./prompts.js";
