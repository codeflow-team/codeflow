export { analyzeSource, DEFAULT_ANALYZE_FILE } from "./analyze.js";
export type { AnalyzeFlowOptions } from "./analyze.js";
export { checkFlowContract } from "./flow-contract.js";
export type { FlowFunction, FlowContractResult } from "./flow-contract.js";
export { namedFieldsFromTypeNode } from "./type-schema.js";
/** How a call node passes its arguments — `data.argumentStyle` (06 §1). */
export type { ArgumentStyle } from "./emit.js";
export { Scope } from "./context.js";
export type { AnalysisContext, Exit, Frame, FlowBinding, TerminalSink } from "./context.js";
